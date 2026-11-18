import assert from "node:assert/strict";
import { test } from "node:test";

import { resendRecipientStatus } from "./resend-recipient.ts";

test("a Resend invalid recipient is a 400, not an unexpected failure", () => {
  const mapped = resendRecipientStatus(
    new Error(
      "Invalid `to` field. Please use our testing email address instead of domains like `example.com`. See our documentation for more information.",
    ),
  );
  assert.equal(mapped?.status, 400);
  assert.match(mapped?.message ?? "", /Invalid `to` field/);
  assert.equal(resendRecipientStatus(new Error("database is down")), null);
  assert.equal(resendRecipientStatus("nope"), null);
});
