import { NextResponse } from "next/server"
import { errorResponse, rejectCrossOrigin, toErrorResponse } from "@/lib/auth/http"
import { SubmissionBody } from "./schemas"
import { registerGithubSubmission, registerSubmission, type EvidenceDeps, type RegisteredSubmission } from "./service"

/**
 * POST /api/submissions. The route file is a one-line wrapper so tests can drive this with an injected session and
 * dependencies. Order: origin -> body validation -> (in the services) session, wallet, ownership, invoice state -> external calls.
 *
 * Two explicit shapes, never guessed:
 *   file   { invoiceId, storagePath, fileName?, note? }                    (type may be omitted or "file")
 *   github { type: "github", invoiceId, repositoryUrl, commitSha, note? }
 */
export interface SubmissionsContext {
  userId(): Promise<string | null>
  deps(): EvidenceDeps
  /**
   * Scripted-demo only (DUELY_MOCK_AI_EVALUATION): evaluate a just-saved FILE submission in the same request, persisting the
   * result through the normal evaluation service. Returns the evaluation body, or null when it doesn't apply or fails; a
   * failure never fails the submission (the freelancer can still request evaluation normally).
   */
  autoEvaluate?(userId: string | null, submissionId: string): Promise<unknown | null>
}

const view = ({ submission, duplicate }: RegisteredSubmission) => ({
  submissionId: submission.id,
  invoiceId: submission.invoice_uuid,
  fileName: submission.file_name,
  fileSize: submission.file_size,
  mimeType: submission.mime_type,
  createdAt: submission.created_at,
  fundingVerifiedOnchain: submission.funding_verified_onchain,
  // null for file submissions. Never user-supplied text: these are the canonical values the server stored.
  repositoryUrl: submission.repository_url,
  commitSha: submission.commit_sha,
  duplicate,
})

export async function handleSubmissionPost(request: Request, ctx: SubmissionsContext): Promise<Response> {
  const blocked = rejectCrossOrigin(request)
  if (blocked) return blocked
  const body = SubmissionBody.safeParse(await request.json().catch(() => null))
  if (!body.success) {
    return errorResponse(400, "INVALID_INPUT", "Send invoiceId and either storagePath (a file) or type \"github\" with repositoryUrl and commitSha.")
  }
  const t0 = Date.now()
  try {
    const userId = await ctx.userId()
    const data = body.data
    console.info(`[submit-evidence] server: POST /api/submissions received (${"type" in data && data.type === "github" ? "github" : "file"}); session ${userId ? "ok" : "missing"}`)
    const registered =
      "type" in data && data.type === "github"
        ? await registerGithubSubmission(ctx.deps(), { userId, invoiceId: data.invoiceId, repositoryUrl: data.repositoryUrl, commitSha: data.commitSha, note: data.note })
        : await registerSubmission(ctx.deps(), { userId, invoiceId: data.invoiceId, storagePath: (data as { storagePath: string }).storagePath, fileName: (data as { fileName?: string }).fileName, note: data.note })
    console.info(`[submit-evidence] server: submission ${registered.submission.id} ${registered.duplicate ? "already existed" : "saved"} (${Date.now() - t0}ms)`)
    const isFile = !("type" in data && data.type === "github")
    const evaluation = isFile && ctx.autoEvaluate ? await ctx.autoEvaluate(userId, registered.submission.id).catch(() => null) : null
    return NextResponse.json(evaluation ? { ...view(registered), evaluation } : view(registered), { status: registered.duplicate ? 200 : 201, headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return toErrorResponse(e)
  }
}
