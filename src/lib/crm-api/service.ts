import { type DbPool, getDb, queryMany, queryOne } from "../db/connection.ts";
import { createDownloadResponse } from "../download-response.ts";
import {
  getSenderEnvelopeDownload,
  type EnvelopeDownloadResult,
} from "../downloads.ts";
import {
  createDraftEnvelope,
  deleteDraftEnvelope,
  listCopyRecipientsForEnvelopeId,
  listEnvelopesForUser,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
  voidSentEnvelope,
} from "../envelopes.ts";
import { sendManualEnvelopeNudge } from "../reminders.ts";
import { resolveAppUrl } from "../utils/env.ts";
import { CrmApiError } from "./errors.ts";
import { autoPlaceSignerFields, normalizeFieldRect } from "./fields.ts";
import { type CreateEnvelopeCommand } from "./request.ts";
import { publicEnvelopeStatus, unixToIso } from "./status.ts";

export type CrmRequestMeta = {
  ipAddress: string | null;
  userAgent: string | null;
};

type EnvelopeActor = {
  email: string;
  name: string;
  userId: string;
};

type EnvelopeRow = {
  completedAt: number | null;
  declinedAt: number | null;
  expiresAt: number | null;
  externalId: string | null;
  id: string;
  sentAt: number | null;
  status: string;
  title: string;
  voidedAt: number | null;
};

type SignerRow = {
  declinedAt: number | null;
  email: string;
  id: string;
  name: string;
  notifiedAt: number | null;
  order: number;
  signedAt: number | null;
  status: string;
};

export type ApiSignerStatus = {
  declinedAt: string | null;
  email: string;
  id: string;
  name: string;
  notifiedAt: string | null;
  order: number;
  signedAt: string | null;
  status: string;
  viewedAt: string | null;
};

export type ApiEnvelope = {
  cc: { email: string; name: string }[];
  completedAt: string | null;
  declinedAt: string | null;
  expiresAt: string | null;
  externalId: string | null;
  id: string;
  sentAt: string | null;
  signers: ApiSignerStatus[];
  status: string;
  title: string;
  voidedAt: string | null;
};

export type CreatedEnvelope = {
  dashboardUrl: string;
  externalId: string | null;
  id: string;
  signingUrls: {
    email: string;
    name: string;
    order: number;
    url: string | null;
  }[];
  status: "draft" | "sent";
};

async function requireApiOwner(database: DbPool): Promise<EnvelopeActor> {
  const owner = await queryOne<EnvelopeActor>(
    database,
    `
      SELECT id AS "userId", name, email
      FROM "user"
      WHERE role = 'admin'
      ORDER BY "createdAt" ASC, id ASC
      LIMIT 1
    `,
  );

  if (!owner) {
    throw new CrmApiError(
      "Set up this site before using the API. Envelopes are kept on the administrator's account.",
      409,
    );
  }

  return owner;
}

async function requireEnvelopeActor(
  envelopeId: string,
  database: DbPool,
): Promise<EnvelopeActor> {
  const actor = await queryOne<EnvelopeActor>(
    database,
    `
      SELECT e.user_id AS "userId", u.name, u.email
      FROM envelopes e
      JOIN "user" u ON u.id = e.user_id
      WHERE e.id = $1
    `,
    [envelopeId],
  );

  if (!actor) {
    throw new CrmApiError("Envelope not found.", 404);
  }

  return actor;
}

function dashboardUrl(envelopeId: string): string {
  const appUrl = resolveAppUrl();

  if (!appUrl) {
    throw new CrmApiError("APP_URL is not configured.", 500);
  }

  return new URL(`/envelopes/${envelopeId}`, appUrl).toString();
}

function senderName(actor: EnvelopeActor): string {
  return actor.name.trim() || actor.email;
}

