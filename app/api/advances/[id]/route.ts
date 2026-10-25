import { handleGetAdvance } from "@/lib/backend/handlers"
import { handlerContext } from "@/lib/backend/server"

export const dynamic = "force-dynamic"

/** GET /api/advances/:id: one advance request, settled against the chain (receipt + event) before it is returned. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleGetAdvance(request, handlerContext, await ctx.params)
}
