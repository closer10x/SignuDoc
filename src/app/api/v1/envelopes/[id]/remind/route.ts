import {
  crmJson,
  crmRequestMeta,
  requireCrmApiKey,
  withCrmErrors,
} from "@/lib/crm-api/http";
import { remindEnvelopeFromApi } from "@/lib/crm-api/service";

type RemindRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, context: RemindRouteContext) {
  const unauthorized = requireCrmApiKey(request);

  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;

  return withCrmErrors(request, async () =>
    crmJson(await remindEnvelopeFromApi(id, crmRequestMeta(request))),
  );
}
