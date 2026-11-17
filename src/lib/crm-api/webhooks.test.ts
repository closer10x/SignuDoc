import assert from "node:assert/strict";
import { test } from "node:test";

import { webhookSignatureIsValid } from "./signature.ts";
import {
  postSignedWebhook,
  serializeWebhookPayload,
  signerFromMetadata,
} from "./webhooks.ts";

const SECRET = "webhook-secret";

test("the signed body keeps a stable key order", () => {
  const body = serializeWebhookPayload({
    envelopeId: "env-1",
    event: "signed",
    externalId: "lead-1",
    occurredAt: "2026-11-17T00:00:00.000Z",
    signer: { email: "riley@example.com", id: "signer-1", name: "Riley" },
    status: "sent",
  });

  assert.equal(
    body,
    '{"event":"signed","envelopeId":"env-1","externalId":"lead-1","status":"sent","signer":{"id":"signer-1","name":"Riley","email":"riley@example.com"},"occurredAt":"2026-11-17T00:00:00.000Z"}',
  );
  assert.equal(signerFromMetadata({ signerEmail: "a@b.c" }), null);
  assert.deepEqual(
    signerFromMetadata({
      signerEmail: "riley@example.com",
      signerId: "signer-1",
      signerName: "Riley",
    }),
    { email: "riley@example.com", id: "signer-1", name: "Riley" },
  );
});

test("a callback is retried with backoff until it succeeds", async () => {
  const waits: number[] = [];
  const statuses = [500, 500, 200];
  let signed = "";
  const result = await postSignedWebhook({
    body: '{"event":"sent"}',
    delaysMs: [0, 5, 15],
    fetchImpl: async (_url, init) => {
      signed = new Headers(init?.headers).get("x-signudoc-signature") ?? "";

      return new Response("no", { status: statuses.shift() ?? 500 });
    },
    secret: SECRET,
    sleep: async (ms) => {
      waits.push(ms);
    },
    url: "https://crm.example/hooks",
  });

  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(waits, [5, 15]);
  assert.equal(
    webhookSignatureIsValid(signed, '{"event":"sent"}', SECRET),
    true,
  );
});

test("a rejected callback is not retried", async () => {
  let calls = 0;
  const result = await postSignedWebhook({
    body: "{}",
    delaysMs: [0, 5, 15],
    fetchImpl: async () => {
      calls += 1;

      return new Response("bad", { status: 400 });
    },
    secret: SECRET,
    sleep: async () => undefined,
    url: "https://crm.example/hooks",
  });

  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
  assert.equal(result.statusCode, 400);
});
