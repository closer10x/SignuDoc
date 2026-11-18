import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { DownloadAccessError } from "../downloads.ts";
import { EnvelopeMutationError } from "../envelopes.ts";
import { ReminderMutationError } from "../reminders.ts";
import { DocumentImportError } from "../services/document-import.ts";
import { logRouteError } from "../security/logging.ts";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "../security/request.ts";
import { authorizeCrmRequest } from "./auth.ts";
import { CrmApiError } from "./errors.ts";
import { resendRecipientStatus } from "./resend-recipient.ts";
import { type CrmRequestMeta } from "./service.ts";

const NO_STORE = { "cache-control": "private, no-store" };

export function crmJson(body: unknown, status = 200): Response {
  return NextResponse.json(body, { headers: NO_STORE, status });
}

export function crmError(message: string, status: number): Response {
  return crmJson({ error: message }, status);
}

/** 401 unless the bearer token matches SIGNUDOC_API_KEY. */
export function requireCrmApiKey(request: Request): Response | null {
  if (authorizeCrmRequest(request)) {
    return null;
  }

  return NextResponse.json(
    { error: "Unauthorized." },
    {
      headers: {
        ...NO_STORE,
        "www-authenticate": 'Bearer realm="signudoc"',
      },
      status: 401,
    },
  );
}

export function crmRequestMeta(request: Request): CrmRequestMeta {
  return {
    ipAddress: getClientIpAddress(request.headers),
    userAgent: getRequestUserAgent(request.headers),
  };
}

function mapCrmError(error: unknown): Response | null {
  const recipient = resendRecipientStatus(error);
  if (recipient) return crmError(recipient.message, recipient.status);

  if (error instanceof CrmApiError) {
    return crmError(error.message, error.statusCode);
  }

  if (error instanceof ZodError) {
    return crmError(error.issues[0]?.message ?? "Invalid request.", 400);
  }

  if (error instanceof DocumentImportError) {
    return crmError(error.message, 400);
  }

  if (
    error instanceof EnvelopeMutationError ||
    error instanceof DownloadAccessError
  ) {
    return crmError(error.message, error.statusCode);
  }

  if (error instanceof ReminderMutationError) {
    return NextResponse.json(
      {
        error: error.message,
        ...(error.nextAvailableAt
          ? { nextAvailableAt: error.nextAvailableAt }
          : {}),
      },
      { headers: NO_STORE, status: error.statusCode },
    );
  }

  return null;
}

export async function withCrmErrors(
  request: Request,
  run: () => Promise<Response>,
): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    const mapped = mapCrmError(error);

    if (mapped) {
      return mapped;
    }

    logRouteError(error, {
      category: "crm_api_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure in the CRM API.",
      path: getRequestPathname(request),
    });

    return crmError("Unable to complete this request.", 500);
  }
}
