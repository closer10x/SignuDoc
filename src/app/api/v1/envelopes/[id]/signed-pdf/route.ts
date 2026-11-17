import { requireCrmApiKey, withCrmErrors } from "@/lib/crm-api/http";
import { completedFileResponse } from "@/lib/crm-api/service";

type SignedPdfRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, context: SignedPdfRouteContext) {
  const unauthorized = requireCrmApiKey(request);

  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;

  return withCrmErrors(request, () => completedFileResponse(id, "signed"));
}
