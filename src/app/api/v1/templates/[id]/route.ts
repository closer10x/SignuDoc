import { crmJson, requireCrmApiKey, withCrmErrors } from "@/lib/crm-api/http";
import { getTemplateForApi } from "@/lib/crm-api/templates";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const unauthorized = requireCrmApiKey(request);

  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;

  return withCrmErrors(request, async () => crmJson(await getTemplateForApi(id)));
}
