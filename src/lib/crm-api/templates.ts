import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getDb, queryMany, queryOne, type DbPool } from "../db/connection.ts";
import {
  deleteDraftEnvelope,
  sendDraftEnvelope,
} from "../envelopes.ts";
import { fieldPlacementListSchema } from "../schemas/field.ts";
import { templateRolesSchema } from "../schemas/template.ts";
import { createStorageService } from "../services/storage.ts";
import {
  createDraftFromTemplate,
  saveEnvelopeAsTemplate,
} from "../templates.ts";
import { readEnv, type EnvSource } from "../utils/env.ts";
import { CrmApiError } from "./errors.ts";
import { parseCallbackUrl } from "./request.ts";
import { type CreatedEnvelope, type CrmRequestMeta } from "./service.ts";
import { matchFieldLabels, type PageText } from "./template-labels.ts";

export type ApiTemplateRole = {
  name: string;
  order: number;
};

export type ApiTemplateSummary = {
  fieldCount: number;
  id: string;
  name: string;
  pageCount: number;
  roles: ApiTemplateRole[];
};

export type ApiTemplateField = {
  height: number;
  index: number;
  label: string;
  page: number;
  role: string;
  type: string;
  width: number;
  x: number;
  y: number;
};

type TemplateRow = {
  fields: unknown;
  id: string;
  name: string;
  pageCount: number;
  roles: unknown;
  sourcePdfKey: string;
};

const COLUMNS = `
  id,
  name,
  page_count AS "pageCount",
  roles,
  fields,
  source_pdf_key AS "sourcePdfKey"
`;

async function apiOwner(database: DbPool) {
  const owner = await queryOne<{ email: string; name: string; userId: string }>(
    database,
    `
      SELECT id AS "userId", name, email
      FROM "user"
      WHERE role = 'admin'
      ORDER BY "createdAt" ASC, id ASC
      LIMIT 1
    `,
  );

  if (!owner) {
    throw new CrmApiError(
      "Set up this site before using the API. Templates are kept on the administrator's account.",
      409,
    );
  }

  return owner;
}

function roleNames(roles: unknown): ApiTemplateRole[] {
  const parsed = templateRolesSchema.safeParse(roles);

  if (!parsed.success) {
    return [];
  }

  return parsed.data.map((role, index) => ({
    name: role.name,
    order: index + 1,
  }));
}

function fieldCount(fields: unknown): number {
  return Array.isArray(fields) ? fields.length : 0;
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";

  return trimmed.length > 0 ? trimmed : null;
}

export async function listTemplatesForApi(
  database: DbPool = getDb(),
): Promise<ApiTemplateSummary[]> {
  const owner = await apiOwner(database);
  const rows = await queryMany<TemplateRow>(
    database,
    `
      SELECT ${COLUMNS}
      FROM templates
      WHERE user_id = $1
      ORDER BY created_at DESC, id ASC
    `,
    [owner.userId],
  );

  return rows.map((row) => ({
    fieldCount: fieldCount(row.fields),
    id: row.id,
    name: row.name,
    pageCount: row.pageCount,
    roles: roleNames(row.roles),
  }));
}

async function templateForOwner(
  templateId: string,
  database: DbPool,
): Promise<{ owner: Awaited<ReturnType<typeof apiOwner>>; row: TemplateRow }> {
  const owner = await apiOwner(database);
  const row = await queryOne<TemplateRow>(
    database,
    `SELECT ${COLUMNS} FROM templates WHERE id = $1 AND user_id = $2`,
    [templateId, owner.userId],
  );

  if (!row) {
    throw new CrmApiError("Template not found.", 404);
  }

  return { owner, row };
}