export async function createEnvelopeFromApi(
  input: CreateEnvelopeCommand,
  meta: CrmRequestMeta,
  database: DbPool = getDb(),
): Promise<CreatedEnvelope> {
  const owner = await requireApiOwner(database);
  let envelopeId: string | null = null;
  let sent = false;

  try {
    const draft = await createDraftEnvelope(
      owner.userId,
      {
        sourcePdf: {
          body: input.pdf,
          contentType: "application/pdf",
          filename: input.filename,
        },
        title: input.title,
      },
      { database },
    );

    envelopeId = draft.envelope.id;

    const savedSigners = await replaceDraftEnvelopeSigners(
      owner.userId,
      envelopeId,
      {
        copyRecipients: input.cc,
        signers: [...input.signers]
          .sort((left, right) => left.order - right.order)
          .map((signer) => ({ email: signer.email, name: signer.name })),
      },
      database,
    );
    const signerIdByEmail = new Map(
      savedSigners.signers.map(
        (signer) => [signer.email.toLowerCase(), signer.id] as const,
      ),
    );
    const pageByNumber = new Map(
      draft.pages.map((page) => [page.pageNumber, page] as const),
    );
    const fields = input.fields
      ? input.fields.map((field) => {
          const email = input.signers[field.signerIndex]?.email;
          const signerId = email
            ? signerIdByEmail.get(email.toLowerCase())
            : undefined;
          const page = pageByNumber.get(field.page);

          if (!signerId) {
            throw new CrmApiError("signerIndex does not match a signer.", 400);
          }

          if (!page) {
            throw new CrmApiError(
              `Page ${String(field.page)} is not in this document.`,
              400,
            );
          }

          const rect = normalizeFieldRect(field, page);

          return {
            height: rect.height,
            page: field.page,
            required: field.required,
            signerId,
            type: field.type,
            width: rect.width,
            x: rect.x,
            y: rect.y,
          };
        })
      : autoPlaceSignerFields(savedSigners.signers, draft.envelope.pageCount);

    await replaceDraftEnvelopeFields(
      owner.userId,
      envelopeId,
      { fields },
      database,
    );
    await database.query(
      `
        UPDATE envelopes
        SET external_id = $2, callback_url = $3, message = $4, updated_at = $5
        WHERE id = $1
      `,
      [
        envelopeId,
        input.externalId,
        input.callbackUrl,
        input.message,
        Math.floor(Date.now() / 1000),
      ],
    );

    let signingUrl: string | null = null;
    let status: "draft" | "sent" = "draft";

    if (input.send) {
      const sentResult = await sendDraftEnvelope(
        owner.userId,
        envelopeId,
        {
          ipAddress: meta.ipAddress,
          message: input.message,
          senderEmail: owner.email,
          senderName: senderName(owner),
          userAgent: meta.userAgent,
        },
        { database },
      );

      sent = true;
      signingUrl = sentResult.signingUrl;
      status = "sent";
    }

    const activeOrder = Math.min(
      ...savedSigners.signers.map((signer) => signer.signOrder),
    );

    return {
      dashboardUrl: dashboardUrl(envelopeId),
      externalId: input.externalId,
      id: envelopeId,
      signingUrls: savedSigners.signers.map((signer) => ({
        email: signer.email,
        name: signer.name,
        order: signer.signOrder,
        url: signingUrl && signer.signOrder === activeOrder ? signingUrl : null,
      })),
      status,
    };
  } catch (error) {
    if (envelopeId && !sent) {
      await deleteDraftEnvelope(owner.userId, envelopeId, { database }).catch(
        () => undefined,
      );
    }

    throw error;
  }
}

