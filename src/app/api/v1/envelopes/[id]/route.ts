import { crmJson, requireCrmApiKey, withCrmErrors } from "@/lib/crm-api/http";
import { getEnvelopeForApi } from "@/lib/crm-api/service";

type EnvelopeRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, context: EnvelopeRouteContext) {
  const unauthorized = requireCrmApiKey(request);

  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;

  return withCrmErrors(request, async () =>
    crmJson(await getEnvelopeForApi(id)),
  );
}
