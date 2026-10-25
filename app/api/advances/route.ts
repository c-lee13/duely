import { handleAdvance } from "@/lib/backend/handlers"
import { handlerContext } from "@/lib/backend/server"

export const dynamic = "force-dynamic"

/** POST /api/advances { invoiceId }: explicit freelancer advance request. Never fakes a payment. */
export const POST = (request: Request) => handleAdvance(request, handlerContext)
