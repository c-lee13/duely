import { PASS_SCORE_THRESHOLD } from "@/lib/frontend/eligibility"

/**
 * Deterministic, server-side scoring of an evaluator's per-criterion assessments.
 *
 * The evaluator (an AI model) only says how well the evidence supports each criterion: verified, partial or
 * unsupported. It never supplies a score or a verdict. This module turns those assessments into a score and a
 * verdict using weights agreed in advance, so the same inputs always produce the same output and the result can be
 * audited and re-computed. Pure: no I/O, no model call, no clock, no randomness. Call it only from server code.
 *
 * Rules
 *  - Weights are positive integers that total exactly 100.
 *  - verified = 1, partial = 0.5, unsupported = 0 of a criterion's weight.
 *  - A missing assessment, a duplicated/conflicting one, or any value other than the three exact strings is treated
 *    as `unsupported`. Uncertainty and silence never count as verified.
 *  - Pass      : score >= PASS_SCORE_THRESHOLD (80) AND every mandatory criterion is verified.
 *  - Fail      : any mandatory criterion is unsupported, OR score < REVIEW_FLOOR.
 *  - Needs Review: everything else (for example a mandatory criterion that is only partial, or a middling score).
 *  Only `Pass` is a positive recommendation; Needs Review and Fail never authorize anything.
 *
 * The Needs Review / Fail boundary (REVIEW_FLOOR = 50) is a PROPOSED value: the product requirement fixes only the
 * pass rule, not this band. Confirm it with the team before relying on it.
 */

export type Assessment = "verified" | "partial" | "unsupported"
export type Verdict = "Pass" | "Needs Review" | "Fail"

export const ASSESSMENT_FACTOR: Record<Assessment, number> = { verified: 1, partial: 0.5, unsupported: 0 }

/** Weights must total exactly this. */
export const TOTAL_WEIGHT = 100
/** Same threshold the rest of the product uses (lib/frontend/eligibility). */
export { PASS_SCORE_THRESHOLD }
/** Below this score the verdict is Fail, not Needs Review. PROPOSED; see the header comment. */
export const REVIEW_FLOOR = 50

export interface CriterionSpec {
  id: string
  text: string
  /** Positive integer share of the 100 points. */
  weight: number
  mandatory: boolean
}

/** What an evaluator reports. `assessment` is deliberately `unknown`: anything unrecognised is treated as unsupported. */
export interface CriterionAssessment {
  id: string
  assessment: unknown
  reason?: unknown
}

export interface CriterionScore {
  id: string
  text: string
  weight: number
  mandatory: boolean
  /** The assessment actually used (after treating missing/invalid input as unsupported). */
  assessment: Assessment
  /** What the evaluator reported, when that differs from `assessment`. */
  reportedAs?: string
  factor: number
  /** weight * factor; may end in .5 */
  points: number
  reason: string
}

export interface ScoreResult {
  /** Whole number 0..100, rounded DOWN from `exactScore`, so a rounded score can never pass when the exact one would not. */
  score: number
  /** Exact total; may end in .5 */
  exactScore: number
  verdict: Verdict
  /** True only for Pass. */
  passed: boolean
  criteria: CriterionScore[]
  /** Ids of mandatory criteria that are not verified. */
  mandatoryNotVerified: string[]
  /** Human-readable reasons for the verdict. */
  reasons: string[]
  /** Oddities in the evaluator's input that were handled conservatively (unknown ids, duplicates, invalid values). */
  warnings: string[]
  summary: string
}

