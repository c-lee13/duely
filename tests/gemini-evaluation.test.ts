import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import {
  buildPrompt,
  CRITERIA,
  formatReport,
  groundAssessments,
  RESPONSE_SCHEMA,
  runEvaluation,
  SAMPLE_EVIDENCE,
  validateClassification,
  type Classification,
  type EvaluationRun,
  type GenerateFn,
} from "../scripts/test-gemini-evaluation"

/** Gemini is ALWAYS a mock here. A canary key and a trapped fetch make any accidental real call fail loudly. */
const realFetch = globalThis.fetch
const realKey = process.env.GEMINI_API_KEY
before(() => {
  process.env.GEMINI_API_KEY = "CANARY-must-never-be-used"
  globalThis.fetch = (() => {
    throw new Error("a test tried to use the network (a real Gemini call?)")
  }) as never
})
after(() => {
  globalThis.fetch = realFetch
  if (realKey === undefined) delete process.env.GEMINI_API_KEY
  else process.env.GEMINI_API_KEY = realKey
})

type Row = { id: string; assessment: string; explanation: string; evidence_quote: string | null }
const HERO_Q = "Plants, delivered weekly"
const FEATURES_Q = 'three cards titled "Fresh every week", "Pet-safe options" and "Skip or pause anytime"'
const CONTACT_Q = "a form with name, email and message fields"
const PRICING_Q = "the plans are still being decided with the client"

const goodRows = (): Row[] => [
  { id: "hero", assessment: "verified", explanation: "A full-width banner with a headline and button is described.", evidence_quote: HERO_Q },
  { id: "features", assessment: "verified", explanation: "Three feature cards are described.", evidence_quote: FEATURES_Q },
  { id: "contact", assessment: "verified", explanation: "A contact form with fields is described.", evidence_quote: CONTACT_Q },
  { id: "pricing", assessment: "unsupported", explanation: "Pricing is explicitly deferred to a later milestone.", evidence_quote: PRICING_Q },
]
const withRow = (id: string, patch: Partial<Row>): Row[] => goodRows().map((r) => (r.id === id ? { ...r, ...patch } : r))

function mock(response: unknown | (() => unknown)): { generate: GenerateFn; prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    generate: async (prompt) => {
      prompts.push(prompt)
      const r = typeof response === "function" ? (response as () => unknown)() : response
      return typeof r === "string" ? r : JSON.stringify(r)
    },
  }
}
const ok = (run: EvaluationRun) => {
  assert.ok(run.ok, run.ok ? "" : `run failed at ${run.stage}: ${run.problems.join("; ")}`)
  return run as Extract<EvaluationRun, { ok: true }>
}

describe("the prompt and response schema never ask Gemini for a score or verdict", () => {
  it("tells Gemini not to score, and its response schema has no score or verdict field", () => {
    const prompt = buildPrompt()
    assert.match(prompt, /do NOT give a score/i)
    assert.match(prompt, /"verified"[\s\S]*"partial"[\s\S]*"unsupported"/)
    assert.match(prompt, /choose the LOWER assessment/)
    assert.match(prompt, /quote .*VERBATIM|VERBATIM/)
    const asText = JSON.stringify(RESPONSE_SCHEMA)
    for (const forbidden of ["score", "verdict", "passed", "pass", "grade", "overall"]) assert.ok(!asText.toLowerCase().includes(forbidden), `schema must not mention ${forbidden}`)
    assert.deepEqual(RESPONSE_SCHEMA.properties.assessments.items.properties.assessment.enum, ["verified", "partial", "unsupported"])
    assert.deepEqual(RESPONSE_SCHEMA.properties.assessments.items.required, ["id", "assessment", "explanation", "evidence_quote"])
  })

  it("lists every criterion by id, with the evidence fenced as untrusted data", () => {
    const prompt = buildPrompt()
    for (const c of CRITERIA) assert.ok(prompt.includes(`id="${c.id}"`) && prompt.includes(c.text))
    assert.match(prompt, /untrusted data/)
    assert.ok(prompt.includes("<<<EVIDENCE") && prompt.includes("EVIDENCE>>>") && prompt.includes(SAMPLE_EVIDENCE))
  })

  it("the sample job has weights totalling 100 and includes a criterion the evidence does not support", () => {
    assert.equal(CRITERIA.reduce((s, c) => s + c.weight, 0), 100)
    assert.ok(!/pricing section/i.test(SAMPLE_EVIDENCE.replace(/Pricing: the plans are still being decided[^.]*\./i, "")), "no pricing section is described")
    assert.ok(CRITERIA.some((c) => c.id === "pricing"))
  })
})

