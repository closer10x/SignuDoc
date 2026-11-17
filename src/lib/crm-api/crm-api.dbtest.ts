import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "../electronic-records-disclosure.ts";
import { listEnvelopesForUser } from "../envelopes.ts";
import { verifyAuditChain } from "../services/audit.ts";
import {
  getSigningPayloadForToken,
  recordSignerConsent,
  submitSigningForToken,
} from "../signing.ts";
import { invalidateSettingsCache } from "../settings.ts";
import { CrmApiError } from "./errors.ts";
import {
  completedFileResponse,
  createEnvelopeFromApi,
  envelopeIsOnDashboard,
  getEnvelopeForApi,
  remindEnvelopeFromApi,
  voidEnvelopeFromApi,
} from "./service.ts";
import { webhookSignatureIsValid } from "./signature.ts";

// Creates an envelope through the CRM API, signs it the way the signing page
// does, and checks the sealed PDF plus the signed webhook. Run with
// `npm run test:db`.

const API_KEY = "crm-api-test-key-0123456789abcdef";
const WEBHOOK_SECRET = "crm-webhook-test-secret-0123456789abcdef";
const DRAWN_SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const ENV_KEYS = [
  "APP_URL",
  "BETTER_AUTH_SECRET",
  "DATABASE_URL",
  "EMAIL_CAPTURE_DIR",
  "EMAIL_DRIVER",
  "SIGNUDOC_API_KEY",
  "SIGNUDOC_WEBHOOK_SECRET",
  "STORAGE_DRIVER",
  "STORAGE_LOCAL_DIR",
] as const;

let database: pg.Pool;
let previousPool: pg.Pool | null = null;
let previousEnv: Record<string, string | undefined> = {};
let storageDir = "";
let ownerId = "";
let previousPart11: boolean | null = null;
let webhook: {
  close: () => Promise<void>;
  events: { body: string; signature: string | null }[];
  url: string;
};

before(async () => {
  database = await openTestDatabase();
  previousPool = replaceDbPoolForTests(database);
  previousEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-crm-api-"));
  Object.assign(process.env, {
    APP_URL: "http://127.0.0.1:3000",
    BETTER_AUTH_SECRET: "crm-api-test-secret-that-is-long-enough-0123456789",
    DATABASE_URL:
      process.env.E2E_DATABASE_URL ??
      "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e",
    EMAIL_CAPTURE_DIR: path.join(storageDir, "outbox"),
    EMAIL_DRIVER: "capture",
    SIGNUDOC_API_KEY: API_KEY,
    SIGNUDOC_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: path.join(storageDir, "storage"),
  });
  invalidateSettingsCache();

  const part11 = await database.query<{ part11_mode: boolean }>(
    `select part11_mode from app_settings where id`,
  );

  previousPart11 = part11.rows[0]?.part11_mode ?? null;

  if (previousPart11 !== null) {
    await database.query(
      `update app_settings set part11_mode = false where id`,
    );
  }

  ownerId = randomUUID();
  await database.query(
    `
      insert into public."user" (id, name, email, "emailVerified", role, "createdAt")
      values ($1, 'API Owner', $2, true, 'admin', '1960-01-01')
    `,
    [ownerId, `api-owner+${ownerId}@example.test`],
  );
  webhook = await listenForWebhooks();
});

after(async () => {
  await webhook?.close().catch(() => undefined);

  if (ownerId) {
    await database
      .query(`delete from public."user" where id = $1`, [ownerId])
      .catch(() => undefined);
  }

  if (previousPart11 !== null) {
    await database
      .query(`update app_settings set part11_mode = $1 where id`, [
        previousPart11,
      ])
      .catch(() => undefined);
  }

  for (const key of ENV_KEYS) {
    const previous = previousEnv[key];

    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }

  invalidateSettingsCache();
  replaceDbPoolForTests(previousPool);

  if (storageDir) {
    await rm(storageDir, { force: true, recursive: true });
  }

  await database?.end();
});

function listenForWebhooks(): Promise<{
  close: () => Promise<void>;
  events: { body: string; signature: string | null }[];
  url: string;
}> {
  const events: { body: string; signature: string | null }[] = [];

  return new Promise((resolve) => {
    const server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];

        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          events.push({
            body: Buffer.concat(chunks).toString("utf8"),
            signature:
              request.headers["x-signudoc-signature"]?.toString() ?? null,
          });
          response.writeHead(200);
          response.end("ok");
        });
      },
    );

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      resolve({
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
        events,
        url: `http://127.0.0.1:${String(port)}/hooks`,
      });
    });
  });
}

async function onePagePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();

  document.addPage([612, 792]);

  return document.save();
}

