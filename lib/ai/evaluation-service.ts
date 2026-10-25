import "server-only"
import { assessEvidence, equalWeights, PROMPT_VERSION, RESPONSE_SCHEMA, type GenerateFn } from "./assessment"
import { CODE_REVIEW_PROMPT_VERSION, CODE_REVIEW_RESPONSE_SCHEMA, reviewSourceCode } from "./code-review"
import { scoreCodeReview } from "./code-review-scoring"
import { createGeminiClient, getGeminiConfig, GeminiConfigError, type GeminiConfig } from "./gemini"
import { parseGithubDeclaration } from "./github-declaration"
import { retrieveGithubSource } from "./github-source"
import { validateGithubSubmission, type GithubErrorCode } from "./github-submission"
import { disabledEvaluator, UnsupportedEvidenceError, type Evaluator, type EvaluatorInput, type EvaluatorOutput } from "@/lib/backend/ports"
import type { CriterionSpec } from "./scoring"

/**
 * The real evaluator behind POST /api/evaluate (server-only). It plugs into the existing `Evaluator` port, so the route
 * keeps doing authentication, wallet checks, frozen-criteria loading, evidence reading, persistence and the final
 * pass decision. This module only turns "frozen criteria + stored evidence" into an `EvaluatorOutput`:
 *
 *   Gemini classifies each criterion -> evidence quotes are checked -> lib/ai/scoring.ts calculates the score.
 *
 * Gemini never supplies a score or verdict. Nothing here touches payments, the chain, the signer or the database; an
 * evaluation is only a stored recommendation, and a separate explicit advance request is still required for any payment.
 */

/** The frozen criteria carry no weights (there is no weight column), so they are weighted equally. See equalWeights(). */
const TEXT_EVIDENCE = new Set(["text/plain", "text/markdown"])

/** Gemini answered, but not in the required shape. The evaluation is recorded as an error and can be retried. */
export class EvaluationResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EvaluationResponseError"
  }
}

/** GitHub validation failures the submitter can fix (wrong URL, private repo, missing commit): reported as 422. The rest are retryable. */
const SUBMITTER_FIXABLE: ReadonlySet<GithubErrorCode> = new Set(["INVALID_URL", "INVALID_SHA", "REPO_NOT_FOUND", "REPO_NOT_PUBLIC", "COMMIT_NOT_FOUND"])
/** Retrieval skips that mean "try again later", not "this source can't be read". */
const TRANSIENT_SKIPS = new Set(["rate_limited", "unavailable", "api_error", "bad_response"])

export interface GithubEvaluationOptions {
  /** One Gemini call that returns the code-review JSON (CODE_REVIEW_RESPONSE_SCHEMA). */
  generate: GenerateFn
  /** GitHub API access; defaults to the global fetch. Tests inject a mock. */
  fetch?: typeof fetch
  /** Optional GitHub token for rate limits. Sent only as a request header; never stored, logged or returned. */
  token?: string
}

export interface GeminiEvaluatorOptions {
  generate: GenerateFn
  model: string
  /** Enables GitHub code evaluation for submissions that explicitly declare a repository and commit. */
  github?: GithubEvaluationOptions
}

/**
 * GitHub path: explicit declaration -> validate repository + commit -> retrieve source at that exact commit (as data, never
 * run) -> Gemini code review -> deterministic scoring. Incomplete or truncated source can never be a Pass.
 */
