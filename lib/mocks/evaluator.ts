/**
 * Deterministic SIMULATED evaluator. No model or OpenAI call is made.
 * The real evaluator (Track B, Phase 4) runs server-side and returns the same
 * EvaluationResult shape. The pass decision applies the server-side policy
 * below to the scores, never a client-supplied boolean.
 */
import type { EvaluationRecord, InvoiceDetail, Submission } from "@/lib/frontend/domain"
import { PASS_RULE_TEXT, PASS_SCORE_THRESHOLD } from "@/lib/frontend/eligibility"

const PASS_REASONS = [
  (file: string) => `The attached evidence (“${file}”) shows this deliverable in its final form.`,
  () => `The submission note and evidence describe this item as complete and within the agreed scope.`,
  (file: string) => `“${file}” includes material that directly addresses this requirement.`,
]

const FAIL_REASON = (file: string) =>
  `Nothing in “${file}” or the submission note shows this requirement was met. The evidence looks incomplete for this item.`

export function simulateEvaluation(args: {
  evaluationId: string
  invoice: InvoiceDetail
  submission: Submission
  outcome: "pass" | "fail"
  at: string
}): EvaluationRecord {
  const { invoice, submission, outcome } = args
  const file = submission.fileName
  const firstMandatory = invoice.criteria.findIndex((c) => c.mandatory)
  const failIndex = outcome === "fail" ? Math.max(firstMandatory, 0) : -1

  const criteriaResults = invoice.criteria.map((c, i) => {
    const passed = i !== failIndex
    return {
      criterion: c.text,
      passed,
      reason: passed ? PASS_REASONS[i % PASS_REASONS.length](file) : FAIL_REASON(file),
    }
  })

  const passedCount = criteriaResults.filter((r) => r.passed).length
  const ratio = passedCount / Math.max(criteriaResults.length, 1)
  // Deterministic score: high band for a full pass, low band when anything fails.
  const score =
    outcome === "pass"
      ? 86 + (invoice.criteria.length % 4) * 3
      : Math.min(64, Math.round(40 + ratio * 30))

  const mandatory = invoice.criteria.map((c) => c.mandatory)
  const mandatoryOk = criteriaResults.every((r, i) => r.passed || !mandatory[i])
  const passed = score >= PASS_SCORE_THRESHOLD && mandatoryOk

  const failed = criteriaResults.filter((r) => !r.passed).map((r) => `“${r.criterion}”`)
  const summary = passed
    ? `All ${criteriaResults.length} criteria appear satisfied by the submitted evidence. Recommend the work as complete; the client makes the final decision.`
    : `${failed.length} criterion${failed.length === 1 ? "" : "a"} not met: ${failed.join(", ")}. Recommend resubmitting with evidence covering the missing items.`

  return {
    evaluationId: args.evaluationId,
    invoiceId: invoice.invoiceId,
    submissionId: submission.submissionId,
    score,
    passed,
    criteriaResults,
    summary,
    state: "completed",
    criteriaHash: invoice.criteriaHash,
    criteriaVersion: invoice.criteriaVersion,
    model: "simulated-evaluator",
    promptVersion: "mock-v1",
    evaluatedAt: args.at,
    passRule: PASS_RULE_TEXT,
    mandatory,
    simulated: true,
  }
}
