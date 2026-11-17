import assert from "node:assert/strict";
import { test } from "node:test";

import { CrmApiError } from "./errors.ts";
import { autoPlaceSignerFields, normalizeFieldRect } from "./fields.ts";

const LETTER = { heightPt: 792, widthPt: 612 };

test("coordinates already between 0 and 1 stay as they are", () => {
  assert.deepEqual(
    normalizeFieldRect({ height: 0.07, width: 0.24, x: 0.1, y: 0.2 }, LETTER),
    { height: 0.07, width: 0.24, x: 0.1, y: 0.2 },
  );
});

test("points from the top left are divided by the page size", () => {
  const normalized = normalizeFieldRect(
    { height: 36, width: 144, x: 72, y: 72 },
    LETTER,
  );

  assert.ok(Math.abs(normalized.x - 72 / 612) < 1e-12);
  assert.ok(Math.abs(normalized.y - 72 / 792) < 1e-12);
  assert.ok(Math.abs(normalized.width - 144 / 612) < 1e-12);
  assert.ok(Math.abs(normalized.height - 36 / 792) < 1e-12);
});

test("each signer gets a signature and a date on the last page", () => {
  const fields = autoPlaceSignerFields(
    [{ id: "signer-a" }, { id: "signer-b" }],
    3,
  );

  assert.deepEqual(
    fields.map((field) => [field.signerId, field.type, field.page]),
    [
      ["signer-a", "signature", 3],
      ["signer-a", "date", 3],
      ["signer-b", "signature", 3],
      ["signer-b", "date", 3],
    ],
  );

  for (const field of fields) {
    assert.ok(field.x >= 0 && field.y >= 0);
    assert.ok(field.x + field.width <= 1);
    assert.ok(field.y + field.height <= 1);
    assert.equal(field.required, true);
  }

  // The second signer is closer to the bottom of the page.
  const first = fields.find(
    (field) => field.signerId === "signer-a" && field.type === "signature",
  );
  const second = fields.find(
    (field) => field.signerId === "signer-b" && field.type === "signature",
  );

  assert.ok(first && second && second.y > first.y);
});

test("too many automatic signatures are refused", () => {
  const signers = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
  }));

  assert.throws(
    () => autoPlaceSignerFields(signers, 1),
    (error: unknown) =>
      error instanceof CrmApiError && error.statusCode === 400,
  );
});
