import { splitLines, validateCitations, type CodeCitation, type CodeCriterionAssessment, type CodeReviewData } from "./code-review"
import type { SourceRetrieval } from "./github-source"
import { InvalidScoringConfigError, scoreEvaluation, type Assessment, type CriterionScore, type CriterionSpec, type ScoreResult, type Verdict } from "./scoring"

/**
 * Adapter from Gemini code-review output to Duely's existing deterministic scoring (lib/ai/scoring.ts).
 *
 * Pure (no I/O, no model call, no clock). Not connected to /api/evaluate.
 *
 *  - ALL AI output is untrusted. Only an assessment value (exactly verified / partial / unsupported), an id and
 *    evidence references are read from it. Any other field, such as a smuggled `score` or `verdict`, is ignored: the score
 *    and verdict come ONLY from `scoreEvaluation()`, using the frozen weights and mandatory flags passed in.
 *  - Strict about identity: the review must assess exactly the frozen criteria, each once. Unknown, missing, duplicated or
 *    non-string ids, and any assessment value outside the three allowed, reject the whole input (nothing is scored).
 *  - Evidence references are re-verified against the retrieved source, independent of the review module: the file must
 *    be a reviewed file of this retrieval, the line range must exist, and the quote must be on those lines. An invalid
 *    reference rejects the input. A verified/partial claim with NO evidence is scored as unsupported.
 *  - Incomplete retrieval (or source left out of the review) means automatic approval is BLOCKED: the verdict can never
 *    be Pass. The score is still reported, with the reasons.
 *  - Nothing here decides payment. `passed` is only the scoring verdict; any advance still needs the backend's own
 *    checks (explicit freelancer request, chain state, reserve) and an authorized signer.
 */

export type ScoringAdapterStage = "input" | "criteria" | "ids" | "assessments" | "evidence"

export interface CodeReviewCriterionBreakdown {
  id: string
  text: string
  weight: number
  mandatory: boolean
  /** The assessment actually scored (after any downgrade here). */
  assessment: Assessment
  /** What the review reported before this adapter's checks. */
  reviewedAs: Assessment
  factor: number
  points: number
  /** Deterministic explanation from the scoring engine (includes the reviewer's note). */
  reason: string
  explanation: string
  missingFunctionality: string | null
  uncertainty: string | null
  /** Verified source references backing the assessment. */
  evidence: CodeCitation[]
  adjustments: string[]
}

export interface CodeReviewScore {
  score: number
  exactScore: number
  verdict: Verdict
  /** True only for Pass AND no blocked approval. Advisory: it is not payment eligibility. */
  passed: boolean
  /** True when the evidence is not sufficient for any automatic approval (Pass is then impossible). */
  automaticApprovalBlocked: boolean
  blockedReasons: string[]
  criteria: CodeReviewCriterionBreakdown[]
  mandatoryNotVerified: string[]
  reasons: string[]
  warnings: string[]
  summary: string
  repository: string
  commitSha: string
  /** The unmodified result of scoreEvaluation(), for audit. */
  scoring: ScoreResult
}

export type CodeReviewScoreResult = { ok: true; data: CodeReviewScore } | { ok: false; stage: ScoringAdapterStage; problems: string[] }

const failure = (stage: ScoringAdapterStage, problems: string[]): CodeReviewScoreResult => ({ ok: false, stage, problems })
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isAssessment = (v: unknown): v is Assessment => v === "verified" || v === "partial" || v === "unsupported"
const SHA_RE = /^[0-9a-f]{40}$/

