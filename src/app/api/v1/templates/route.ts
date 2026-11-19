import { crmJson, requireCrmApiKey, withCrmErrors } from "@/lib/crm-api/http";
import { listTemplatesForApi } from "@/lib/crm-api/templates";

export async function GET(request: Request) {
  const unauthorized = requireCrmApiKey(request);

  if (unauthorized) {
    return unauthorized;
  }

  return withCrmErrors(request, async () =>
    crmJson({ templates: await listTemplatesForApi() }),
  );
}
