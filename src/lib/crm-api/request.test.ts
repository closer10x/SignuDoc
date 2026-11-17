import assert from "node:assert/strict";
import { test } from "node:test";

import { CrmApiError } from "./errors.ts";
import {
  readCreateEnvelopeRequest,
  toCreateEnvelopeCommand,
} from "./request.ts";

const SECRET = { SIGNUDOC_WEBHOOK_SECRET: "webhook-secret-0123456789" };
const PDF = new Uint8Array(Buffer.from("%PDF-1.4\n"));

const signers = [{ email: "riley@example.com", name: "Riley Signer" }];

test("JSON with a base64 PDF becomes a create command", async () => {
  const request = new Request("https://sign.example/api/v1/envelopes", {
    body: JSON.stringify({
      callbackUrl: "https://crm.example/hooks",
      externalId: "lead-1",
      filename: "lease.pdf",
      message: "Please sign",
      pdf: Buffer.from(PDF).toString("base64"),
      send: true,
      signers,
      title: "Lease",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const command = await readCreateEnvelopeRequest(request, SECRET);

  assert.equal(command.title, "Lease");
  assert.equal(command.send, true);
  assert.equal(command.externalId, "lead-1");
  assert.equal(command.message, "Please sign");
  assert.equal(command.filename, "lease.pdf");
  assert.equal(command.callbackUrl, "https://crm.example/hooks");
  assert.equal(command.fields, null);
  assert.deepEqual(command.signers, [
    { email: "riley@example.com", name: "Riley Signer", order: 1 },
  ]);
  assert.equal(command.pdf[0], PDF[0]);
});

test("multipart form data accepts the PDF as a file", async () => {
  const form = new FormData();

  form.set("file", new File([PDF], "policy.pdf", { type: "application/pdf" }));
  form.set("title", "Policy");
  form.set("signers", JSON.stringify(signers));
  form.set("send", "false");
  form.set("cc", JSON.stringify([{ email: "copy@example.com" }]));

  const request = new Request("https://sign.example/api/v1/envelopes", {
    body: form,
    method: "POST",
  });
  const command = await readCreateEnvelopeRequest(request, SECRET);

  assert.equal(command.send, false);
  assert.equal(command.filename, "policy.pdf");
  assert.deepEqual(command.cc, [{ email: "copy@example.com", name: "copy" }]);
});

test("a payload JSON field can carry the rest of a multipart request", async () => {
  const form = new FormData();

  form.set("file", new File([PDF], "policy.pdf", { type: "application/pdf" }));
  form.set(
    "payload",
    JSON.stringify({
      send: true,
      signers: [
        { email: "second@example.com", name: "Second", order: 2 },
        { email: "first@example.com", name: "First", order: 1 },
      ],
      title: "Policy",
    }),
  );

  const command = await readCreateEnvelopeRequest(
    new Request("https://sign.example/api/v1/envelopes", {
      body: form,
      method: "POST",
    }),
    SECRET,
  );

  assert.deepEqual(
    command.signers.map((signer) => signer.order),
    [2, 1],
  );
  assert.equal(command.send, true);
});

test("validation rejects a bad envelope before it is stored", () => {
  const cases: { message: RegExp; metadata: unknown }[] = [
    { message: /title/i, metadata: { signers } },
    {
      message: /email/i,
      metadata: {
        signers: [{ email: "not-an-email", name: "Riley" }],
        title: "Lease",
      },
    },
    {
      message: /unique order/i,
      metadata: {
        signers: [
          { email: "a@example.com", name: "A", order: 1 },
          { email: "b@example.com", name: "B", order: 1 },
        ],
        title: "Lease",
      },
    },
    {
      message: /signature|initials|date|text|checkbox|invalid/i,
      metadata: {
        fields: [
          {
            height: 10,
            page: 1,
            signerIndex: 0,
            type: "stamp",
            width: 10,
            x: 1,
            y: 1,
          },
        ],
        signers,
        title: "Lease",
      },
    },
    {
      message: /signerIndex/i,
      metadata: {
        fields: [
          {
            height: 0.05,
            page: 1,
            signerIndex: 3,
            type: "signature",
            width: 0.2,
            x: 0.1,
            y: 0.1,
          },
        ],
        signers,
        title: "Lease",
      },
    },
  ];

  for (const entry of cases) {
    assert.throws(
      () => toCreateEnvelopeCommand(entry.metadata, { bytes: PDF }, SECRET),
      (error: unknown) =>
        error instanceof CrmApiError &&
        error.statusCode === 400 &&
        entry.message.test(error.message),
    );
  }
});

test("callback URLs must be https except on loopback, and need the webhook secret", () => {
  const metadata = {
    callbackUrl: "http://crm.example/hooks",
    signers,
    title: "Lease",
  };
  const production = { NODE_ENV: "production", ...SECRET };

  assert.throws(
    () => toCreateEnvelopeCommand(metadata, { bytes: PDF }, production),
    (error: unknown) =>
      error instanceof CrmApiError && /HTTPS/.test(error.message),
  );
  assert.equal(
    toCreateEnvelopeCommand(
      { ...metadata, callbackUrl: "http://127.0.0.1:9/hooks" },
      { bytes: PDF },
      production,
    ).callbackUrl,
    "http://127.0.0.1:9/hooks",
  );
  assert.throws(
    () =>
      toCreateEnvelopeCommand(
        { ...metadata, callbackUrl: "https://crm.example/hooks" },
        { bytes: PDF },
        { NODE_ENV: "production" },
      ),
    (error: unknown) =>
      error instanceof CrmApiError &&
      /SIGNUDOC_WEBHOOK_SECRET/.test(error.message),
  );
});

test("send defaults to false and a file name must end in .pdf", () => {
  const command = toCreateEnvelopeCommand(
    { signers, title: "Lease" },
    { bytes: PDF },
    SECRET,
  );

  assert.equal(command.send, false);
  assert.equal(command.filename, "document.pdf");
  assert.throws(
    () =>
      toCreateEnvelopeCommand(
        { filename: "notes.txt", signers, title: "Lease" },
        { bytes: PDF },
        SECRET,
      ),
    /pdf/,
  );
});
