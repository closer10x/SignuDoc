import { z } from "zod";

import {
  MAX_COPY_RECIPIENTS_PER_ENVELOPE,
  MAX_SIGNERS_PER_ENVELOPE,
  MAX_UPLOAD_SIZE_BYTES,
} from "../types/domain.ts";
import {
  emailSchema,
  envelopeTitleSchema,
  nameSchema,
} from "../schemas/common.ts";
import { getPdfImportErrorMessage } from "../services/document-import.ts";
import { readLimitedBody } from "../utils/limited-body.ts";
import { isProduction, readEnv, type EnvSource } from "../utils/env.ts";
import { CrmApiError } from "./errors.ts";

const MAX_JSON_BODY_BYTES = 30 * 1024 * 1024;
const API_FIELD_TYPES = [
  "signature",
  "initials",
  "date",
  "text",
  "checkbox",
] as const;

const signerInputSchema = z.object({
  email: emailSchema,
  name: nameSchema,
  order: z.number().int().positive().optional(),
});

const copyInputSchema = z.object({
  email: emailSchema,
  name: nameSchema.optional(),
});

const fieldInputSchema = z.object({
  height: z.number().finite().positive(),
  page: z.number().int().positive(),
  required: z.boolean().optional(),
  signerIndex: z.number().int().nonnegative(),
  type: z.enum(API_FIELD_TYPES),
  width: z.number().finite().positive(),
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
});

const createMetadataSchema = z
  .object({
    callbackUrl: z.string().trim().max(2000).nullable().optional(),
    cc: z
      .array(copyInputSchema)
      .max(MAX_COPY_RECIPIENTS_PER_ENVELOPE)
      .optional(),
    externalId: z.string().trim().max(200).nullable().optional(),
    fields: z.array(fieldInputSchema).optional(),
    filename: z.string().trim().min(1).max(255).optional(),
    message: z.string().trim().max(2000).nullable().optional(),
    send: z.boolean().optional(),
    signers: z.array(signerInputSchema).min(1).max(MAX_SIGNERS_PER_ENVELOPE),
    title: envelopeTitleSchema,
  })
  .superRefine((value, ctx) => {
    const orders = value.signers.map((signer) => signer.order);
    const anyOrder = orders.some((order) => order !== undefined);
    const allOrder = orders.every((order) => order !== undefined);

    if (anyOrder && !allOrder) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Give every signer an order, or leave order off all of them.",
        path: ["signers"],
      });
    }

    const seenOrders = new Set<number>();

    value.signers.forEach((signer, index) => {
      const order = signer.order ?? index + 1;

      if (seenOrders.has(order)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each signer must have a unique order.",
          path: ["signers", index, "order"],
        });
      }

      seenOrders.add(order);
    });

    const seenEmails = new Set<string>();

    value.signers.forEach((signer, index) => {
      const email = signer.email.toLowerCase();

      if (seenEmails.has(email)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each signer must have a unique email address.",
          path: ["signers", index, "email"],
        });
      }

      seenEmails.add(email);
    });

    (value.fields ?? []).forEach((field, index) => {
      if (field.signerIndex >= value.signers.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "signerIndex does not match a signer.",
          path: ["fields", index, "signerIndex"],
        });
      }
    });
  });

export type ApiFieldInput = {
  height: number;
  page: number;
  required: boolean;
  signerIndex: number;
  type: (typeof API_FIELD_TYPES)[number];
  width: number;
  x: number;
  y: number;
};

export type CreateEnvelopeCommand = {
  callbackUrl: string | null;
  cc: { email: string; name: string }[];
  externalId: string | null;
  /** Null means place a signature and a date for each signer. */
  fields: ApiFieldInput[] | null;
  filename: string;
  message: string | null;
  pdf: Uint8Array;
  send: boolean;
  signers: { email: string; name: string; order: number }[];
  title: string;
};

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";

  return trimmed.length > 0 ? trimmed : null;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function parseCallbackUrl(
  value: string,
  env: EnvSource = process.env,
): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new CrmApiError("callbackUrl must be an absolute URL.", 400);
  }

  if (url.username || url.password) {
    throw new CrmApiError(
      "callbackUrl must not include a username or password.",
      400,
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CrmApiError("callbackUrl must be an http or https URL.", 400);
  }

  if (
    isProduction(env) &&
    url.protocol !== "https:" &&
    !isLoopbackHost(url.hostname)
  ) {
    throw new CrmApiError("callbackUrl must use HTTPS.", 400);
  }

  return url.toString();
}

function pdfFilename(value: string | undefined, fallback: string): string {
  const name = (value?.trim() || fallback).replaceAll(/[/\\]/g, "");

  if (!name.toLowerCase().endsWith(".pdf")) {
    throw new CrmApiError("The document file name must end with .pdf.", 400);
  }

  return name.slice(0, 255);
}

function copyName(recipient: { email: string; name?: string }): string {
  const name = recipient.name?.trim();

  if (name) {
    return name;
  }

  const localPart = recipient.email.split("@")[0]?.trim();

  return localPart && localPart.length > 0
    ? localPart.slice(0, 120)
    : recipient.email;
}

function alwaysRequired(type: ApiFieldInput["type"]): boolean {
  return type === "signature" || type === "initials" || type === "date";
}

