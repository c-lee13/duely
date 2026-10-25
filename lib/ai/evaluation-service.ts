import "server-only"
import { assessEvidence, equalWeights, PROMPT_VERSION, RESPONSE_SCHEMA, type GenerateFn } from "./assessment"
import { createGeminiClient, getGeminiConfig, GeminiConfigError, type GeminiConfig } from "./gemini"
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

export function createGeminiEvaluator(opts: { generate: GenerateFn; model: string }): Evaluator {
  return {
    mode: "live",
    async evaluate(input: EvaluatorInput): Promise<EvaluatorOutput> {
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

/** One structured-JSON Gemini call per prompt, at temperature 0, with the classification-only response schema. */
export function geminiGenerate(config: GeminiConfig, client: GeminiLikeClient = createGeminiClient(config) as unknown as GeminiLikeClient): GenerateFn {
  return async (prompt) => {
    const response = await client.models.generateContent({
      model: config.model,
      contents: prompt,
      config: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0 },
    })
    return response.text ?? ""
  }
}

/**
 * The evaluator for DUELY_EVALUATOR_MODE=gemini. If GEMINI_API_KEY / GEMINI_EVALUATION_MODEL are missing or invalid it
 * returns the disabled evaluator, so POST /api/evaluate answers 503 instead of crashing or calling anything.
 */
export function createGeminiEvaluatorFromEnv(env: Record<string, string | undefined> = process.env, client?: GeminiLikeClient): Evaluator {
  try {
    const config = getGeminiConfig(env)
    return createGeminiEvaluator({ generate: geminiGenerate(config, client), model: config.model })
  } catch (e) {
    if (e instanceof GeminiConfigError) return disabledEvaluator
    throw e
  }
}
