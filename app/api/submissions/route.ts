import { getEvidenceDeps, getSessionUserId } from "@/lib/evidence/server"
import { handleSubmissionPost } from "@/lib/evidence/submissions-http"
import { evaluationBody } from "@/lib/backend/handlers"
import { evaluateSubmission } from "@/lib/backend/evaluation"
import { scriptedMockEnabled } from "@/lib/backend/scripted-evaluator"
import { getBackendDeps } from "@/lib/backend/server"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * POST /api/submissions: records a submission, either a file or a GitHub repository + commit.
 *  - file: only after verifying the uploaded object exists at a path this server could have issued for this invoice and user,
 *    with an allowed size, MIME type and matching contents. Size and type come from the stored object, never the request.
 *  - github: the repository and commit are validated and normalised against GitHub's API (metadata only), and only the
 *    canonical values are stored. The submitter uploads nothing.
 * Retrying the same request returns the same submission. See lib/evidence/submissions-http.ts.
 *
 * With DUELY_MOCK_AI_EVALUATION=true a file submission is also evaluated in this same request (the scripted calculator
 * fixture only; anything else is simply not evaluated here), so the demo needs no separate evaluation call.
 */
export async function POST(request: Request) {
  return handleSubmissionPost(request, {
    userId: getSessionUserId,
    deps: getEvidenceDeps,
    autoEvaluate: scriptedMockEnabled()
      ? async (userId, submissionId) => {
          const t0 = Date.now()
          console.info(`[submit-evidence] server: auto-evaluating submission ${submissionId} (scripted demo mode)`)
          try {
            const r = await evaluateSubmission(getBackendDeps(), { userId, submissionId })
            console.info(`[submit-evidence] server: evaluation saved: model=${r.evaluation.model} score=${r.evaluation.score} passed=${r.evaluation.passed} duplicate=${r.duplicate} (${Date.now() - t0}ms)`)
            return evaluationBody(r)
          } catch (e) {
            console.warn(`[submit-evidence] server: auto-evaluation did not complete (${Date.now() - t0}ms): ${e instanceof Error ? e.message : "unknown"}`)
            throw e
          }
        }
      : undefined,
  })
}
