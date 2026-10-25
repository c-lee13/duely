import { handleCreateInvoice, handleListInvoices } from "@/lib/backend/handlers"
import { handlerContext } from "@/lib/backend/server"

export const dynamic = "force-dynamic"

/** GET /api/invoices: the signed-in user's own invoices (participant-only). */
export const GET = (request: Request) => handleListInvoices(request, handlerContext)

/** POST /api/invoices: off-chain registration of an invoice created on-chain. Logic: lib/backend/invoices.ts */
export const POST = (request: Request) => handleCreateInvoice(request, handlerContext)
