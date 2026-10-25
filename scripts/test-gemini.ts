/**
 * One-shot Gemini connectivity check (a single API call):
 *
 *   npm run test:gemini
 *
 * Sends "Reply with exactly: Duely Gemini connected" and prints the model's reply, or a clear error.
 * Reads GEMINI_API_KEY and GEMINI_EVALUATION_MODEL from .env.local. The key is never printed.
 */
import { existsSync } from "node:fs"
import { generateText, getGeminiConfig, GeminiConfigError } from "../lib/ai/gemini"

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f)

const PROMPT = "Reply with exactly: Duely Gemini connected"
const EXPECTED = "Duely Gemini connected"

async function main() {
  const config = getGeminiConfig()
  console.log(`Model:   ${config.model}`)
  console.log(`Prompt:  ${PROMPT}`)
  const { text } = await generateText(PROMPT, config)
  console.log(`Reply:   ${text.trim() || "(empty response)"}`)
  if (text.trim() === EXPECTED) console.log("\nOK: Gemini is connected.")
  else console.log("\nConnected, but the reply was not the exact expected text. The API call itself succeeded.")
}

main().catch((e: unknown) => {
  if (e instanceof GeminiConfigError) {
    console.error(`\nFAIL (configuration): ${e.message}`)
  } else {
    const err = e as { status?: number; message?: string; name?: string; cause?: { code?: string; message?: string } }
    console.error(`\nFAIL (API call): ${err.status ? `HTTP ${err.status}: ` : ""}${err.message ?? String(e)}`)
    // Network-level failures ("fetch failed") hide their reason in `cause` (e.g. ETIMEDOUT, ENOTFOUND, ECONNRESET).
    if (err.cause) console.error(`Cause: ${err.cause.code ?? ""} ${err.cause.message ?? ""}`.trim())
    if (!err.status) console.error("No response from Google (network/timeout), so this says nothing about your key or model. Safe to run again.")
    if (err.status === 400 || err.status === 403) console.error("Check that GEMINI_API_KEY is valid and has access to the model.")
    if (err.status === 404) console.error("Check that GEMINI_EVALUATION_MODEL is a valid model id for your key.")
    if (err.status === 429) console.error("Rate limit or quota reached. Wait and try again; no retry was attempted.")
  }
  process.exit(1)
})
