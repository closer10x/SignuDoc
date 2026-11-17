import assert from "node:assert/strict";
import { test } from "node:test";

import {
  apiKeyIsValid,
  authorizeCrmRequest,
  presentedBearerToken,
} from "./auth.ts";

const KEY = "crm-api-key-0123456789abcdef";

function request(authorization?: string): Request {
  return new Request("https://sign.example/api/v1/envelopes", {
    headers: authorization ? { authorization } : {},
    method: "POST",
  });
}

test("a bearer token is taken and anything else is empty", () => {
  assert.equal(presentedBearerToken("Bearer secret-token"), "secret-token");
  assert.equal(presentedBearerToken("Bearer   spaced"), "");
  assert.equal(presentedBearerToken("Basic secret-token"), "");
  assert.equal(presentedBearerToken(null), "");
});

test("the API key matches in constant time, including keys of different lengths", () => {
  assert.equal(apiKeyIsValid(KEY, KEY), true);
  assert.equal(apiKeyIsValid("nope", KEY), false);
  assert.equal(apiKeyIsValid("x", KEY), false);
  assert.equal(apiKeyIsValid(`${KEY}extra-characters`, KEY), false);
  assert.equal(apiKeyIsValid("", KEY), false);
  assert.equal(apiKeyIsValid(KEY, undefined), false);
  assert.equal(apiKeyIsValid("", undefined), false);
});

test("requests without the configured bearer token are refused", () => {
  const env = { SIGNUDOC_API_KEY: KEY };

  assert.equal(authorizeCrmRequest(request(`Bearer ${KEY}`), env), true);
  assert.equal(authorizeCrmRequest(request("Bearer wrong-key"), env), false);
  assert.equal(authorizeCrmRequest(request(), env), false);
  assert.equal(authorizeCrmRequest(request(`Bearer ${KEY}`), {}), false);
  assert.equal(
    authorizeCrmRequest(request(`Bearer ${KEY}`), {
      SIGNUDOC_API_KEY: "replace-with-a-real-key",
    }),
    false,
  );
});