export async function getTemplateForApi(
  templateId: string,
  database: DbPool = getDb(),
): Promise<ApiTemplateSummary & { fields: ApiTemplateField[] }> {
  const { row } = await templateForOwner(templateId, database);
  const roles = templateRolesSchema.safeParse(row.roles);
  const fields = fieldPlacementListSchema.safeParse(row.fields);

  if (!roles.success || !fields.success) {
    throw new CrmApiError(
      "This template can no longer be used. Save it again from the document.",
      409,
    );
  }

  const roleName = new Map(roles.data.map((role) => [role.id, role.name]));

  return {
    fieldCount: fields.data.length,
    fields: fields.data.map((field, index) => ({
      height: field.height,
      index,
      label: field.label ?? "",
      page: field.page,
      role: roleName.get(field.signerId) ?? "",
      type: field.type,
      width: field.width,
      x: field.x,
      y: field.y,
    })),
    id: row.id,
    name: row.name,
    pageCount: row.pageCount,
    roles: roleNames(row.roles),
  };
}

type TemplateSigner = {
  email: string;
  name: string;
  role?: string;
};

export async function createEnvelopeFromTemplate(
  templateId: string,
  input: {
    callbackUrl?: string | null;
    externalId?: string | null;
    message?: string | null;
    send?: boolean;
    signers: TemplateSigner[];
    title?: string;
  },
  meta: CrmRequestMeta,
  database: DbPool = getDb(),
  env: EnvSource = process.env,
): Promise<CreatedEnvelope> {
  const { owner, row } = await templateForOwner(templateId, database);
  const roles = roleNames(row.roles);

  if (roles.length === 0) {
    throw new CrmApiError(
      "This template can no longer be used. Save it again from the document.",
      409,
    );
  }

  const signers = orderSigners(roles, input.signers);
  const callbackUrl = blankToNull(input.callbackUrl);

  if (callbackUrl && !readEnv(env, "SIGNUDOC_WEBHOOK_SECRET")) {
    throw new CrmApiError(
      "Set SIGNUDOC_WEBHOOK_SECRET before using callbackUrl.",
      500,
    );
  }

  const draft = await createDraftFromTemplate(
    owner.userId,
    templateId,
    {
      signers: signers.map((signer) => ({
        email: signer.email,
        name: signer.name,
      })),
      title: input.title?.trim() || row.name,
    },
    { database },
  );
  const envelopeId = draft.envelopeId;
  let sent = false;

  try {
    await database.query(
      `
        UPDATE envelopes
        SET external_id = $2, callback_url = $3, message = $4, updated_at = $5
        WHERE id = $1
      `,
      [
        envelopeId,
        blankToNull(input.externalId),
        callbackUrl ? parseCallbackUrl(callbackUrl, env) : null,
        blankToNull(input.message),
        Math.floor(Date.now() / 1000),
      ],
    );

    let signingUrl: string | null = null;
    let status: "draft" | "sent" = "draft";

    if (input.send !== false) {
      const sentResult = await sendDraftEnvelope(
        owner.userId,
        envelopeId,
        {
          ipAddress: meta.ipAddress,
          message: blankToNull(input.message) ?? undefined,
          senderEmail: owner.email,
          senderName: owner.name.trim() || owner.email,
          userAgent: meta.userAgent,
        },
        { database },
      );

      sent = true;
      signingUrl = sentResult.signingUrl;
      status = "sent";
    }

    const appUrl = readEnv(env, "APP_URL")?.replace(/\/$/, "") ?? "";

    return {
      dashboardUrl: appUrl
        ? new URL(`/envelopes/${envelopeId}`, appUrl).toString()
        : "",
      externalId: blankToNull(input.externalId),
      id: envelopeId,
      signingUrls: signers.map((signer, index) => ({
        email: signer.email,
        name: signer.name,
        order: index + 1,
        url: signingUrl && index === 0 ? signingUrl : null,
      })),
      status,
    };
  } catch (error) {
    if (!sent) {
      await deleteDraftEnvelope(owner.userId, envelopeId, { database }).catch(
        () => undefined,
      );
    }

    throw error;
  }
}

function orderSigners(
  roles: ApiTemplateRole[],
  signers: TemplateSigner[],
): TemplateSigner[] {
  const named = signers.some((signer) => signer.role?.trim());

  if (!named) {
    if (signers.length !== roles.length) {
      throw new CrmApiError(
        "Name one person for each signer in this template.",
        400,
      );
    }

    return signers;
  }

  return roles.map((role) => {
    const signer = signers.find(
      (item) => item.role?.trim().toLowerCase() === role.name.toLowerCase(),
    );

    if (!signer) {
      throw new CrmApiError(`Name someone for the ${role.name} role.`, 400);
    }

    return signer;
  });
}

