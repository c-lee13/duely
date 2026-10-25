import { PASS_SCORE_THRESHOLD } from "./eligibility"
import type { CriterionResult, EvaluationRecord } from "./domain"

/**
 * Presentation helpers for a stored GitHub code evaluation. They only re-read what the backend already stored and returned
 * (score, passed, per-criterion detail, summary); nothing is recomputed from scratch and no score is ever invented.
 *
 * The server stores the verdict and any "automatic approval blocked" reasons inside the summary text, so they are read back
 * from there with strict patterns that must agree with the stored score and pass flag. If the text is not in the expected
 * shape, the helpers fall back to what the structured fields alone support. Pure and browser-safe.
 */

export type Verdict = "Pass" | "Needs Review" | "Fail"

/** Proposed boundary shared with the server (lib/ai/scoring.ts REVIEW_FLOOR). Only used when the summary can't be read. */
const REVIEW_FLOOR = 50

export function isGithubEvaluation(e: EvaluationRecord | undefined): e is EvaluationRecord & { source: NonNullable<EvaluationRecord["source"]> } {
  return !!e && e.state === "completed" && e.source?.kind === "github"
}

/** The verdict. A stored `passed` of true is the only Pass; the summary's wording may never upgrade a non-pass. */
export function verdictOf(e: Pick<EvaluationRecord, "summary" | "score" | "passed" | "criteriaResults" | "mandatory">): Verdict {
  if (e.passed) return "Pass"
  const m = /^(Pass|Needs Review|Fail) \((\d{1,3})\/100\)/.exec(e.summary)
  if (m && Number(m[2]) === e.score && m[1] !== "Pass") return m[1] as Verdict
  const mandatoryUnsupported = e.criteriaResults.some((r, i) => e.mandatory?.[i] && r.assessment === "unsupported")
  return mandatoryUnsupported || e.score < REVIEW_FLOOR ? "Fail" : "Needs Review"
}

const BLOCK_MARK = "Automatic approval blocked: "
const UNVERIFIED_NOTE = /\s*(\d+) cited source reference\(s\) could not be verified and were not counted\.\s*$/

/** Why automatic approval was blocked (incomplete source), as separate sentences; empty when it was not blocked. */
export function blockedReasonsOf(summary: string): string[] {
  const i = summary.indexOf(BLOCK_MARK)
  if (i < 0) return []
  const text = summary.slice(i + BLOCK_MARK.length).replace(UNVERIFIED_NOTE, "").trim()
  return text.split(/(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean).slice(0, 12)
}

/** How many cited references the server could not verify (and therefore did not count). */
export function unverifiedReferenceCount(summary: string): number {
  const m = UNVERIFIED_NOTE.exec(summary)
  return m ? Number(m[1]) : 0
}

/** Scoring notes only: the summary without its verdict prefix, repository mention, blocked-approval and unverified-reference parts. */
export function scoringNotesOf(summary: string): string {
  let t = summary.replace(/^(Pass|Needs Review|Fail) \(\d{1,3}\/100\)(?: for \S+@[0-9a-f]{40})?\.?\s*/, "")
  const i = t.indexOf(BLOCK_MARK)
  if (i >= 0) t = t.slice(0, i)
  return t.replace(UNVERIFIED_NOTE, "").trim()
}

/** Why this is not a Pass, from the stored structured data (threshold and mandatory criteria), independent of the summary text. */
export function whyNotPassOf(e: Pick<EvaluationRecord, "score" | "passed" | "criteriaResults" | "mandatory">): string[] {
  if (e.passed) return []
  const reasons: string[] = []
  const names = e.criteriaResults.filter((r, i) => e.mandatory?.[i] && r.assessment !== "verified").map((r) => r.criterion)
  if (names.length) reasons.push(`Every mandatory criterion must be verified. Not verified: ${names.map((n) => `“${n}”`).join(", ")}.`)
  if (e.score < PASS_SCORE_THRESHOLD) reasons.push(`The score ${e.score} is below the pass threshold of ${PASS_SCORE_THRESHOLD}.`)
  return reasons
}

export interface ReasonParts {
  explanation: string
  missing: string | null
  uncertain: string | null
  notes: string[]
}

const LEAD = /^(?:The evidence clearly supports this criterion\.|The evidence supports only part of this criterion \(counts as half\)\.|The evidence does not support this criterion\.)\s*/
const NOTE_MARK = "Evaluator note: "
const NOTES = [/\s(Downgraded to unsupported: [^.]*\.)/, /\s(Capped at partial: [^.]*\.)/, /\s(Scored as unsupported: [^.]*\.)/]

/**
 * The stored `reason` is one string: the engine's sentence, then the reviewer's explanation, then "Missing: …", "Uncertain: …"
 * and any adjustment notes. Splits it back into labelled parts. Falls back to the whole text as the explanation.
 */
export function splitReason(reason: string): ReasonParts {
  let rest = reason.trim()
  const notes: string[] = []
  for (const re of NOTES) {
    const m = re.exec(` ${rest}`)
    if (m) {
      notes.push(m[1].trim())
      rest = ` ${rest}`.replace(m[0], "").trim()
    }
  }
  let uncertain: string | null = null
  let missing: string | null = null
  const u = rest.lastIndexOf(" Uncertain: ")
  if (u >= 0) {
    uncertain = rest.slice(u + " Uncertain: ".length).trim() || null
    rest = rest.slice(0, u)
  }
  const mi = rest.lastIndexOf(" Missing: ")
  if (mi >= 0) {
    missing = rest.slice(mi + " Missing: ".length).trim() || null
    rest = rest.slice(0, mi)
  }
  const n = rest.indexOf(NOTE_MARK)
  const explanation = (n >= 0 ? rest.slice(n + NOTE_MARK.length) : rest.replace(LEAD, "")).trim()
  return { explanation: explanation || reason.trim(), missing, uncertain, notes }
}

/** "17" / "16.5" — points can end in .5. */
export const formatPoints = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

export const earnedFraction = (r: Pick<CriterionResult, "weight" | "points">) =>
  r.weight && r.points !== undefined ? Math.max(0, Math.min(100, (r.points / r.weight) * 100)) : 0