export function toCreateEnvelopeCommand(
  metadata: unknown,
  pdf: { bytes: Uint8Array; filename?: string },
  env: EnvSource = process.env,
): CreateEnvelopeCommand {
  const parsed = createMetadataSchema.safeParse(metadata);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join(".");
    const message = issue?.message ?? "Invalid envelope request.";

    throw new CrmApiError(path ? `${path}: ${message}` : message, 400);
  }

  if (pdf.bytes.byteLength === 0) {
    throw new CrmApiError("A PDF file is required.", 400);
  }

  if (pdf.bytes.byteLength > MAX_UPLOAD_SIZE_BYTES) {
    throw new CrmApiError(getPdfImportErrorMessage("too_large"), 400);
  }

  const data = parsed.data;
  const callbackUrl = blankToNull(data.callbackUrl);

  if (callbackUrl && !readEnv(env, "SIGNUDOC_WEBHOOK_SECRET")) {
    throw new CrmApiError(
      "Set SIGNUDOC_WEBHOOK_SECRET before using callbackUrl.",
      500,
    );
  }

  return {
    callbackUrl: callbackUrl ? parseCallbackUrl(callbackUrl, env) : null,
    cc: (data.cc ?? []).map((recipient) => ({
      email: recipient.email,
      name: copyName(recipient),
    })),
    externalId: blankToNull(data.externalId),
    fields:
      data.fields && data.fields.length > 0
        ? data.fields.map((field) => ({
            ...field,
            required: alwaysRequired(field.type)
              ? true
              : (field.required ?? true),
          }))
        : null,
    filename: pdfFilename(data.filename, pdf.filename ?? "document.pdf"),
    message: blankToNull(data.message),
    pdf: pdf.bytes,
    send: data.send ?? false,
    signers: data.signers.map((signer, index) => ({
      email: signer.email,
      name: signer.name,
      order: signer.order ?? index + 1,
    })),
    title: data.title,
  };
}

function decodePdfBase64(value: string): Uint8Array {
  const payload = value
    .replace(/^data:application\/pdf;base64,/i, "")
    .replace(/\s/g, "");

  if (payload.length === 0) {
    throw new CrmApiError("A PDF file is required.", 400);
  }

  return new Uint8Array(Buffer.from(payload, "base64"));
}

function parseJsonObject(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CrmApiError(`${label} must be JSON.`, 400);
  }
}

function formText(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSendFlag(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === true || value === "true") {
    return true;
  }

  if (value === false || value === "false") {
    return false;
  }

  throw new CrmApiError("send must be true or false.", 400);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CrmApiError("Invalid envelope request.", 400);
  }

  return value as Record<string, unknown>;
}

async function readMultipartCommand(
  request: Request,
  env: EnvSource,
): Promise<CreateEnvelopeCommand> {
  const formData = await request.formData().catch(() => null);

  if (!formData) {
    throw new CrmApiError("Invalid envelope request.", 400);
  }

  const uploaded = formData.get("file");

  if (!(uploaded instanceof File)) {
    throw new CrmApiError("A PDF file is required.", 400);
  }

  const payloadText = formText(formData, "payload");
  const metadata = asRecord(
    payloadText ? parseJsonObject(payloadText, "payload") : {},
  );
  const signersText = formText(formData, "signers");
  const ccText = formText(formData, "cc");
  const fieldsText = formText(formData, "fields");

  if (formText(formData, "title")) {
    metadata.title = formText(formData, "title");
  }

  if (signersText) {
    metadata.signers = parseJsonObject(signersText, "signers");
  }

  if (ccText) {
    metadata.cc = parseJsonObject(ccText, "cc");
  }

  if (fieldsText) {
    metadata.fields = parseJsonObject(fieldsText, "fields");
  }

  for (const name of [
    "message",
    "externalId",
    "callbackUrl",
    "filename",
  ] as const) {
    const text = formText(formData, name);

    if (text !== undefined) {
      metadata[name] = text;
    }
  }

  if (formData.has("send")) {
    metadata.send = parseSendFlag(formData.get("send"));
  }

  return toCreateEnvelopeCommand(
    metadata,
    {
      bytes: new Uint8Array(await uploaded.arrayBuffer()),
      filename: uploaded.name,
    },
    env,
  );
}

export async function readCreateEnvelopeRequest(
  request: Request,
  env: EnvSource = process.env,
): Promise<CreateEnvelopeCommand> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("multipart/form-data")) {
    return readMultipartCommand(request, env);
  }

  if (!contentType.includes("application/json")) {
    throw new CrmApiError("Send JSON or multipart form data.", 415);
  }

  const body = await readLimitedBody(request, MAX_JSON_BODY_BYTES);

  if (body === null) {
    throw new CrmApiError("This request is too large.", 413);
  }

  const parsed = parseJsonObject(
    new TextDecoder().decode(body),
    "The request body",
  );
  const record = asRecord(parsed);
  const pdfValue = record.pdf;

  if (typeof pdfValue !== "string" || pdfValue.trim().length === 0) {
    throw new CrmApiError("pdf must be a base64-encoded PDF.", 400);
  }

  const metadata = { ...record };

  delete metadata.pdf;

  return toCreateEnvelopeCommand(
    metadata,
    {
      bytes: decodePdfBase64(pdfValue),
      filename:
        typeof record.filename === "string" ? record.filename : undefined,
    },
    env,
  );
}
