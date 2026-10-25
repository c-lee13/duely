import { NextResponse } from "next/server"
import { errorResponse, rejectCrossOrigin, toErrorResponse } from "@/lib/auth/http"
import { SubmissionBody } from "@/lib/evidence/schemas"
import { getEvidenceDeps, getSessionUserId } from "@/lib/evidence/server"
import { registerSubmission } from "@/lib/evidence/service"

export const dynamic = "force-dynamic"

/**
 * POST /api/submissions { invoiceId, storagePath, fileName?, note? }
 * Records a submission only after verifying the uploaded object exists at a path this server could have issued
 * for this invoice and user, with an allowed size, MIME type and matching file contents. Size and type are taken
 * from the stored object, never from the request. Retrying the same path returns the same submission.
 */
export async function POST(request: Request) {
  const blocked = rejectCrossOrigin(request)
  if (blocked) return blocked
  const body = SubmissionBody.safeParse(await request.json().catch(() => null))
  if (!body.success) return errorResponse(400, "INVALID_INPUT", "Send invoiceId and storagePath.")
  try {
    const { submission, duplicate } = await registerSubmission(getEvidenceDeps(), { userId: await getSessionUserId(), ...body.data })
    return NextResponse.json(
      {
        submissionId: submission.id,
        invoiceId: submission.invoice_uuid,
        fileName: submission.file_name,
        fileSize: submission.file_size,
        mimeType: submission.mime_type,
        createdAt: submission.created_at,
        fundingVerifiedOnchain: submission.funding_verified_onchain,
        duplicate,
      },
      { status: duplicate ? 200 : 201, headers: { "Cache-Control": "no-store" } }
    )
  } catch (e) {
    return toErrorResponse(e)
  }
}