async function evaluateGithub(
  input: EvaluatorInput,
  declaration: { repositoryUrl: string; commitSha: string },
  gh: GithubEvaluationOptions,
  model: string
): Promise<EvaluatorOutput> {
  const http = { fetch: gh.fetch, token: gh.token }

  const validated = await validateGithubSubmission(declaration.repositoryUrl, declaration.commitSha, http)
  if (!validated.ok) {
    if (SUBMITTER_FIXABLE.has(validated.error.code)) throw new UnsupportedEvidenceError(validated.error.message)
    throw new EvaluationResponseError(`GitHub validation failed (${validated.error.code})`)
  }
  if (validated.data.sourceFiles.length === 0) {
    throw new UnsupportedEvidenceError("No source-code files were found at that commit, so there is nothing to evaluate.")
  }

  const retrieved = await retrieveGithubSource(validated.data, validated.data.sourceFiles, http)
  if (!retrieved.ok) throw new EvaluationResponseError(`Source retrieval failed (${retrieved.error.code})`)
  const retrieval = retrieved.data
  if (retrieval.files.length === 0) {
    if (retrieval.skipped.some((s) => TRANSIENT_SKIPS.has(s.reason))) throw new EvaluationResponseError("Source retrieval failed (GitHub was unavailable)")
    throw new UnsupportedEvidenceError("None of the repository's source files could be read (too large, binary or unsafe), so there is nothing to evaluate.")
  }

  const review = await reviewSourceCode(gh.generate, retrieval, input.criteria.map((c) => ({ id: c.id, text: c.text })))
  if (!review.ok) throw new EvaluationResponseError(`Code review rejected (${review.stage}): ${review.problems.join("; ")}`)

  const weights = equalWeights(input.criteria.length)
  const specs: CriterionSpec[] = input.criteria.map((c, i) => ({ id: c.id, text: c.text, weight: weights[i], mandatory: c.mandatory }))
  const scored = scoreCodeReview(review.data, specs, retrieval)
  if (!scored.ok) throw new EvaluationResponseError(`Code review scoring rejected (${scored.stage}): ${scored.problems.join("; ")}`)
  const r = scored.data

  return {
    model,
    promptVersion: CODE_REVIEW_PROMPT_VERSION,
    simulated: false,
    score: r.score,
    criteriaResults: r.criteria.map((c) => ({
      criterion: c.text,
      passed: c.assessment === "verified",
      reason: [
        c.reason,
        c.missingFunctionality ? `Missing: ${c.missingFunctionality}` : "",
        c.uncertainty ? `Uncertain: ${c.uncertainty}` : "",
        ...c.adjustments,
      ].filter(Boolean).join(" "),
      assessment: c.assessment,
      evidenceQuote: c.evidence[0]?.quote ?? null,
      weight: c.weight,
      points: c.points,
      evidence: c.evidence,
    })),
    source: { kind: "github", repository: r.repository, commitSha: r.commitSha },
    ...(r.automaticApprovalBlocked ? { passBlocked: r.blockedReasons } : {}),
    // The verdict (Pass / Needs Review / Fail) lives in the summary; the stored boolean `passed` is Pass only.
    summary:
      `${r.verdict} (${r.score}/100) for ${r.repository}@${r.commitSha}. ${r.reasons.join(" ")}` +
      (r.automaticApprovalBlocked ? ` Automatic approval blocked: ${r.blockedReasons.join(" ")}` : "") +
      (review.data.notes.length ? ` ${review.data.notes.length} cited source reference(s) could not be verified and were not counted.` : ""),
  }
}

