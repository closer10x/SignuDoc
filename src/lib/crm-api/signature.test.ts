import assert from "node:assert/strict";
import { test } from "node:test";

import { signWebhookBody, webhookSignatureIsValid } from "./signature.ts";

const BODY = '{"event":"sent","envelopeId":"env_1"}';
const SECRET = "topsecret";
// HMAC-SHA256 of BODY with SECRET.
const DIGEST =
  "de0e3e0cb71fdb60118564b1952f8832849982d71112aaafefae165e888181da";

test("webhook bodies are signed with HMAC-SHA256", () => {
  assert.equal(signWebhookBody(BODY, SECRET), `sha256=${DIGEST}`);
  assert.equal(webhookSignatureIsValid(`sha256=${DIGEST}`, BODY, SECRET), true);
});

test("a changed body, secret, or header does not verify", () => {
  const signature = signWebhookBody(BODY, SECRET);

  assert.equal(webhookSignatureIsValid(signature, `${BODY} `, SECRET), false);
  assert.equal(webhookSignatureIsValid(signature, BODY, "other-secret"), false);
  assert.equal(webhookSignatureIsValid(DIGEST, BODY, SECRET), false);
  assert.equal(webhookSignatureIsValid(null, BODY, SECRET), false);
  assert.equal(webhookSignatureIsValid("sha256=abc", BODY, SECRET), false);
});
