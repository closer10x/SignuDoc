import { requireCrmApiKey, withCrmErrors } from "@/lib/crm-api/http";
import { readTemplatePdf } from "@/lib/crm-api/templates";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const unauthorized = requireCrmApiKey(request);

  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await context.params;

  return withCrmErrors(request, async () => {
    const document = await readTemplatePdf(id);

    return new Response(Buffer.from(document.bytes), {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/pdf",
      },
    });
  });
}