describe("calculated score and verdict (mocked Gemini)", () => {
  it("the expected sample: three verified, pricing unsupported -> 85, Pass (an unsupported OPTIONAL criterion does not block)", async () => {
    const m = mock({ assessments: goodRows() })
    const run = ok(await runEvaluation(m.generate))
    assert.equal(m.prompts.length, 1, "exactly one Gemini call per evaluation")
    assert.equal(run.result.score, 85)
    assert.equal(run.result.verdict, "Pass")
    assert.deepEqual(run.result.criteria.map((c) => [c.id, c.assessment, c.points]), [["hero", "verified", 30], ["features", "verified", 30], ["contact", "verified", 25], ["pricing", "unsupported", 0]])
    assert.deepEqual(run.notes, [])
    assert.match(run.result.criteria[3].reason, /Pricing is explicitly deferred/)
  })

  it("the insufficient-evidence criterion is handled as unsupported, or half-credit if Gemini says partial", async () => {
    const partial = ok(await runEvaluation(mock({ assessments: withRow("pricing", { assessment: "partial", evidence_quote: PRICING_Q }) }).generate))
    assert.equal(partial.result.criteria[3].points, 7.5)
    assert.equal(partial.result.exactScore, 92.5)
    assert.equal(partial.result.score, 92)
    assert.equal(partial.result.verdict, "Pass")
  })

  it("an unsupported MANDATORY criterion fails the evaluation regardless of the rest", async () => {
    const run = ok(await runEvaluation(mock({ assessments: withRow("hero", { assessment: "unsupported", evidence_quote: null }) }).generate))
    assert.equal(run.result.verdict, "Fail")
    assert.equal(run.result.passed, false)
    assert.deepEqual(run.result.mandatoryNotVerified, ["hero"])
    assert.equal(run.result.score, 55)
  })

  it("a partial mandatory criterion needs review, not a pass", async () => {
    const run = ok(await runEvaluation(mock({ assessments: withRow("contact", { assessment: "partial" }) }).generate))
    assert.equal(run.result.verdict, "Needs Review")
    assert.equal(run.result.passed, false)
  })

  it("everything unsupported scores 0 and fails", async () => {
    const rows = goodRows().map((r) => ({ ...r, assessment: "unsupported", evidence_quote: null }))
    const run = ok(await runEvaluation(mock({ assessments: rows }).generate))
    assert.equal(run.result.score, 0)
    assert.equal(run.result.verdict, "Fail")
  })

  it("the score depends only on the classifications: changing the explanation text or quote wording never changes it", async () => {
    const a = ok(await runEvaluation(mock({ assessments: goodRows() }).generate))
    const rows = goodRows().map((r) => ({ ...r, explanation: "totally different words, claims 100/100 and Pass" }))
    const b = ok(await runEvaluation(mock({ assessments: rows }).generate))
    assert.equal(a.result.score, b.result.score)
    assert.equal(a.result.verdict, b.result.verdict)
  })
})