export async function getEnvelopeForApi(
  envelopeId: string,
  database: DbPool = getDb(),
): Promise<ApiEnvelope> {
  const envelope = await queryOne<EnvelopeRow>(
    database,
    `
      SELECT
        id,
        title,
        status,
        external_id AS "externalId",
        sent_at AS "sentAt",
        completed_at AS "completedAt",
        declined_at AS "declinedAt",
        voided_at AS "voidedAt",
        expires_at AS "expiresAt"
      FROM envelopes
      WHERE id = $1
    `,
    [envelopeId],
  );

  if (!envelope) {
    throw new CrmApiError("Envelope not found.", 404);
  }

  const [signers, viewed, cc] = await Promise.all([
    queryMany<SignerRow>(
      database,
      `
        SELECT
          id,
          name,
          email,
          sign_order AS "order",
          status,
          last_notified_at AS "notifiedAt",
          signed_at AS "signedAt",
          declined_at AS "declinedAt"
        FROM signers
        WHERE envelope_id = $1 AND role = 'signer'
        ORDER BY sign_order ASC, id ASC
      `,
      [envelopeId],
    ),
    queryMany<{ signerId: string; viewedAt: number }>(
      database,
      `
        SELECT metadata->>'signerId' AS "signerId", MIN(created_at) AS "viewedAt"
        FROM audit_events
        WHERE envelope_id = $1 AND event = 'viewed'
        GROUP BY metadata->>'signerId'
      `,
      [envelopeId],
    ),
    listCopyRecipientsForEnvelopeId(envelopeId, database),
  ]);
  const viewedAtBySigner = new Map(
    viewed.map((row) => [row.signerId, row.viewedAt] as const),
  );

  return {
    cc: cc.map((recipient) => ({
      email: recipient.email,
      name: recipient.name,
    })),
    completedAt: unixToIso(envelope.completedAt),
    declinedAt: unixToIso(envelope.declinedAt),
    expiresAt: unixToIso(envelope.expiresAt),
    externalId: envelope.externalId,
    id: envelope.id,
    sentAt: unixToIso(envelope.sentAt),
    signers: signers.map((signer) => ({
      declinedAt: unixToIso(signer.declinedAt),
      email: signer.email,
      id: signer.id,
      name: signer.name,
      notifiedAt: unixToIso(signer.notifiedAt),
      order: signer.order,
      signedAt: unixToIso(signer.signedAt),
      status: signer.status,
      viewedAt: unixToIso(viewedAtBySigner.get(signer.id)),
    })),
    status: publicEnvelopeStatus(envelope),
    title: envelope.title,
    voidedAt: unixToIso(envelope.voidedAt),
  };
}

async function requireCompletedDownload(
  envelopeId: string,
  kind: "certificate" | "signed",
  database: DbPool,
): Promise<EnvelopeDownloadResult> {
  const envelope = await getEnvelopeForApi(envelopeId, database);

  if (envelope.status !== "completed") {
    throw new CrmApiError(
      kind === "signed"
        ? "The signed PDF is available once the envelope is completed."
        : "The certificate is available once the envelope is completed.",
      404,
    );
  }

  const actor = await requireEnvelopeActor(envelopeId, database);

  return getSenderEnvelopeDownload(
    actor.userId,
    envelopeId,
    kind === "signed" ? "signed" : "evidence",
    { database },
  );
}

export async function completedFileResponse(
  envelopeId: string,
  kind: "certificate" | "signed",
  database: DbPool = getDb(),
): Promise<Response> {
  return createDownloadResponse(
    await requireCompletedDownload(envelopeId, kind, database),
  );
}

export async function voidEnvelopeFromApi(
  envelopeId: string,
  reason: string | null,
  meta: CrmRequestMeta,
  database: DbPool = getDb(),
): Promise<{ id: string; status: "voided" }> {
  const actor = await requireEnvelopeActor(envelopeId, database);

  await voidSentEnvelope(
    actor.userId,
    envelopeId,
    {
      ipAddress: meta.ipAddress,
      reason,
      senderEmail: actor.email,
      senderName: senderName(actor),
      userAgent: meta.userAgent,
    },
    { database },
  );

  return { id: envelopeId, status: "voided" };
}

export async function remindEnvelopeFromApi(
  envelopeId: string,
  meta: CrmRequestMeta,
  database: DbPool = getDb(),
): Promise<{
  id: string;
  sentAt: string;
  signer: { email: string; name: string };
  status: string;
}> {
  const actor = await requireEnvelopeActor(envelopeId, database);
  const result = await sendManualEnvelopeNudge(
    actor.userId,
    envelopeId,
    {
      ipAddress: meta.ipAddress,
      senderEmail: actor.email,
      senderName: senderName(actor),
      userAgent: meta.userAgent,
    },
    { database },
  );
  const envelope = await getEnvelopeForApi(envelopeId, database);
  const signer = envelope.signers.find((item) => item.id === result.signerId);

  return {
    id: envelopeId,
    sentAt: unixToIso(result.sentAt) ?? new Date(0).toISOString(),
    signer: {
      email: signer?.email ?? "",
      name: result.signerName,
    },
    status: envelope.status,
  };
}

export async function envelopeIsOnDashboard(
  userId: string,
  envelopeId: string,
  database: DbPool = getDb(),
): Promise<boolean> {
  const items = await listEnvelopesForUser(userId, { limit: 100 }, database);

  return items.some((item) => item.id === envelopeId);
}
