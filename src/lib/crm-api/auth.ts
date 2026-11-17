import { createHash, timingSafeEqual } from "node:crypto";

import { readEnv, type EnvSource } from "../utils/env.ts";

const BEARER = /^Bearer (\S+)$/;

/** The credential after "Bearer ", or "" when the header is not that scheme. */
export function presentedBearerToken(authorization: string | null): string {
  return BEARER.exec(authorization ?? "")?.[1] ?? "";
}

/**
 * Compares the presented API key with the configured one. Both sides are
 * hashed first so the comparison takes the same time whatever the lengths
 * are, and a missing key still runs the comparison.
 */
export function apiKeyIsValid(
  presented: string,
  expected: string | undefined,
): boolean {
  const actualDigest = createHash("sha256").update(presented).digest();
  const expectedDigest = createHash("sha256")
    .update(expected ?? "signudoc-api-key-unset")
    .digest();
  const matches = timingSafeEqual(actualDigest, expectedDigest);

  return typeof expected === "string" && expected.length > 0 && matches;
}

/** True when the request carries the configured SIGNUDOC_API_KEY. */
export function authorizeCrmRequest(
  request: Request,
  env: EnvSource = process.env,
): boolean {
  return apiKeyIsValid(
    presentedBearerToken(request.headers.get("authorization")),
    readEnv(env, "SIGNUDOC_API_KEY"),
  );
}
