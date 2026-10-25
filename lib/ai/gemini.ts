import "server-only"
import { GoogleGenAI } from "@google/genai"

/**
 * Server-only Gemini client. The API key and model name come from the environment (GEMINI_API_KEY,
 * GEMINI_EVALUATION_MODEL) and are never exposed to the browser: this module imports "server-only", so a client
 * component that imports it fails the build, and neither variable has a NEXT_PUBLIC_ prefix.
 *
 * This is connectivity only. It does not evaluate anything, and nothing calls it from /api/evaluate yet.
 */

export class GeminiConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GeminiConfigError"
  }
}

export interface GeminiConfig {
  apiKey: string
  model: string
}

/** Reads and validates the Gemini environment. Never includes the key in an error message. */
export function getGeminiConfig(env: Record<string, string | undefined> = process.env): GeminiConfig {
  const apiKey = env.GEMINI_API_KEY?.trim()
  const model = env.GEMINI_EVALUATION_MODEL?.trim()
  const problems: string[] = []
  if (!apiKey) problems.push("GEMINI_API_KEY is not set.")
  else if (/your[-_]|<.*>|changeme/i.test(apiKey)) problems.push("GEMINI_API_KEY still has a placeholder value.")
  if (!model) problems.push("GEMINI_EVALUATION_MODEL is not set (for example the model id from Google AI Studio).")
  if (problems.length > 0) throw new GeminiConfigError(`Gemini is not configured:\n- ${problems.join("\n- ")}`)
  return { apiKey: apiKey as string, model: model as string }
}

/** Requests give up after 30 seconds instead of hanging on a stalled connection. */
export const GEMINI_REQUEST_TIMEOUT_MS = 30_000

export function createGeminiClient(config: GeminiConfig = getGeminiConfig()): GoogleGenAI {
  return new GoogleGenAI({ apiKey: config.apiKey, httpOptions: { timeout: GEMINI_REQUEST_TIMEOUT_MS } })
}

/** Sends one plain-text prompt and returns the model's text plus which model answered. */
export async function generateText(prompt: string, config: GeminiConfig = getGeminiConfig()): Promise<{ model: string; text: string }> {
  const client = createGeminiClient(config)
  const response = await client.models.generateContent({ model: config.model, contents: prompt })
  return { model: config.model, text: response.text ?? "" }
}