async function waitForWebhook(envelopeId: string, event: string) {
  const deadline = Date.now() + 20_000;

  for (;;) {
    const found = webhook.events.find((entry) => {
      const payload = JSON.parse(entry.body) as {
        envelopeId?: string;
        event?: string;
      };

      return payload.envelopeId === envelopeId && payload.event === event;
    });

    if (found) {
      return found;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `No "${event}" webhook for ${envelopeId}. Saw ${webhook.events.map((entry) => entry.body).join(" | ")}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("an API envelope is signed, sealed, and reported to its callback", async () => {
  const signerEmail = `riley+${ownerId}@example.test`;
  const created = await createEnvelopeFromApi(
    {
      callbackUrl: webhook.url,
      cc: [],
      externalId: `lead-${ownerId}`,
      fields: null,
      filename: "application.pdf",
      message: "Please sign the application.",
      pdf: await onePagePdf(),
      send: true,
      signers: [{ email: signerEmail, name: "Riley Signer", order: 1 }],
      title: "Fleet application",
    },
    { ipAddress: "127.0.0.1", userAgent: "crm-api-test" },
    database,
  );

  assert.equal(created.status, "sent");
  assert.equal(created.externalId, `lead-${ownerId}`);
  assert.match(created.dashboardUrl, new RegExp(`/envelopes/${created.id}$`));
  assert.equal(created.signingUrls.length, 1);
  assert.match(created.signingUrls[0]?.url ?? "", /\/sign\//);

  const owner = await database.query<{ id: string }>(
    `
      select id from public."user"
      where role = 'admin'
      order by "createdAt" asc, id asc
      limit 1
    `,
  );

  assert.equal(owner.rows[0]?.id, ownerId);
  assert.equal(
    await envelopeIsOnDashboard(ownerId, created.id, database),
    true,
  );
  assert.ok(
    (await listEnvelopesForUser(ownerId, {}, database)).some(
      (item) => item.id === created.id && item.title === "Fleet application",
    ),
  );

  await assert.rejects(
    () => completedFileResponse(created.id, "signed", database),
    (error: unknown) =>
      error instanceof CrmApiError && error.statusCode === 404,
  );

  const token = new URL(created.signingUrls[0]?.url ?? "").pathname
    .split("/")
    .at(-1);

  assert.ok(token);
  await getSigningPayloadForToken(token, { database });
  await recordSignerConsent(
    token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );

  const fields = await database.query<{ id: string; type: string }>(
    `select id, type from fields where envelope_id = $1`,
    [created.id],
  );
  const signature = fields.rows.find((field) => field.type === "signature");

  assert.ok(signature);
  assert.ok(fields.rows.some((field) => field.type === "date"));

  await submitSigningForToken(
    token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          fieldId: signature.id,
          imageDataUrl: DRAWN_SIGNATURE,
          inputMethod: "drawn",
          type: "signature",
        },
      ],
    },
    { database },
  );

  const completed = await getEnvelopeForApi(created.id, database);

  assert.equal(completed.status, "completed");
  assert.equal(completed.externalId, `lead-${ownerId}`);
  assert.equal(completed.signers[0]?.status, "signed");
  assert.equal(completed.signers[0]?.email, signerEmail);
  assert.ok(completed.signers[0]?.signedAt);
  assert.ok(completed.signers[0]?.viewedAt);
  assert.equal((await verifyAuditChain(created.id, database)).ok, true);

  for (const kind of ["signed", "certificate"] as const) {
    const response = await completedFileResponse(created.id, kind, database);
    const bytes = new Uint8Array(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), "%PDF-");
  }

  const outbox = await readdir(path.join(storageDir, "outbox"));
  const invitation = (
    await Promise.all(
      outbox.map(
        async (name) =>
          JSON.parse(
            await readFile(path.join(storageDir, "outbox", name), "utf8"),
          ) as {
            template?: string;
            text?: string;
          },
      ),
    )
  ).find((message) => message.template === "signing_invitation");

  assert.match(invitation?.text ?? "", /Please sign the application\./);

  for (const event of ["sent", "viewed", "signed", "completed"] as const) {
    const delivery = await waitForWebhook(created.id, event);
    const payload = JSON.parse(delivery.body) as {
      envelopeId: string;
      event: string;
      externalId: string;
      occurredAt: string;
      status: string;
    };

    assert.equal(
      webhookSignatureIsValid(
        delivery.signature,
        delivery.body,
        WEBHOOK_SECRET,
      ),
      true,
    );
    assert.equal(payload.externalId, `lead-${ownerId}`);
    assert.equal(payload.envelopeId, created.id);
    assert.match(payload.occurredAt, /^\d{4}-\d{2}-\d{2}T/);

    if (event === "completed") {
      assert.equal(payload.status, "completed");
    }
  }

  const loggedAt = Date.now() + 10_000;
  let loggedStatus = "";

  for (;;) {
    const logged = await database.query<{ status: string }>(
      `
        select status from webhook_deliveries
        where envelope_id = $1 and event = 'completed'
      `,
      [created.id],
    );

    loggedStatus = logged.rows[0]?.status ?? "";

    if (loggedStatus === "delivered" || Date.now() > loggedAt) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(loggedStatus, "delivered");

  const other = await createEnvelopeFromApi(
    {
      callbackUrl: webhook.url,
      cc: [],
      externalId: `lead-${ownerId}-void`,
      fields: null,
      filename: "void-me.pdf",
      message: null,
      pdf: await onePagePdf(),
      send: true,
      signers: [
        { email: `casey+${ownerId}@example.test`, name: "Casey", order: 1 },
      ],
      title: "Void me",
    },
    { ipAddress: null, userAgent: null },
    database,
  );
  const reminder = await remindEnvelopeFromApi(
    other.id,
    { ipAddress: null, userAgent: null },
    database,
  );

  assert.equal(reminder.signer.name, "Casey");
  assert.match(reminder.signer.email, /casey/);

  const voided = await voidEnvelopeFromApi(
    other.id,
    "Replaced",
    { ipAddress: null, userAgent: null },
    database,
  );

  assert.equal(voided.status, "voided");
  assert.equal((await getEnvelopeForApi(other.id, database)).status, "voided");

  const voidDelivery = await waitForWebhook(other.id, "voided");

  assert.equal(
    webhookSignatureIsValid(
      voidDelivery.signature,
      voidDelivery.body,
      WEBHOOK_SECRET,
    ),
    true,
  );
  assert.equal(
    webhook.events.some((entry) =>
      entry.body.includes('"event":"reminded_manual"'),
    ),
    false,
  );
});