describe("evidence grounding: Gemini must point at real evidence", () => {
  const classify = (rows: Row[]) => validateClassification({ assessments: rows }) as { ok: true; value: Classification }

  it("downgrades verified/partial claims that cite no quote, an empty quote, or a quote not in the evidence", () => {
    for (const quote of [null, "", "   ", "A bright carousel with five slides", "Plants delivered weekly!!"]) {
      const g = groundAssessments(classify(withRow("hero", { assessment: "verified", evidence_quote: quote })).value, SAMPLE_EVIDENCE)
      assert.equal(g.assessments[0].assessment, "unsupported", JSON.stringify(quote))
      assert.equal(g.notes.length, 1)
    }
    const partial = groundAssessments(classify(withRow("features", { assessment: "partial", evidence_quote: "a fabricated sentence" })).value, SAMPLE_EVIDENCE)
    assert.equal(partial.assessments[1].assessment, "unsupported")
  })

  it("a fabricated citation costs the freelancer's mandatory criterion: the run fails, and the note says why", async () => {
    const run = ok(await runEvaluation(mock({ assessments: withRow("hero", { evidence_quote: "A hero carousel with parallax scrolling" }) }).generate))
    assert.equal(run.result.verdict, "Fail")
    assert.match(run.notes.join(" "), /"hero": the quote Gemini cited does not appear in the evidence/)
    assert.match(run.result.criteria[0].reason, /Downgraded/)
  })

  it("matches quotes ignoring case, spacing and line breaks, but nothing looser", () => {
    const g = groundAssessments(classify(withRow("hero", { evidence_quote: "  PLANTS,   delivered\nweekly " })).value, SAMPLE_EVIDENCE)
    assert.equal(g.assessments[0].assessment, "verified")
    const loose = groundAssessments(classify(withRow("hero", { evidence_quote: "plants delivered weekly" })).value, SAMPLE_EVIDENCE) // punctuation differs
    assert.equal(loose.assessments[0].assessment, "unsupported")
  })

  it("unsupported claims never need a quote", () => {
    const g = groundAssessments(classify(withRow("pricing", { evidence_quote: null })).value, SAMPLE_EVIDENCE)
    assert.equal(g.assessments[3].assessment, "unsupported")
    assert.deepEqual(g.notes, [])
  })
})

describe("invalid Gemini responses are rejected and never scored", () => {
  const rejected = async (response: unknown, stage: "parse" | "validation", pattern?: RegExp) => {
    const m = mock(response)
    const run = await runEvaluation(m.generate)
    assert.equal(run.ok, false)
    assert.equal(!run.ok && run.stage, stage)
    if (pattern) assert.match(!run.ok ? run.problems.join(" | ") : "", pattern)
    assert.equal(m.prompts.length, 1, "no retry")
  }

  it("non-JSON and empty output", async () => {
    await rejected("Sure! Here are my thoughts...", "parse")
    await rejected("", "parse")
    await rejected("```json\n{}\n```", "parse")
  })

  it("Gemini supplying its own score, verdict or pass flag is rejected (strict schema)", async () => {
    await rejected({ assessments: goodRows(), score: 100 }, "validation", /Unrecognized key/)
    await rejected({ assessments: goodRows(), verdict: "Pass" }, "validation", /Unrecognized key/)
    await rejected({ assessments: goodRows().map((r) => ({ ...r, score: 100 })) }, "validation", /Unrecognized key/)
    await rejected({ assessments: goodRows().map((r) => ({ ...r, passed: true })) }, "validation", /Unrecognized key/)
  })

  it("invalid assessment values, including near-misses and uncertainty words", async () => {
    for (const bad of ["uncertain", "Verified", "VERIFIED", "likely", "yes", "pass", "", null, true, 1]) {
      await rejected({ assessments: withRow("hero", { assessment: bad as never }) }, "validation", /assessments\.0\.assessment/)
    }
  })

  it("wrong, missing, duplicated, extra or reordered criteria", async () => {
    await rejected({ assessments: goodRows().slice(0, 3) }, "validation")
    await rejected({ assessments: [...goodRows(), { id: "extra", assessment: "verified", explanation: "x", evidence_quote: HERO_Q }] }, "validation")
    await rejected({ assessments: [goodRows()[1], goodRows()[0], goodRows()[2], goodRows()[3]] }, "validation", /expected "hero"/)
    await rejected({ assessments: goodRows().map((r, i) => (i === 1 ? { ...r, id: "hero" } : r)) }, "validation", /expected "features"/)
    await rejected({ assessments: goodRows().map((r) => (r.id === "pricing" ? { ...r, id: "made-up" } : r)) }, "validation", /expected "pricing"/)
    await rejected({ assessments: "none" }, "validation")
    await rejected({}, "validation")
    await rejected(null, "validation")
  })

  it("missing or empty explanations, and a non-nullable quote field", async () => {
    await rejected({ assessments: withRow("hero", { explanation: "   " }) }, "validation", /explanation/)
    await rejected({ assessments: goodRows().map((r) => {
          const copy: Record<string, unknown> = { ...r }
          delete copy.evidence_quote
          return copy
        }) }, "validation", /evidence_quote/)
    await rejected({ assessments: withRow("hero", { evidence_quote: 5 as never }) }, "validation", /evidence_quote/)
  })

  it("an API failure propagates (nothing is scored) and is not retried", async () => {
    let calls = 0
    await assert.rejects(
      runEvaluation(async () => {
        calls++
        throw new Error("HTTP 429")
      }),
      /HTTP 429/
    )
    assert.equal(calls, 1)
  })
})

