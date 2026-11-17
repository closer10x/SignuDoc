import { waitUntil } from "@vercel/functions";

import { readEnv } from "../utils/env.ts";
import {
  deliverEnvelopeWebhook,
  WEBHOOK_EVENTS,
  type EnvelopeWebhookSource,
} from "./webhooks.ts";

/**
 * Starts a webhook delivery without waiting for it. Called after an audit
 * event commits. A missing webhook secret means this install is not sending
 * callbacks, so nothing is looked up.
 */
export function dispatchEnvelopeWebhook(source: EnvelopeWebhookSource): void {
  if (!WEBHOOK_EVENTS.has(source.event)) {
    return;
  }

  if (!readEnv(process.env, "SIGNUDOC_WEBHOOK_SECRET")) {
    return;
  }

  const work = deliverEnvelopeWebhook(source).catch((error: unknown) => {
    console.error(
      `[crm-api] Webhook for envelope ${source.envelopeId} (${source.event}) failed:`,
      error,
    );
  });

  try {
    waitUntil(work);
  } catch {
    // Outside a request the promise still runs on its own.
  }
}