export class InvalidScoringConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid scoring configuration:\n- ${problems.join("\n- ")}`)
    this.name = "InvalidScoringConfigError"
  }
}

/** Throws InvalidScoringConfigError unless the criteria and weights are usable. */
export function validateCriteria(criteria: readonly CriterionSpec[]): void {
  const problems: string[] = []
  if (!Array.isArray(criteria) || criteria.length === 0) throw new InvalidScoringConfigError(["At least one criterion is required."])

  const seen = new Set<string>()
  let total = 0
  criteria.forEach((c, i) => {
    const label = `criteria[${i}]${typeof c?.id === "string" && c.id ? ` (${c.id})` : ""}`
    if (typeof c?.id !== "string" || c.id.trim() === "") problems.push(`${label}: id must be a non-empty string.`)
    else if (seen.has(c.id)) problems.push(`${label}: duplicate id.`)
    else seen.add(c.id)
    if (typeof c?.text !== "string" || c.text.trim() === "") problems.push(`${label}: text must be a non-empty string.`)
    if (typeof c?.mandatory !== "boolean") problems.push(`${label}: mandatory must be true or false.`)
    if (typeof c?.weight !== "number" || !Number.isFinite(c.weight) || !Number.isInteger(c.weight) || c.weight < 1) {
      problems.push(`${label}: weight must be a positive whole number (got ${String(c?.weight)}).`)
    } else total += c.weight
  })
  // Only meaningful when every weight is usable; otherwise the per-criterion problems already explain it.
  if (problems.every((p) => !p.includes("weight")) && total !== TOTAL_WEIGHT) {
    problems.push(`Weights must total exactly ${TOTAL_WEIGHT} (they total ${total}).`)
  }
  if (problems.length) throw new InvalidScoringConfigError(problems)
}

const isAssessment = (v: unknown): v is Assessment => v === "verified" || v === "partial" || v === "unsupported"
const cleanReason = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 500) : "")

export function scoreEvaluation(criteria: readonly CriterionSpec[], assessments: readonly CriterionAssessment[]): ScoreResult {
  validateCriteria(criteria)

  const warnings: string[] = []
  const known = new Set(criteria.map((c) => c.id))
  const byId = new Map<string, CriterionAssessment[]>()
  for (const a of Array.isArray(assessments) ? assessments : []) {
    const id = typeof a?.id === "string" ? a.id : ""
    if (!known.has(id)) {
      warnings.push(`Ignored an assessment for unknown criterion ${JSON.stringify(a?.id)}.`)
      continue
    }
    byId.set(id, [...(byId.get(id) ?? []), a])
  }

  // Half-points keep every sum an exact integer (no floating-point error around the pass threshold).
  let halfPoints = 0
  const scored: CriterionScore[] = criteria.map((spec) => {
    const reports = byId.get(spec.id) ?? []
    let assessment: Assessment = "unsupported"
    let reportedAs: string | undefined
    let why: string

    if (reports.length === 0) {
      why = "No assessment was provided for this criterion, so it is treated as unsupported."
    } else if (reports.length > 1) {
      reportedAs = "conflicting"
      why = `The evaluator gave ${reports.length} assessments for this criterion, so it is treated as unsupported.`
      warnings.push(`Criterion ${spec.id} was assessed ${reports.length} times; treated as unsupported.`)
    } else if (!isAssessment(reports[0].assessment)) {
      reportedAs = JSON.stringify(reports[0].assessment) ?? "undefined"
      why = `The assessment ${reportedAs} is not one of verified, partial or unsupported, so it is treated as unsupported.`
      warnings.push(`Criterion ${spec.id} had an invalid assessment ${reportedAs}; treated as unsupported.`)
    } else {
      assessment = reports[0].assessment
      why =
        assessment === "verified"
          ? "The evidence clearly supports this criterion."
          : assessment === "partial"
            ? "The evidence supports only part of this criterion (counts as half)."
            : "The evidence does not support this criterion."
      const note = cleanReason(reports[0].reason)
      if (note) why += ` Evaluator note: ${note}`
    }

    const factor = ASSESSMENT_FACTOR[assessment]
    halfPoints += spec.weight * factor * 2
    return {
      id: spec.id,
      text: spec.text,
      weight: spec.weight,
      mandatory: spec.mandatory,
      assessment,
      ...(reportedAs ? { reportedAs } : {}),
      factor,
      points: spec.weight * factor,
      reason: why,
    }
  })

  const exactScore = halfPoints / 2
  const score = Math.floor(exactScore)
  const mandatoryNotVerified = scored.filter((c) => c.mandatory && c.assessment !== "verified")
  const mandatoryUnsupported = mandatoryNotVerified.filter((c) => c.assessment === "unsupported")
  const meetsThreshold = halfPoints >= PASS_SCORE_THRESHOLD * 2

  let verdict: Verdict
  const reasons: string[] = []
  if (meetsThreshold && mandatoryNotVerified.length === 0) {
    verdict = "Pass"
    reasons.push(`Score ${score}/100 meets the pass threshold of ${PASS_SCORE_THRESHOLD}, and every mandatory criterion is verified.`)
  } else if (mandatoryUnsupported.length > 0 || halfPoints < REVIEW_FLOOR * 2) {
    verdict = "Fail"
    if (mandatoryUnsupported.length > 0) {
      reasons.push(`Mandatory criteria not supported by the evidence: ${mandatoryUnsupported.map((c) => `"${c.text}"`).join(", ")}.`)
    }
    if (halfPoints < REVIEW_FLOOR * 2) reasons.push(`Score ${score}/100 is below ${REVIEW_FLOOR}.`)
  } else {
    verdict = "Needs Review"
    const partialMandatory = mandatoryNotVerified.filter((c) => c.assessment === "partial")
    if (partialMandatory.length > 0) {
      reasons.push(`Mandatory criteria only partly supported (all mandatory criteria must be verified to pass): ${partialMandatory.map((c) => `"${c.text}"`).join(", ")}.`)
    }
    if (!meetsThreshold) reasons.push(`Score ${score}/100 is below the pass threshold of ${PASS_SCORE_THRESHOLD}.`)
    reasons.push("A person should look at this before any decision.")
  }
  if (verdict === "Pass" && scored.some((c) => c.assessment !== "verified")) {
    reasons.push("Some optional criteria were not fully verified; see the per-criterion reasons.")
  }

  return {
    score,
    exactScore,
    verdict,
    passed: verdict === "Pass",
    criteria: scored,
    mandatoryNotVerified: mandatoryNotVerified.map((c) => c.id),
    reasons,
    warnings,
    summary: `${verdict}: ${score}/100. ${reasons[0]}`,
  }
}
