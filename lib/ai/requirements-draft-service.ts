import "server-only"
import { geminiGenerate, type GeminiLikeClient } from "./evaluation-service"
import { getGeminiConfig, GeminiConfigError } from "./gemini"
import { draftRequirements, REQUIREMENTS_RESPONSE_SCHEMA, type DraftResult } from "./requirements-draft"

/**
 * Server-only wiring of the requirements drafter to the existing Gemini integration (lib/ai/gemini.ts config and the same
 * structured-JSON call used by the evaluator, with this module's own response schema). Nothing calls it yet: it is not connected
 * to Create Invoice, any API route, or the evaluation pipeline. If Gemini isn't configured it reports "unavailable" and calls
 * nothing; it never reads or returns the API key.
 */
export interface RequirementsDrafter {
  /** False when the Gemini settings are missing or still placeholders. */
  readonly available: boolean
  draft(description: string): Promise<DraftResult>
}

export function createGeminiRequirementsDrafter(env: Record<string, string | undefined> = process.env, client?: GeminiLikeClient): RequirementsDrafter {
  try {
    const config = getGeminiConfig(env)
    const generate = geminiGenerate(config, client, REQUIREMENTS_RESPONSE_SCHEMA)
    return { available: true, draft: (description) => draftRequirements(generate, description) }
  } catch (e) {
    if (!(e instanceof GeminiConfigError)) throw e
    return {
      available: false,
      draft: async () => ({ ok: false, stage: "unavailable", problems: ["AI drafting isn't available: Gemini is not configured on the server."] }),
    }
  }
}
