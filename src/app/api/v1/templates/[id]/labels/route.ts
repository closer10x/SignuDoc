import { z } from "zod";

import { crmJson, requireCrmApiKey, withCrmErrors } from "@/lib/crm-api/http";
import {
  applyTemplateLabels,
  previewTemplateLabels,
} from "@/lib/crm-api/templates";

const bodySchema = z.object({
  labels: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        label: z.string().trim().min(1).max(120),
      }),
    )
    .max(200),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const unauthorized = requireCrmApiKey(request);

  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;

  return withCrmErrors(request, async () =>
    crmJson({ labels: await previewTemplateLabels(id) }),
  );
}

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

    return crmJson(await applyTemplateLabels(id, parsed.data.labels));
  });
}