export async function saveDraftAsTemplate(
  envelopeId: string,
  input: { name: string; roleNames?: string[] },
  database: DbPool = getDb(),
): Promise<{ id: string; name: string }> {
  const owner = await apiOwner(database);
  const saved = await saveEnvelopeAsTemplate(owner.userId, envelopeId, input, {
    database,
  });

  return saved;
}

function installPdfDomShims() {
  if (typeof globalThis.DOMMatrix !== "undefined") return;

  class DOMMatrixShim {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;

    constructor(init?: number[]) {
      if (Array.isArray(init) && init.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
    }
  }

  Object.assign(globalThis, { DOMMatrix: DOMMatrixShim });
}

async function pageText(pdf: Uint8Array): Promise<PageText[]> {
  installPdfDomShims();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const nodeRequire = createRequire(import.meta.url);
  const workerFile = nodeRequire.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const fontDir = path.dirname(nodeRequire.resolve("pdfjs-dist/standard_fonts/FoxitSerif.pfb"));
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerFile).href;
  const document = await pdfjs.getDocument({
    data: Uint8Array.from(pdf),
    isEvalSupported: false,
    standardFontDataUrl: `${pathToFileURL(fontDir).href}/`,
    useSystemFonts: true,
  }).promise;
  const texts: PageText[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    for (const item of content.items) {
      if (!("str" in item) || typeof item.str !== "string" || !item.str.trim()) {
        continue;
      }

      const transform = item.transform;
      const x = transform[4] / viewport.width;
      const y = 1 - transform[5] / viewport.height;

      texts.push({
        page: pageNumber,
        text: item.str.trim(),
        x,
        y,
      });
    }
  }

  return texts;
}

export async function previewTemplateLabels(
  templateId: string,
  database: DbPool = getDb(),
): Promise<{ index: number; label: string; page: number; type: string }[]> {
  const detail = await getTemplateForApi(templateId, database);
  const { row } = await templateForOwner(templateId, database);
  const stored = await createStorageService().getObject(row.sourcePdfKey);
  const texts = await pageText(stored.body);
  const matches = matchFieldLabels(
    detail.fields.map((field) => ({
      height: field.height,
      label: field.label,
      page: field.page,
      type: field.type,
      width: field.width,
      x: field.x,
      y: field.y,
    })),
    texts,
  );

  return matches.map((match) => ({
    index: match.index,
    label: match.label,
    page: detail.fields[match.index]?.page ?? 0,
    type: detail.fields[match.index]?.type ?? "",
  }));
}

/**
 * Sets the label on fill-in boxes and leaves every other part of the
 * template — positions, roles, and required flags — as it was.
 */
export async function applyTemplateLabels(
  templateId: string,
  labels: { index: number; label: string }[],
  database: DbPool = getDb(),
): Promise<{ updated: number }> {
  const { owner, row } = await templateForOwner(templateId, database);
  const fields = fieldPlacementListSchema.safeParse(row.fields);

  if (!fields.success) {
    throw new CrmApiError(
      "This template can no longer be used. Save it again from the document.",
      409,
    );
  }

  const next = fields.data.map((field) => ({ ...field }));
  let updated = 0;

  for (const change of labels) {
    const field = next[change.index];
    const label = change.label.trim().slice(0, 120);

    if (!field || !label) {
      throw new CrmApiError("That field is not on this template.", 400);
    }

    if (field.type !== "text" && field.type !== "number" && field.type !== "date") {
      throw new CrmApiError(
        "Only text, number, and date boxes take a label.",
        400,
      );
    }

    field.label = label;
    updated += 1;
  }

  await database.query(
    `
      UPDATE templates
      SET fields = $3::jsonb, updated_at = $4
      WHERE id = $1 AND user_id = $2
    `,
    [
      templateId,
      owner.userId,
      JSON.stringify(next),
      Math.floor(Date.now() / 1000),
    ],
  );

  return { updated };
}
