import { getEvidenceDeps, getSessionUserId } from "@/lib/evidence/server"
import { handleSubmissionPost } from "@/lib/evidence/submissions-http"

export const dynamic = "force-dynamic"

/**
 * POST /api/submissions: records a submission, either a file or a GitHub repository + commit.
 *  - file: only after verifying the uploaded object exists at a path this server could have issued for this invoice and user,
 *    with an allowed size, MIME type and matching contents. Size and type come from the stored object, never the request.
 *  - github: the repository and commit are validated and normalised against GitHub's API (metadata only), and only the
 *    canonical values are stored. The submitter uploads nothing.
 * Retrying the same request returns the same submission. See lib/evidence/submissions-http.ts.
 */
export async function POST(request: Request) {
  return handleSubmissionPost(request, { userId: getSessionUserId, deps: getEvidenceDeps })
}
