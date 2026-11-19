import { randomUUID } from "node:crypto";

import { type DbPool, getDb, queryOne } from "../db/connection.ts";
import { isMissingSchemaError } from "../settings.ts";
import { readEnv, type EnvSource } from "../utils/env.ts";
import { signWebhookBody } from "./signature.ts";
import { publicEnvelopeStatus, unixToIso } from "./status.ts";

/** Audit events that are reported to callbackUrl. */
export const WEBHOOK_EVENTS = new Set([
  "sent",
  "viewed",
  "signed",
  "completed",
  "declined",
  "voided",
  "expired",
]);

/** Four tries: immediately, then 1s, 4s and 16s. */
export const WEBHOOK_RETRY_DELAYS_MS = [0, 1_000, 4_000, 16_000];

const WEBHOOK_TIMEOUT_MS = 10_000;

export type WebhookSigner = {
  email: string;
  id: string;
  name: string;
};

export type EnvelopeWebhookSource = {
  createdAt: number;
  envelopeId: string;
  event: string;
  metadata: Record<string, unknown> | null;
};

export type WebhookPayload = {
  envelopeId: string;
  event: string;
  externalId: string | null;
  /** The next person's signing page, when this signature opened their turn. */
  nextSigningUrl?: string;
  occurredAt: string;
  signer?: WebhookSigner;
  status: string;
};

type WebhookPostResult = {
  attempts: number;
  delivered: boolean;
  error: string | null;
  statusCode: number | null;
};

/** A signing page for the person whose turn just opened. Anything else is ignored. */
export function nextSigningUrlFromMetadata(
  metadata: Record<string, unknown> | null,
): string | null {
  const value = metadata?.nextSigningUrl;

  if (typeof value !== "string") {
    return null;
  }

  const url = value.trim();

  if (!url.startsWith("https://") || url.length > 500 || /\s/.test(url)) {
    return null;
  }

  return url;
}

export function signerFromMetadata(
  metadata: Record<string, unknown> | null,
): WebhookSigner | null {
  if (!metadata) {
    return null;
  }

  const id = metadata.signerId;
  const email = metadata.signerEmail;
  const name = metadata.signerName;

  if (typeof id !== "string" || typeof email !== "string") {
    return null;
  }

  return {
    email,
    id,
    name: typeof name === "string" && name.trim().length > 0 ? name : email,
  };
}

/** The JSON bytes that are signed and sent. Key order is part of the signature. */
export function serializeWebhookPayload(payload: WebhookPayload): string {
  const body: Record<string, unknown> = {
    event: payload.event,
    envelopeId: payload.envelopeId,
    externalId: payload.externalId,
    status: payload.status,
  };

  if (payload.signer) {
    body.signer = {
      id: payload.signer.id,
      name: payload.signer.name,
      email: payload.signer.email,
    };
  }

  if (payload.nextSigningUrl) {
    body.nextSigningUrl = payload.nextSigningUrl;
  }

  body.occurredAt = payload.occurredAt;

  return JSON.stringify(body);
}

function shouldRetry(statusCode: number | null): boolean {
  if (statusCode === null) {
    return true;
  }

  if (statusCode === 408 || statusCode === 429) {
    return true;
  }

  return statusCode >= 500;
}

export async function postSignedWebhook({
  body,
  delaysMs = WEBHOOK_RETRY_DELAYS_MS,
  fetchImpl = fetch,
  secret,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  url,
}: {
  body: string;
  delaysMs?: readonly number[];
  fetchImpl?: typeof fetch;
  secret: string;
  sleep?: (ms: number) => Promise<void>;
  url: string;
}): Promise<WebhookPostResult> {
  let lastError: string | null = null;
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
    const delay = delaysMs[attempt] ?? 0;

    if (delay > 0) {
      await sleep(delay);
    }

    try {
      const response = await fetchImpl(url, {
        body,
        headers: {
          "content-type": "application/json",
          "user-agent": "SignuDoc",
          "x-signudoc-signature": signWebhookBody(body, secret),
        },
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });

      lastStatus = response.status;
      lastError = response.ok ? null : `HTTP ${String(response.status)}`;

      if (response.ok) {
        return {
          attempts: attempt + 1,
          delivered: true,
          error: null,
          statusCode: response.status,
        };
      }
    } catch (error) {
      lastStatus = null;
      lastError =
        error instanceof Error ? error.message : "The callback failed.";
    }

    if (!shouldRetry(lastStatus)) {
      return {
        attempts: attempt + 1,
        delivered: false,
        error: lastError,
        statusCode: lastStatus,
      };
    }
  }

  return {
    attempts: delaysMs.length,
    delivered: false,
    error: lastError,
    statusCode: lastStatus,
  };
}

type CallbackRow = {
  callbackUrl: string | null;
  expiresAt: number | null;
  externalId: string | null;
  status: string;
};

/**
 * Looks up the envelope and posts its callback. Failures are recorded and
 * then swallowed by the caller, so signing is never rolled back for them.
 */
export async function deliverEnvelopeWebhook(
  source: EnvelopeWebhookSource,
  {
    database = getDb(),
    env = process.env,
    fetchImpl,
    delaysMs,
    sleep,
  }: {
    database?: DbPool;
    delaysMs?: readonly number[];
    env?: EnvSource;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const secret = readEnv(env, "SIGNUDOC_WEBHOOK_SECRET");

  if (!secret || !WEBHOOK_EVENTS.has(source.event)) {
    return;
  }

  let row: CallbackRow | null;

  try {
    row = await queryOne<CallbackRow>(
      database,
      `
        SELECT
          status,
          external_id AS "externalId",
          callback_url AS "callbackUrl",
          expires_at AS "expiresAt"
        FROM envelopes
        WHERE id = $1
      `,
      [source.envelopeId],
    );
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return;
    }

    throw error;
  }

  if (!row?.callbackUrl) {
    return;
  }

  const signer = signerFromMetadata(source.metadata);
  const nextSigningUrl = nextSigningUrlFromMetadata(source.metadata);
  const body = serializeWebhookPayload({
    envelopeId: source.envelopeId,
    event: source.event,
    externalId: row.externalId,
    ...(nextSigningUrl ? { nextSigningUrl } : {}),
    occurredAt: unixToIso(source.createdAt) ?? new Date(0).toISOString(),
    ...(signer ? { signer } : {}),
    status: publicEnvelopeStatus(row, source.createdAt),
  });
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await database.query(
    `
      INSERT INTO webhook_deliveries (
        id, envelope_id, event, callback_url, payload, attempt_count, status,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, 0, 'pending', $6, $6)
    `,
    [id, source.envelopeId, source.event, row.callbackUrl, body, now],
  );

  const result = await postSignedWebhook({
    body,
    delaysMs,
    fetchImpl,
    secret,
    sleep,
    url: row.callbackUrl,
  });
  const finishedAt = Math.floor(Date.now() / 1000);

  await database.query(
    `
      UPDATE webhook_deliveries
      SET
        attempt_count = $2,
        status = $3,
        last_status_code = $4,
        last_error = $5,
        updated_at = $6,
        delivered_at = $7
      WHERE id = $1
    `,
    [
      id,
      result.attempts,
      result.delivered ? "delivered" : "failed",
      result.statusCode,
      result.error,
      finishedAt,
      result.delivered ? finishedAt : null,
    ],
  );
}