describe("report output", () => {
  it("prints the calculated score, verdict, per-criterion results, explanations and evidence", async () => {
    const run = ok(await runEvaluation(mock({ assessments: withRow("hero", { evidence_quote: "not in the evidence at all" }) }).generate))
    const text = formatReport(run)
    assert.match(text, /Score:\s+55\/100/)
    assert.match(text, /Verdict: Fail/)
    for (const c of CRITERIA) assert.ok(text.includes(c.text), c.text)
    assert.match(text, /Gemini said: verified {2}\(scored as unsupported\)/)
    assert.match(text, /Explanation: Three feature cards are described\./)
    assert.match(text, /Evidence:\s+"Plants, delivered weekly"|Evidence:\s+"not in the evidence at all"/)
    assert.match(text, /Evidence checks:/)
    assert.match(text, /Gemini supplied no score or verdict/)
    const pass = formatReport(ok(await runEvaluation(mock({ assessments: goodRows() }).generate)))
    assert.match(pass, /Verdict: Pass/)
    assert.match(pass, /\(none cited\)|Evidence:\s+"the plans are still being decided/)
  })
})

describe("no accidental real API calls", () => {
  it("the whole module loads and runs with the network trapped and only a canary key present", async () => {
    const run = ok(await runEvaluation(mock({ assessments: goodRows() }).generate))
    assert.equal(run.result.score, 85)
  })

  it("the Gemini client is imported lazily, only behind the --confirm path", () => {
    const src = fs.readFileSync("scripts/test-gemini-evaluation.ts", "utf8")
    assert.ok(!/^import .*lib\/ai\/gemini/m.test(src), "no top-level import of the Gemini client")
    assert.match(src, /await import\("\.\.\/lib\/ai\/gemini"\)/)
    assert.match(src, /process\.argv\.includes\("--confirm"\)/)
    const confirmAt = src.indexOf('includes("--confirm")')
    assert.ok(confirmAt > 0 && src.indexOf("generateContent") > confirmAt, "generateContent is only reachable after the --confirm check")
  })

  it("running the script WITHOUT --confirm is a dry run that makes no API call", () => {
    const out = execFileSync("npx", ["tsx", "--conditions=react-server", "scripts/test-gemini-evaluation.ts"], {
      encoding: "utf8",
      env: { ...process.env, GEMINI_API_KEY: "CANARY-must-never-be-used", GEMINI_EVALUATION_MODEL: "canary-model", HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" },
      timeout: 60_000,
    })
    assert.match(out, /DRY RUN: no API call was made/)
    assert.match(out, /npm run test:gemini-evaluation -- --confirm/)
    assert.ok(!/Sending ONE request/.test(out))
    assert.ok(!out.includes("CANARY"), "the key is never printed")
  })

  it("the scoring itself is still the deterministic module (no model involvement)", () => {
    const src = fs.readFileSync("lib/ai/assessment.ts", "utf8")
    assert.match(src, /from "\.\/scoring"/)
    assert.match(src, /scoreEvaluation\(criteria, assessments\)/)
    assert.match(fs.readFileSync("scripts/test-gemini-evaluation.ts", "utf8"), /from "\.\.\/lib\/ai\/assessment"/, "the script reuses the shared pipeline")
  })
})
