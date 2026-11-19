import { z } from "zod";

import {
  crmJson,
  crmRequestMeta,
  requireCrmApiKey,
  withCrmErrors,
} from "@/lib/crm-api/http";
import { createEnvelopeFromTemplate } from "@/lib/crm-api/templates";
import { emailSchema, envelopeTitleSchema, nameSchema } from "@/lib/schemas/common";

const bodySchema = z.object({
  callbackUrl: z.string().trim().max(2000).nullable().optional(),
  externalId: z.string().trim().max(200).nullable().optional(),
  message: z.string().trim().max(2000).nullable().optional(),
  send: z.boolean().optional(),
  signers: z
    .array(
      z.object({
        email: emailSchema,
        name: nameSchema,
        role: z.string().trim().min(1).max(60).optional(),
      }),
    )
    .min(1)
    .max(10),
  title: envelopeTitleSchema.optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const unauthorized = requireCrmApiKey(request);

  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;

  return withCrmErrors(request, async () => {
    const json = (await request.json().catch(() => null)) as unknown;
    const parsed = bodySchema.safeParse(json);

    if (!parsed.success) {
      throw parsed.error;
    }

    return crmJson(
      await createEnvelopeFromTemplate(id, parsed.data, crmRequestMeta(request)),
      201,
    );
  });
}
