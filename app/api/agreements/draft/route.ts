import { handleDraftRequirements } from "@/lib/backend/requirements-draft-handler"
import { draftHandlerContext } from "@/lib/backend/draft-server"

export const dynamic = "force-dynamic"

/** POST /api/agreements/draft { description }: AI-drafted agreement text for the client to review. Creates nothing. */
export const POST = (request: Request) => handleDraftRequirements(request, draftHandlerContext)
