import assert from "node:assert/strict";
import { test } from "node:test";

import { matchFieldLabels } from "./template-labels.ts";

test("a text box takes the caption printed just above it", () => {
  const matches = matchFieldLabels(
    [
      { type: "text", page: 1, x: 0.2, y: 0.3, width: 0.3, height: 0.03 },
      { type: "signature", page: 1, x: 0.2, y: 0.5, width: 0.3, height: 0.05 },
      {
        type: "text",
        page: 1,
        x: 0.2,
        y: 0.62,
        width: 0.3,
        height: 0.03,
        label: "Kept",
      },
    ],
    [
      { page: 1, x: 0.2, y: 0.27, text: "Legal Name" },
      { page: 1, x: 0.2, y: 0.58, text: "Email" },
    ],
  );

  assert.deepEqual(matches, [{ index: 0, label: "Legal Name" }]);
});

test("two boxes do not share one caption", () => {
  const matches = matchFieldLabels(
    [
      { type: "text", page: 2, x: 0.1, y: 0.2, width: 0.2, height: 0.03 },
      { type: "number", page: 2, x: 0.5, y: 0.2, width: 0.2, height: 0.03 },
    ],
    [{ page: 2, x: 0.12, y: 0.16, text: "New Business %" }],
  );

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.label, "New Business %");
});
