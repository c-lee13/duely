import { NextResponse } from "next/server"
import { errorResponse, rejectCrossOrigin, toErrorResponse } from "@/lib/auth/http"
import { UploadUrlBody } from "@/lib/evidence/schemas"
import { getEvidenceDeps, getSessionUserId } from "@/lib/evidence/server"
import { initUpload } from "@/lib/evidence/service"

export const dynamic = "force-dynamic"

/**
 * POST /api/evidence/upload-url { invoiceId, fileName, fileSize, mimeType }
 * Authorizes the signed-in freelancer, then returns a server-generated path plus a signed, create-only upload
 * token for exactly that path. The file itself goes straight to private storage, not through this server.
 */
export async function POST(request: Request) {
  const blocked = rejectCrossOrigin(request)
  if (blocked) return blocked
  const body = UploadUrlBody.safeParse(await request.json().catch(() => null))
  if (!body.success) return errorResponse(400, "INVALID_INPUT", "Send invoiceId, fileName, fileSize and mimeType.")
  try {
    const grant = await initUpload(getEvidenceDeps(), { userId: await getSessionUserId(), ...body.data })
    return NextResponse.json(grant, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return toErrorResponse(e)
  }
}
