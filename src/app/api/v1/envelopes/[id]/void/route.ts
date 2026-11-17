import {
  crmJson,
  crmRequestMeta,
  requireCrmApiKey,
  withCrmErrors,
} from "@/lib/crm-api/http";
import { voidEnvelopeFromApi } from "@/lib/crm-api/service";

type VoidRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, context: VoidRouteContext) {
  const unauthorized = requireCrmApiKey(request);

  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    reason?: unknown;
  } | null;

  return withCrmErrors(request, async () =>
    crmJson(
      await voidEnvelopeFromApi(
        id,
        typeof body?.reason === "string" ? body.reason : null,
        crmRequestMeta(request),
      ),
    ),
  );
}
