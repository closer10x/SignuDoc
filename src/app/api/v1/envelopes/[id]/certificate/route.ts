import { requireCrmApiKey, withCrmErrors } from "@/lib/crm-api/http";
import { completedFileResponse } from "@/lib/crm-api/service";

type CertificateRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, context: CertificateRouteContext) {
  const unauthorized = requireCrmApiKey(request);

  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;

  return withCrmErrors(request, () => completedFileResponse(id, "certificate"));
}
