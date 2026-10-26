import type { Bytes32 } from "@/lib/frontend/domain"
import { PASS_RULE_TEXT, PASS_SCORE_THRESHOLD } from "@/lib/frontend/eligibility"
import { UUID_RE } from "@/lib/evidence/policy"
import { ApiError } from "./api-error"
import { loadInvoiceAsParty, requireUser, requireVerifiedWallets } from "./access"
import { toEvaluationView, type EvaluationView } from "./invoices"
import { DEMO_MODEL, DEMO_PROMPT_VERSION } from "./demo-evaluator"
import { DuplicateEvaluationError, UnsupportedEvidenceError, type BackendDeps, type EvaluationData, type EvaluatorOutput } from "./ports"

/** How much of the stored evidence an evaluator is handed. */
/** A "running" evaluation older than this is treated as abandoned and may be retried. */
export const STALE_RUNNING_MS = 3 * 60_000

export const EVALUATION_EVIDENCE_BYTES = 256 * 1024

/**
 * The pass decision is made HERE, by server policy, from the evaluator's per-criterion results. Neither the browser
 * nor the evaluator supplies a `passed` flag. Policy: score >= PASS_SCORE_THRESHOLD and every mandatory criterion met
 * (a proposed demo rule pending team confirmation, shared with the UI via lib/frontend/eligibility).
 */
export function decidePassed(score: number, results: Array<{ passed: boolean; mandatory: boolean }>): boolean {
  return score >= PASS_SCORE_THRESHOLD && results.every((r) => !r.mandatory || r.passed)
}

/** Rejects an evaluator output that does not line up with the FROZEN criteria; binds results to the stored criteria text and order. */
function validateOutput(out: EvaluatorOutput, criteria: Array<{ text: string; mandatory: boolean }>) {
  if (!Number.isInteger(out.score) || out.score < 0 || out.score > 100) throw new Error("score out of range")
  if (out.criteriaResults.length !== criteria.length) throw new Error("wrong number of criterion results")
  if (out.criteriaResults.some((r, i) => r.criterion !== criteria[i].text || typeof r.passed !== "boolean")) {
    throw new Error("criterion results do not match the frozen criteria")
  }
  if (!out.summary || !out.model || !out.promptVersion) throw new Error("incomplete evaluator output")
  if (out.passBlocked !== undefined && (!Array.isArray(out.passBlocked) || out.passBlocked.some((r) => typeof r !== "string"))) {
    throw new Error("invalid pass-block reasons")
  }
}

export interface EvaluateResult {
  evaluation: EvaluationView
  invoiceId: string
  /** True when a completed evaluation already existed for this submission and was returned unchanged. */
  duplicate: boolean
}

