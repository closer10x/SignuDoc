import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import pg from "pg";

import {
  e2eCrmApiKey,
  e2eCrmWebhookSecret,
  e2eDatabaseUrl,
  e2eSetupToken,
} from "../playwright.config";
import { waitForEmail } from "./support/outbox";

// Runs after the other end-to-end tests. Those claim a fresh install, so this
// one uses the administrator they created (or sets the site up if it is run
// on its own).

const PASSWORD = "correct horse battery staple 42";

type WebhookEvent = { body: string; signature: string | null };

function signatureIsValid(body: string, header: string | null): boolean {
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", e2eCrmWebhookSecret).update(body).digest("hex")}`,
  );
  const actual = Buffer.from(header ?? "");

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function listenForWebhooks(): Promise<{
  close: () => Promise<void>;
  events: WebhookEvent[];
  url: string;
}> {
  const events: WebhookEvent[] = [];

  return new Promise((resolve) => {
    const server = createServer((request, response) => {
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
    });

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

async function onePagePdf(): Promise<Buffer> {
  const document = await PDFDocument.create();

  document.addPage([612, 792]);

  return Buffer.from(await document.save());
}

test("the CRM API sends a document and the signer signs it on the signing page", async ({
  baseURL,
  browser,
  page,
  request,
}) => {
  const runId = String(Date.now());
  const title = `CRM application ${runId}`;
  const signerEmail = `crm-signer+${runId}@example.com`;
  const message = `Please sign application ${runId}.`;
  const externalId = `lead-${runId}`;
  const database = new pg.Client({ connectionString: e2eDatabaseUrl });
  const hooks = await listenForWebhooks();

  await database.connect();

  try {
    await test.step("the API refuses a caller without the key", async () => {
      const refused = await request.post("/api/v1/envelopes", {
        data: {},
      });

      expect(refused.status()).toBe(401);
    });

    const adminEmail =
      await test.step("sign in as the administrator", async () =>
        signInAsAdministrator({ baseURL, database, page, request, runId }));

    const created = await test.step("create the envelope", async () => {
      const response = await request.post("/api/v1/envelopes", {
        headers: { authorization: `Bearer ${e2eCrmApiKey}` },
        multipart: {
          callbackUrl: hooks.url,
          externalId,
          file: {
            buffer: await onePagePdf(),
            mimeType: "application/pdf",
            name: "application.pdf",
          },
          message,
          send: "true",
          signers: JSON.stringify([
            { email: signerEmail, name: "Riley Signer", order: 1 },
          ]),
          title,
        },
      });

      expect(response.status()).toBe(201);

      return (await response.json()) as {
        dashboardUrl: string;
        id: string;
        signingUrls: { url: string | null }[];
        status: string;
      };
    });

    expect(created.status).toBe("sent");
    expect(created.signingUrls[0]?.url).toContain("/sign/");

    const tooEarly = await request.get(
      `/api/v1/envelopes/${created.id}/signed-pdf`,
      { headers: { authorization: `Bearer ${e2eCrmApiKey}` } },
    );

    expect(tooEarly.status()).toBe(404);

    await page.goto("/dashboard");
    await expect(page.getByText(title)).toBeVisible();

    const invitation = await waitForEmail({
      template: "signing_invitation",
      to: signerEmail,
    });

    expect(invitation.text).toContain(message);
    expect(invitation.text).toContain(created.signingUrls[0]?.url ?? "");

    await test.step("the signer signs on the signing page", async () => {
      const signerContext = await browser.newContext({
        viewport: { height: 900, width: 1440 },
      });
      const signerPage = await signerContext.newPage();

      await signerPage.goto(created.signingUrls[0]?.url ?? "");

      const consent = signerPage.getByRole("dialog", {
        name: "Before you sign",
      });

      await expect(
        consent.getByRole("button", { name: "Agree and continue" }),
      ).toBeDisabled();
      await consent
        .getByRole("checkbox", {
          name: "I agree to use electronic records and signatures",
        })
        .check();
      await consent.getByRole("button", { name: "Agree and continue" }).click();
      await expect(consent).toBeHidden();
      await expect(
        signerPage.getByRole("img", { name: "Rendered PDF page 1" }),
      ).toBeVisible();
      await signerPage
        .getByRole("button", { exact: true, name: "Signature" })
        .click();
      await signerPage
        .getByRole("dialog", { name: "Add your signature" })
        .getByRole("button", { name: "Apply signature" })
        .click();
      await signerPage.getByRole("button", { name: "Finish" }).click();
      await signerPage
        .getByRole("dialog", { name: "Finish signing?" })
        .getByRole("button", { name: "Finish signing" })
        .click();
      await expect(signerPage).toHaveURL(/\/sign\/[^/]+\/done/);
      await signerContext.close();
    });

    await expect
      .poll(() =>
        hooks.events.some((event) => {
          const payload = JSON.parse(event.body) as { event?: string };

          return payload.event === "completed";
        }),
      )
      .toBe(true);

    const completedEvent = hooks.events.find((event) =>
      event.body.includes('"event":"completed"'),
    );

    expect(completedEvent).toBeDefined();
    expect(
      signatureIsValid(
        completedEvent?.body ?? "",
        completedEvent?.signature ?? null,
      ),
    ).toBe(true);
    expect(JSON.parse(completedEvent?.body ?? "{}")).toMatchObject({
      envelopeId: created.id,
      event: "completed",
      externalId,
      status: "completed",
    });
    expect(hooks.events.map((event) => JSON.parse(event.body).event)).toEqual(
      expect.arrayContaining(["sent", "viewed", "signed", "completed"]),
    );

    const status = await request.get(`/api/v1/envelopes/${created.id}`, {
      headers: { authorization: `Bearer ${e2eCrmApiKey}` },
    });

    expect(status.status()).toBe(200);
    expect(await status.json()).toMatchObject({
      externalId,
      id: created.id,
      status: "completed",
      signers: [{ email: signerEmail, status: "signed" }],
    });

    for (const path of ["signed-pdf", "certificate"] as const) {
      const download = await request.get(
        `/api/v1/envelopes/${created.id}/${path}`,
        { headers: { authorization: `Bearer ${e2eCrmApiKey}` } },
      );

      expect(download.status()).toBe(200);
      expect(download.headers()["content-type"]).toContain("application/pdf");
      expect((await download.body()).subarray(0, 5).toString()).toBe("%PDF-");
    }

    await page.goto(`/envelopes/${created.id}`);
    await expect(page.getByText("Completed", { exact: true })).toBeVisible();
    expect(adminEmail).toContain("@");
  } finally {
    await hooks.close();
    await database.end();
  }
});

async function signInAsAdministrator({
  baseURL,
  database,
  page,
  request,
  runId,
}: {
  baseURL: string | undefined;
  database: pg.Client;
  page: Page;
  request: APIRequestContext;
  runId: string;
}): Promise<string> {
  const existing = await database.query<{ email: string }>(
    `
      select email from public."user"
      where role = 'admin'
      order by "createdAt" asc, id asc
      limit 1
    `,
  );
  let adminEmail = existing.rows[0]?.email;

  if (!adminEmail) {
    adminEmail = `crm-admin+${runId}@example.com`;

    const setup = await request.post("/api/setup", {
      data: {
        email: adminEmail,
        fullName: "Ada Admin",
        organizationName: "Harbour Test",
        password: PASSWORD,
        setupToken: e2eSetupToken,
        supportAddress: `help+${runId}@example.com`,
      },
      headers: { origin: baseURL ?? "http://127.0.0.1" },
    });

    expect(setup.status()).toBe(201);
  }

  await database.query(
    `update public."user" set "twoFactorEnabled" = false where role = 'admin'`,
  );
  await database.query(`delete from public."twoFactor"`);

  await page.goto("/login");
  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  return adminEmail;
}
