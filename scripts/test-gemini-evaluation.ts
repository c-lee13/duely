/**
 * Standalone test of the AI evaluation pipeline: Gemini CLASSIFIES each acceptance criterion, our deterministic
 * module (lib/ai/scoring.ts) calculates the score and verdict.
 *
 *   npm run test:gemini-evaluation              -> dry run: prints the criteria, evidence and prompt, calls nothing
 *   npm run test:gemini-evaluation -- --confirm -> makes exactly ONE real (paid) Gemini call
 *
 * Gemini is asked only for, per criterion: an assessment (verified / partial / unsupported), an explanation, and a
 * verbatim quote from the evidence when one exists. It is never asked for a score or a verdict, and a response that
 * contains either is rejected. Verified/partial claims must carry a quote that really appears in the evidence;
 * otherwise they are downgraded to unsupported before scoring. Nothing here touches Supabase, the API routes, the
 * frontend or any payment logic, and the output decides nothing.
 */
import { existsSync } from "node:fs"
import type { CriterionSpec } from "../lib/ai/scoring"

// ---- Sample job: weights total 100; the last criterion has deliberately insufficient evidence -------------------------

export const CRITERIA: CriterionSpec[] = [
  { id: "hero", text: "Includes a hero section.", weight: 30, mandatory: true },
  { id: "features", text: "Includes a features section.", weight: 30, mandatory: false },
  { id: "contact", text: "Includes a contact section.", weight: 25, mandatory: true },
  { id: "pricing", text: "Includes a pricing section with plan prices.", weight: 15, mandatory: false },
]

export const SAMPLE_EVIDENCE = `Project: landing page for "Brightleaf", a small plant-delivery startup.

Delivered in index.html and styles.css (deployed preview: https://brightleaf-preview.example).

- Hero section: full-width banner with the headline "Plants, delivered weekly", a subheading, and a green "Start your plan" button.
- Features section: three cards titled "Fresh every week", "Pet-safe options" and "Skip or pause anytime", each with an icon and two lines of text.
- Contact section: a form with name, email and message fields, a "Send message" button, and the studio's email address and phone number underneath.

Pricing: the plans are still being decided with the client, so this will follow in a later milestone.

The delivered sections are responsive and tested on mobile and desktop.`

// ---- Shared pipeline (lib/ai/assessment.ts), specialised to the sample job ------------------------------------------------

import {
  assessEvidence,
  buildAssessmentPrompt,
  classificationSchema,
  groundAssessments as groundShared,
  RESPONSE_SCHEMA,
  validateClassification as validateShared,
  type AssessmentRun,
  type Classification,
  type GenerateFn,
} from "../lib/ai/assessment"

export { RESPONSE_SCHEMA }
export type { Classification, GenerateFn }
export const ClassificationSchema = classificationSchema(CRITERIA.length)

export const buildPrompt = (criteria: readonly CriterionSpec[] = CRITERIA, evidence: string = SAMPLE_EVIDENCE) => buildAssessmentPrompt(criteria, evidence)
export const validateClassification = (raw: unknown, criteria: readonly CriterionSpec[] = CRITERIA) => validateShared(raw, criteria)
export const groundAssessments = groundShared

export type EvaluationRun = AssessmentRun

export async function runEvaluation(generate: GenerateFn, criteria: readonly CriterionSpec[] = CRITERIA, evidence: string = SAMPLE_EVIDENCE): Promise<EvaluationRun> {
  return assessEvidence(generate, criteria, evidence)
}

export function formatReport(run: Extract<EvaluationRun, { ok: true }>, criteria: readonly CriterionSpec[] = CRITERIA): string {
  const { result, classification, notes } = run
  const lines: string[] = ["--- Criterion results (Gemini classified; lib/ai/scoring.ts calculated) ---"]
  result.criteria.forEach((c, i) => {
    const g = classification.assessments[i]
    const spec = criteria[i]
    lines.push(
      `${i + 1}. [${c.assessment.toUpperCase()}] ${c.text}  (weight ${c.weight}${spec.mandatory ? ", mandatory" : ""}) -> ${c.points} pts`,
      `     Gemini said: ${g.assessment}${c.assessment !== g.assessment ? `  (scored as ${c.assessment})` : ""}`,
      `     Evidence:    ${g.evidence_quote ? `"${g.evidence_quote}"` : "(none cited)"}`,
      `     Explanation: ${g.explanation}`
    )
  })
  if (notes.length) lines.push("", "Evidence checks:", ...notes.map((n) => `  - ${n}`))
  if (result.warnings.length) lines.push("", "Scoring warnings:", ...result.warnings.map((w) => `  - ${w}`))
  lines.push(
    "",
    `Score:   ${result.score}/100${result.exactScore !== result.score ? ` (exact ${result.exactScore})` : ""}`,
    `Verdict: ${result.verdict}`,
    "Reasons:",
    ...result.reasons.map((r) => `  - ${r}`),
    "",
    "Gemini supplied no score or verdict; both were calculated by our scoring module. A recommendation only: nothing was saved or paid."
  )
  return lines.join("\n")
}

// ---- Command line ---------------------------------------------------------------------------------------------------

async function main() {
  for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f)
  console.log("Criteria (weights total 100):")
  CRITERIA.forEach((c, i) => console.log(`  ${i + 1}. ${c.id}: ${c.text}  [weight ${c.weight}${c.mandatory ? ", mandatory" : ""}]`))
  console.log("  (the last criterion is deliberately NOT supported by the evidence, to show how unsupported is handled)")

  if (!process.argv.includes("--confirm")) {
    console.log("\nDRY RUN: no API call was made. Prompt that would be sent:\n")
    console.log(buildPrompt())
    console.log("\nTo make exactly ONE real (paid) Gemini call, run:  npm run test:gemini-evaluation -- --confirm")
    return
  }

  // Imported only here, so tests (which never reach this) never load the server-only client or any key.
  const { createGeminiClient, getGeminiConfig } = await import("../lib/ai/gemini")
  const config = getGeminiConfig()
  console.log(`\nModel: ${config.model}\nSending ONE request to Gemini...\n`)
  const generate: GenerateFn = async (prompt) => {
    const response = await createGeminiClient(config).models.generateContent({
      model: config.model,
      contents: prompt,
      config: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0 },
    })
    return response.text ?? ""
  }

  const run = await runEvaluation(generate)
  console.log("--- Raw Gemini response ---")
  console.log(run.raw || "(empty)")
  if (!run.ok) {
    console.error(`\nFAIL (${run.stage}): the response was rejected and NOT scored:`)
    run.problems.forEach((p) => console.error(`  - ${p}`))
    process.exit(1)
  }
  console.log(`\n${formatReport(run)}`)
}

if (process.argv[1]?.endsWith("test-gemini-evaluation.ts")) {
  main().catch((e: unknown) => {
    const err = e as { name?: string; status?: number; message?: string; cause?: { code?: string; message?: string } }
    if (err.name === "GeminiConfigError") console.error(`\nFAIL (configuration): ${err.message}`)
    else {
      console.error(`\nFAIL (API call): ${err.status ? `HTTP ${err.status}: ` : ""}${err.message ?? String(e)}`)
      if (err.cause) console.error(`Cause: ${err.cause.code ?? ""} ${err.cause.message ?? ""}`.trim())
    }
    process.exit(1)
  })
}
