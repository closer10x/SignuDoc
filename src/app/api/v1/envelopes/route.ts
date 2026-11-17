import {
  requireCrmApiKey,
  crmJson,
  crmRequestMeta,
  withCrmErrors,
} from "@/lib/crm-api/http";
import { readCreateEnvelopeRequest } from "@/lib/crm-api/request";
import { createEnvelopeFromApi } from "@/lib/crm-api/service";

export async function POST(request: Request) {
  const unauthorized = requireCrmApiKey(request);

  if (unauthorized) {
    return unauthorized;
  }

  return withCrmErrors(request, async () => {
    const input = await readCreateEnvelopeRequest(request);

    return crmJson(
      await createEnvelopeFromApi(input, crmRequestMeta(request)),
      201,
    );
  });
}
