import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Hex HMAC-SHA256 of the exact request body, prefixed for the header. */
export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * True when `presented` is the HMAC of `body`. Both sides are hashed before
 * they are compared, so the time taken does not depend on how much of the
 * header matched.
 */
export function webhookSignatureIsValid(
  presented: string | null,
  body: string,
  secret: string,
): boolean {
  const expected = signWebhookBody(body, secret);
  const actualDigest = createHash("sha256")
    .update(presented ?? "")
    .digest();
  const expectedDigest = createHash("sha256").update(expected).digest();

  return timingSafeEqual(actualDigest, expectedDigest);
}