export function createGeminiEvaluator(opts: GeminiEvaluatorOptions): Evaluator {
  return {
    mode: "live",
    async evaluate(input: EvaluatorInput): Promise<EvaluatorOutput> {
      // A GitHub submission is recognised ONLY explicitly: by the repository/commit stored on the submission (authoritative), or,
      // for older submissions, by the reserved declaration file. Text is never searched for repository URLs.
      const stored = input.submission.github
      const declaration: ReturnType<typeof parseGithubDeclaration> = stored
        ? stored.repositoryUrl && stored.commitSha
          ? { kind: "github", repositoryUrl: stored.repositoryUrl, commitSha: stored.commitSha }
          : { kind: "invalid", message: "This submission's GitHub details are incomplete (a repository and a commit are both required)." }
        : parseGithubDeclaration(input.submission, input.evidence)
      if (declaration.kind === "invalid") throw new UnsupportedEvidenceError(declaration.message)
      if (declaration.kind === "github") {
        if (!opts.github) throw new UnsupportedEvidenceError("GitHub submissions can't be evaluated automatically right now.")
        return evaluateGithub(input, declaration, opts.github, opts.model)
      }

      // Only text evidence can be read faithfully today. Never guess about a PDF/image/zip that was only partly read.
      if (!TEXT_EVIDENCE.has(input.submission.mimeType.toLowerCase())) {
        throw new UnsupportedEvidenceError(
          "Automatic evaluation currently reads text and Markdown evidence only. This file type needs a manual review."
        )
      }
      const text = new TextDecoder("utf-8").decode(input.evidence)
      if (text.trim() === "") throw new UnsupportedEvidenceError("The evidence file contains no readable text.")
      const truncated = input.submission.fileSize > input.evidence.length

      const weights = equalWeights(input.criteria.length)
      const specs: CriterionSpec[] = input.criteria.map((c, i) => ({ id: c.id, text: c.text, weight: weights[i], mandatory: c.mandatory }))

      const run = await assessEvidence(opts.generate, specs, text, truncated ? { truncatedAtBytes: input.evidence.length } : {})
      if (!run.ok) throw new EvaluationResponseError(`Gemini response rejected (${run.stage}): ${run.problems.join("; ")}`)

      const r = run.result
      return {
        model: opts.model,
        promptVersion: PROMPT_VERSION,
        simulated: false,
        score: r.score,
        criteriaResults: r.criteria.map((c, i) => {
          const claimed = run.classification.assessments[i]
          // Keep Gemini's quote only when it survived the evidence check; a downgraded claim's quote was not real.
          const quoteSurvived = c.assessment !== "unsupported" || claimed.assessment === "unsupported"
          return {
            criterion: c.text,
            passed: c.assessment === "verified",
            reason: c.reason,
            assessment: c.assessment,
            evidenceQuote: quoteSurvived ? claimed.evidence_quote : null,
            weight: c.weight,
            points: c.points,
          }
        }),
        // The verdict (Pass / Needs Review / Fail) lives in the summary; the stored boolean `passed` is Pass only.
        summary:
          `${r.verdict} (${r.score}/100). ${r.reasons.join(" ")}` +
          (run.notes.length ? ` ${run.notes.length} cited quote(s) could not be verified in the evidence and were not counted.` : ""),
      }
    },
  }
}

/** The minimal slice of the Gemini SDK this module uses, so tests can substitute a fake without any network. */
export interface GeminiLikeClient {
  models: { generateContent(args: { model: string; contents: string; config: Record<string, unknown> }): Promise<{ text?: string | undefined }> }
}

/** One structured-JSON Gemini call per prompt, at temperature 0, with a classification-only response schema (no score, no verdict). */
export function geminiGenerate(
  config: GeminiConfig,
  client: GeminiLikeClient = createGeminiClient(config) as unknown as GeminiLikeClient,
  schema: unknown = RESPONSE_SCHEMA
): GenerateFn {
  return async (prompt) => {
    const response = await client.models.generateContent({
      model: config.model,
      contents: prompt,
      config: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 },
    })
    return response.text ?? ""
  }
}

/**
 * The evaluator for DUELY_EVALUATOR_MODE=gemini. If GEMINI_API_KEY / GEMINI_EVALUATION_MODEL are missing or invalid it
 * returns the disabled evaluator, so POST /api/evaluate answers 503 instead of crashing or calling anything.
 */
export function createGeminiEvaluatorFromEnv(
  env: Record<string, string | undefined> = process.env,
  client?: GeminiLikeClient,
  github: { fetch?: typeof fetch } = {}
): Evaluator {
  try {
    const config = getGeminiConfig(env)
    const token = env.GITHUB_TOKEN?.trim()
    return createGeminiEvaluator({
      generate: geminiGenerate(config, client),
      model: config.model,
      github: { generate: geminiGenerate(config, client, CODE_REVIEW_RESPONSE_SCHEMA), fetch: github.fetch, ...(token ? { token } : {}) },
    })
  } catch (e) {
    if (e instanceof GeminiConfigError) return disabledEvaluator
    throw e
  }
}
