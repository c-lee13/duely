import { handleOperatorInvoices } from "@/lib/backend/handlers"
import { handlerContext } from "@/lib/backend/server"

export const dynamic = "force-dynamic"

/** GET /api/operator/invoices: the active deployment's Advanced/Disputed invoices, for an on-chain OPERATOR_ROLE wallet only. */
export const GET = (request: Request) => handleOperatorInvoices(request, handlerContext)
