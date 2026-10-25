import { NextResponse } from "next/server"
import { errorResponse, toErrorResponse } from "@/lib/auth/http"
import { SubmissionIdParam } from "@/lib/evidence/schemas"
import { getEvidenceDeps, getSessionUserId } from "@/lib/evidence/server"
import { getDownloadUrl } from "@/lib/evidence/service"

export const dynamic = "force-dynamic"

/**
 * GET /api/submissions/:id/download -> { url, expiresAt, fileName, mimeType, fileSize }
 * Only the client or freelancer of the submission's invoice (verified wallet) gets a 60-second signed URL.
 * Everyone else gets 404. URLs are minted per request and never stored.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = SubmissionIdParam.safeParse(await ctx.params)
  if (!params.success) return errorResponse(404, "NOT_FOUND", "Submission not found.")
  try {
    const grant = await getDownloadUrl(getEvidenceDeps(), { userId: await getSessionUserId(), submissionId: params.data.id })
    return NextResponse.json(grant, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return toErrorResponse(e)
  }
}
