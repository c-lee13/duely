import { handleGetInvoice } from "@/lib/backend/handlers"
import { handlerContext } from "@/lib/backend/server"

export const dynamic = "force-dynamic"

/** GET /api/invoices/:id: participant-only invoice view with a verified chain snapshot when available. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleGetInvoice(request, handlerContext, await ctx.params)
}