export async function evaluateSubmission(deps: BackendDeps, input: { userId: string | null; submissionId: string }): Promise<EvaluateResult> {
  const t0 = Date.now()
  const step = (label: string) => console.info(`[submit-evidence] evaluate: ${label} (+${Date.now() - t0}ms)`)
  const userId = requireUser(input.userId)
  const wallets = await requireVerifiedWallets(deps.db, userId)
  if (!UUID_RE.test(input.submissionId)) throw new ApiError("NOT_FOUND", "Submission not found.")

  step("verified wallets; loading submission")
  const submission = await deps.db.getSubmission(input.submissionId)
  if (!submission) throw new ApiError("NOT_FOUND", "Submission not found.")
  const { invoice, isFreelancer } = await loadInvoiceAsParty(deps.db, userId, submission.invoice_uuid, deps.scope)
  if (!isFreelancer) throw new ApiError("FORBIDDEN", "Only the freelancer who made this submission can request its evaluation.")
  if (!wallets.includes(submission.freelancer_address)) throw new ApiError("FORBIDDEN", "This submission was made by a different wallet.")

  step("ownership ok; checking latest submission")
  // Only the latest submission is evaluated, so an old result can never stand in for newer evidence.
  const submissions = await deps.db.listSubmissions(invoice.id)
  if (submissions[0]?.id !== submission.id) {
    throw new ApiError("STALE_SUBMISSION", "A newer submission exists for this invoice. Only the latest submission can be evaluated.")
  }

  let existing = await deps.db.findLiveEvaluation(submission.id)
  if (existing?.state === "completed") return { evaluation: toEvaluationView(existing), invoiceId: invoice.id, duplicate: true }
  // A run whose process died (restart, crash, timeout) would otherwise block every retry forever. No real evaluation takes this long.
  if (existing?.state === "running" && Date.now() - Date.parse(existing.created_at) > STALE_RUNNING_MS) {
    await deps.db.failEvaluation(existing.id, "evaluation abandoned (no result after 3 minutes)")
    existing = null
  }
  if (existing?.state === "running") throw new ApiError("EVALUATION_IN_PROGRESS", "This submission is already being evaluated.")

  if (deps.evaluator.mode === "disabled") {
    throw new ApiError("EVALUATOR_UNAVAILABLE", "Automatic evaluation isn't available yet.")
  }

  step("loading criteria")
  const criteria = await deps.db.getCriteria(invoice.id)
  if (criteria.length !== invoice.criteria_count) throw new ApiError("CRITERIA_INCOMPLETE", "This invoice's acceptance criteria aren't fully recorded.")
  // A GitHub submission carries its repository and commit in the database; the evaluator uses those and never the evidence file,
  // so the file is not read (and its absence is not an error). File submissions read the stored object as before.
  const github = submission.repository_url !== null || submission.commit_sha !== null
  if (github && deps.evaluator.mode === "demo") {
    throw new ApiError("EVIDENCE_NOT_EVALUABLE", "The development evaluator can't review GitHub submissions.")
  }
  const evidence = github ? new Uint8Array(0) : await deps.objects.readPrefix(submission.storage_path, EVALUATION_EVIDENCE_BYTES)
  if (!evidence) throw new ApiError("UPLOAD_NOT_FOUND", "The evidence file for this submission couldn't be found.")

  step("evidence read; creating running evaluation")
  let running: EvaluationData
  try {
    running = await deps.db.createRunningEvaluation({
      submission_id: submission.id,
      invoice_uuid: invoice.id,
      criteria_hash: invoice.criteria_hash,
      criteria_version: invoice.criteria_version,
      model: deps.evaluator.mode === "demo" ? DEMO_MODEL : "pending",
      prompt_version: deps.evaluator.mode === "demo" ? DEMO_PROMPT_VERSION : "pending",
      pass_rule: PASS_RULE_TEXT,
      simulated: deps.evaluator.mode === "demo",
    })
  } catch (e) {
    if (e instanceof DuplicateEvaluationError) {
      const winner = await deps.db.findLiveEvaluation(submission.id)
      if (winner?.state === "completed") return { evaluation: toEvaluationView(winner), invoiceId: invoice.id, duplicate: true }
      throw new ApiError("EVALUATION_IN_PROGRESS", "This submission is already being evaluated.")
    }
    throw e
  }

  step("running evaluator")
  try {
    const out = await deps.evaluator.evaluate({
      invoiceId: invoice.id,
      criteriaHash: invoice.criteria_hash as Bytes32,
      criteriaVersion: invoice.criteria_version,
      criteria: criteria.map((c) => ({ id: c.criterion_key, text: c.text, mandatory: c.mandatory })),
      submission: {
        id: submission.id,
        fileName: submission.file_name,
        mimeType: submission.mime_type,
        fileSize: submission.file_size,
        ...(github ? { github: { repositoryUrl: submission.repository_url, commitSha: submission.commit_sha } } : {}),
      },
      evidence,
    })
    step(`evaluator returned (model ${out.model}); saving`)
    validateOutput(out, criteria)
    // A development evaluator can never produce a result that looks real.
    if (deps.evaluator.mode === "demo" && !out.simulated) throw new Error("demo evaluator returned a non-simulated result")
    const results = out.criteriaResults.map((r, i) => ({
      criterion: r.criterion,
      passed: r.passed,
      reason: r.reason,
      mandatory: criteria[i].mandatory,
      // Audit detail from classifying evaluators; absent for the deterministic demo evaluator.
      ...(r.assessment ? { assessment: r.assessment } : {}),
      ...(r.evidenceQuote !== undefined ? { evidenceQuote: r.evidenceQuote } : {}),
      ...(r.weight !== undefined ? { weight: r.weight } : {}),
      ...(r.points !== undefined ? { points: r.points } : {}),
      // Source-code references and what was reviewed (GitHub evaluations); absent for text evidence.
      ...(r.evidence ? { evidence: r.evidence } : {}),
      ...(out.source ? { source: out.source } : {}),
    }))
    const final = await deps.db.finalizeEvaluation(running.id, {
      model: out.model,
      prompt_version: out.promptVersion,
      simulated: out.simulated,
      score: out.score,
      // An evaluator may veto a pass (incomplete source) but can never create one: the server rule must also hold.
      passed: !(out.passBlocked && out.passBlocked.length > 0) && decidePassed(out.score, results),
      criteria_results: results,
      summary: out.summary,
    })
    return { evaluation: toEvaluationView(final), invoiceId: invoice.id, duplicate: false }
  } catch (e) {
    // The failure is recorded (and retryable) but its detail is not echoed: it could contain evidence content.
    await deps.db.failEvaluation(running.id, e instanceof Error ? e.message.slice(0, 200) : "evaluation failed").catch(() => undefined)
    if (e instanceof UnsupportedEvidenceError) throw new ApiError("EVIDENCE_NOT_EVALUABLE", e.message)
    throw new ApiError("EVALUATOR_FAILED", "The evaluation couldn't be completed. Try again.")
  }
}
