import { handleEvaluate } from "@/lib/backend/handlers"
import { handlerContext } from "@/lib/backend/server"

export const dynamic = "force-dynamic"
export const maxDuration = 120

/** POST /api/evaluate { submissionId }: server-side evaluation. Never accepts a score or pass/fail from the client. */
export const POST = (request: Request) => handleEvaluate(request, handlerContext)
