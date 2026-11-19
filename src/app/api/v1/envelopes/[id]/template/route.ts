import { z } from "zod";

import { crmJson, requireCrmApiKey, withCrmErrors } from "@/lib/crm-api/http";
import { saveDraftAsTemplate } from "@/lib/crm-api/templates";
import { envelopeTitleSchema } from "@/lib/schemas/common";

const bodySchema = z.object({
  name: envelopeTitleSchema,
  roleNames: z.array(z.string().trim().min(1).max(60)).min(1).max(10).optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

/** Keeps a draft's document, fields, and signing order as a template. */
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

    return crmJson(await saveDraftAsTemplate(id, parsed.data), 201);
  });
}
