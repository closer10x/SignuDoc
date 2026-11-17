import assert from "node:assert/strict";
import { test } from "node:test";

import { publicEnvelopeStatus, unixToIso } from "./status.ts";

test("a sent envelope past its deadline is reported as expired", () => {
  assert.equal(
    publicEnvelopeStatus({ expiresAt: 100, status: "sent" }, 100),
    "expired",
  );
  assert.equal(
    publicEnvelopeStatus({ expiresAt: 100, status: "sent" }, 99),
    "sent",
  );
  assert.equal(
    publicEnvelopeStatus({ expiresAt: 100, status: "completed" }, 500),
    "completed",
  );
  assert.equal(
    publicEnvelopeStatus({ expiresAt: null, status: "draft" }, 500),
    "draft",
  );
});

test("unix timestamps become UTC instants", () => {
  assert.equal(unixToIso(0), "1970-01-01T00:00:00.000Z");
  assert.equal(unixToIso(null), null);
});