export function scoreCodeReview(review: CodeReviewData, specs: readonly CriterionSpec[], retrieval: SourceRetrieval): CodeReviewScoreResult {
  // Shape of everything we are handed. AI output is read field by field, never spread or trusted wholesale.
  if (!isObj(review) || !Array.isArray(review.assessments) || !Array.isArray(review.filesReviewed) || !Array.isArray(review.filesOmitted)) {
    return failure("input", ["A code-review result is required."])
  }
  if (!isObj(retrieval) || !Array.isArray(retrieval.files) || typeof retrieval.complete !== "boolean") {
    return failure("input", ["The source retrieval the review was based on is required."])
  }
  if (typeof review.commitSha !== "string" || !SHA_RE.test(review.commitSha) || review.commitSha !== retrieval.commitSha || review.repository !== retrieval.repository) {
    return failure("input", ["The review and the source retrieval are not for the same repository and commit."])
  }

  // Frozen criteria + weights: validated by the scoring engine's own rules.
  const problems: string[] = []
  try {
    scoreEvaluation(specs, [])
  } catch (e) {
    if (e instanceof InvalidScoringConfigError) return failure("criteria", e.problems)
    throw e
  }

  // Identity: exactly the frozen criteria, each once.
  const wanted = new Set(specs.map((s) => s.id))
  const byId = new Map<string, CodeCriterionAssessment>()
  for (const [i, a] of review.assessments.entries()) {
    const id = isObj(a) ? a.id : undefined
    if (typeof id !== "string" || id === "") problems.push(`assessments[${i}]: the criterion id must be a non-empty string.`)
    else if (!wanted.has(id)) problems.push(`assessments[${i}]: unknown criterion id ${JSON.stringify(id)}.`)
    else if (byId.has(id)) problems.push(`assessments[${i}]: criterion ${JSON.stringify(id)} is assessed more than once.`)
    else byId.set(id, a as CodeCriterionAssessment)
  }
  for (const s of specs) if (!byId.has(s.id) && !problems.some((p) => p.includes(JSON.stringify(s.id)))) problems.push(`criterion ${JSON.stringify(s.id)} has no assessment.`)
  if (problems.length) return failure("ids", problems)

  // Values: only the three exact strings are accepted.
  for (const s of specs) {
    const a = byId.get(s.id) as CodeCriterionAssessment
    if (!isAssessment(a.assessment)) problems.push(`criterion ${JSON.stringify(s.id)}: assessment ${JSON.stringify(a.assessment)} is not verified, partial or unsupported.`)
    if (!isAssessment(a.modelAssessment)) problems.push(`criterion ${JSON.stringify(s.id)}: the reviewer's original assessment is missing or invalid.`)
  }
  if (problems.length) return failure("assessments", problems)

  // Evidence: every reference must really exist in the submitted, reviewed source.
  const sources = new Map<string, string[]>()
  const reviewed = new Set(review.filesReviewed)
  for (const f of retrieval.files) if (reviewed.has(f.path)) sources.set(f.path, splitLines(f.content))
  const verifiedEvidence = new Map<string, CodeCitation[]>()
  for (const s of specs) {
    const a = byId.get(s.id) as CodeCriterionAssessment
    const refs = Array.isArray(a.evidence) ? a.evidence : null
    if (!refs) {
      problems.push(`criterion ${JSON.stringify(s.id)}: evidence must be a list.`)
      continue
    }
    const shaped = refs.map((r) => (isObj(r) && typeof r.path === "string" && Number.isInteger(r.startLine) && Number.isInteger(r.endLine) && typeof r.quote === "string" ? r : null))
    if (shaped.some((r) => r === null)) {
      problems.push(`criterion ${JSON.stringify(s.id)}: an evidence reference is malformed.`)
      continue
    }
    const check = validateCitations(
      (shaped as CodeCitation[]).map((r) => ({ path: r.path, start_line: r.startLine, end_line: r.endLine, quote: r.quote })),
      sources,
      s.id
    )
    if (check.notes.length) problems.push(...check.notes.map((n) => `${n.replace(/ and was dropped\.$/, "")}: rejected.`))
    else verifiedEvidence.set(s.id, check.valid)
  }
  if (problems.length) return failure("evidence", problems)

  // A positive claim with no verified reference is not evidence: score it as unsupported.
  const breakdownExtras = new Map<string, { assessment: Assessment; adjustments: string[] }>()
  const forScoring = specs.map((s) => {
    const a = byId.get(s.id) as CodeCriterionAssessment
    const adjustments = Array.isArray(a.adjustments) ? a.adjustments.filter((x): x is string => typeof x === "string").slice(0, 10) : []
    let assessment: Assessment = a.assessment
    if (assessment !== "unsupported" && (verifiedEvidence.get(s.id) ?? []).length === 0) {
      assessment = "unsupported"
      adjustments.push("Scored as unsupported: no verified source reference backed the claim.")
    }
    breakdownExtras.set(s.id, { assessment, adjustments })
    return { id: s.id, assessment, reason: typeof a.explanation === "string" ? a.explanation : "" }
  })

  // The ONLY source of the score and verdict.
  const scoring = scoreEvaluation(specs, forScoring)

  // Insufficient evidence blocks automatic approval, from facts re-derived here, not from the review's own flags alone.
  const blockedReasons: string[] = []
  if (!retrieval.complete) {
    blockedReasons.push("Source retrieval was incomplete.")
    for (const r of Array.isArray(retrieval.incompleteReasons) ? retrieval.incompleteReasons : []) if (typeof r === "string") blockedReasons.push(r.slice(0, 300))
  }
  if (review.filesOmitted.length > 0) blockedReasons.push(`${review.filesOmitted.length} retrieved file(s) were not included in the review.`)
  if (review.evidenceSufficient !== true) blockedReasons.push("The code review itself reported insufficient evidence.")
  const blocked = blockedReasons.length > 0

  const wouldPass = scoring.verdict === "Pass"
  const verdict: Verdict = blocked && wouldPass ? "Needs Review" : scoring.verdict
  const reasons = [...scoring.reasons]
  if (blocked && wouldPass) {
    reasons.unshift(`Automatic approval is blocked because the reviewed source is incomplete (${blockedReasons[0]}). A person must review this.`)
  }
  const score: CodeReviewScore = {
    score: scoring.score,
    exactScore: scoring.exactScore,
    verdict,
    passed: verdict === "Pass",
    automaticApprovalBlocked: blocked,
    blockedReasons,
    criteria: scoring.criteria.map((c: CriterionScore): CodeReviewCriterionBreakdown => {
      const a = byId.get(c.id) as CodeCriterionAssessment
      const extra = breakdownExtras.get(c.id) as { assessment: Assessment; adjustments: string[] }
      return {
        id: c.id,
        text: c.text,
        weight: c.weight,
        mandatory: c.mandatory,
        assessment: c.assessment,
        reviewedAs: a.modelAssessment,
        factor: c.factor,
        points: c.points,
        reason: c.reason,
        explanation: typeof a.explanation === "string" ? a.explanation : "",
        missingFunctionality: typeof a.missingFunctionality === "string" ? a.missingFunctionality : null,
        uncertainty: typeof a.uncertainty === "string" ? a.uncertainty : null,
        evidence: verifiedEvidence.get(c.id) ?? [],
        adjustments: extra.adjustments,
      }
    }),
    mandatoryNotVerified: scoring.mandatoryNotVerified,
    reasons,
    warnings: scoring.warnings,
    summary: `${verdict}: ${scoring.score}/100. ${reasons[0]}`,
    repository: retrieval.repository,
    commitSha: retrieval.commitSha,
    scoring,
  }
  return { ok: true, data: score }
}
