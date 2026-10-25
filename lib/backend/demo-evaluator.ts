import { createHash } from "node:crypto"
import type { Evaluator, EvaluatorInput, EvaluatorOutput } from "./ports"

/**
 * DETERMINISTIC DEVELOPMENT EVALUATOR. Makes no model or OpenAI call. Its output is a pure function of the stored
 * evidence bytes, the invoice id and the frozen criteria, so it cannot be steered by anything the browser sends.
 * Every result is flagged `simulated: true`, and the advance service refuses simulated evaluations, so output from
 * this evaluator can never authorize a real payment.
 */
export const DEMO_MODEL = "demo-deterministic-evaluator"
export const DEMO_PROMPT_VERSION = "demo-v1"

export const demoEvaluator: Evaluator = {
  mode: "demo",
  async evaluate(input: EvaluatorInput): Promise<EvaluatorOutput> {
    const seed = createHash("sha256")
      .update(input.invoiceId)
      .update("\0")
      .update(input.criteriaHash)
      .update("\0")
      .update(input.evidence)
      .digest()
    const criteriaResults = input.criteria.map((c, i) => {
      const passed = seed[i % seed.length] % 5 !== 0 // ~80% of criteria pass
      return {
        criterion: c.text,
        passed,
        reason: passed
          ? "Simulated evaluation: the evidence is treated as satisfying this criterion."
          : "Simulated evaluation: the evidence is treated as not satisfying this criterion.",
      }
    })
    const met = criteriaResults.filter((r) => r.passed).length
    const score = input.criteria.length === 0 ? 0 : Math.round((met / input.criteria.length) * 100)
    return {
      model: DEMO_MODEL,
      promptVersion: DEMO_PROMPT_VERSION,
      simulated: true,
      score,
      criteriaResults,
      summary: `Simulated evaluation: ${met} of ${input.criteria.length} criteria treated as met. No AI model was used.`,
    }
  },
}

/**
 * Which evaluator runs, from DUELY_EVALUATOR_MODE. "demo" (deterministic, simulated) needs a non-production runtime;
 * "gemini" (real) needs GEMINI_API_KEY and GEMINI_EVALUATION_MODEL. Anything else disables evaluation (the endpoint answers 503).
 */
export function resolveEvaluatorMode(env: { DUELY_EVALUATOR_MODE?: string; NODE_ENV?: string }): "disabled" | "demo" | "gemini" {
  // "gemini" is the real evaluator: it needs an explicit opt-in (it costs money) and valid GEMINI_* configuration.
  if (env.DUELY_EVALUATOR_MODE === "gemini") return "gemini"
  return env.DUELY_EVALUATOR_MODE === "demo" && env.NODE_ENV !== "production" ? "demo" : "disabled"
}
