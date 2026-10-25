import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import {
  ASSESSMENT_FACTOR,
  InvalidScoringConfigError,
  PASS_SCORE_THRESHOLD,
  REVIEW_FLOOR,
  scoreEvaluation,
  validateCriteria,
  type Assessment,
  type CriterionSpec,
} from "@/lib/ai/scoring"
import { PASS_SCORE_THRESHOLD as SHARED_THRESHOLD } from "@/lib/frontend/eligibility"

const spec = (id: string, weight: number, mandatory = false): CriterionSpec => ({ id, text: `Criterion ${id}`, weight, mandatory })
const as = (id: string, assessment: unknown, reason?: string) => ({ id, assessment, reason })

/** Landing page: hero 40 (mandatory), features 30, contact 30 (mandatory). */
const LANDING: CriterionSpec[] = [spec("hero", 40, true), spec("features", 30), spec("contact", 30, true)]

describe("fully verified", () => {
  it("scores 100 and passes, with per-criterion points and reasons", () => {
    const r = scoreEvaluation(LANDING, [as("hero", "verified"), as("features", "verified"), as("contact", "verified")])
    assert.equal(r.score, 100)
    assert.equal(r.exactScore, 100)
    assert.equal(r.verdict, "Pass")
    assert.equal(r.passed, true)
    assert.deepEqual(r.criteria.map((c) => c.points), [40, 30, 30])
    assert.deepEqual(r.criteria.map((c) => c.factor), [1, 1, 1])
    assert.deepEqual(r.mandatoryNotVerified, [])
    assert.deepEqual(r.warnings, [])
    assert.match(r.reasons[0], /meets the pass threshold of 80/)
    assert.ok(r.criteria.every((c) => c.reason.length > 0))
    assert.match(r.summary, /^Pass: 100\/100/)
  })

  it("includes the evaluator's note in the reason, trimmed and capped", () => {
    const r = scoreEvaluation([spec("a", 100)], [as("a", "verified", `  Section ${"x".repeat(900)}  `)])
    assert.match(r.criteria[0].reason, /Evaluator note: Section x+/)
    assert.ok(r.criteria[0].reason.length < 700)
  })

  it("a single criterion worth 100 works", () => {
    assert.equal(scoreEvaluation([spec("only", 100, true)], [as("only", "verified")]).verdict, "Pass")
  })
})

describe("partial", () => {
  it("counts a partial criterion as half of its weight", () => {
    const r = scoreEvaluation(LANDING, [as("hero", "verified"), as("features", "partial"), as("contact", "verified")])
    assert.deepEqual(r.criteria.map((c) => c.points), [40, 15, 30])
    assert.equal(r.score, 85)
    assert.equal(r.verdict, "Pass", "an optional partial still passes when the score is high enough and mandatory ones are verified")
    assert.ok(r.reasons.some((x) => /optional criteria were not fully verified/.test(x)))
  })

  it("a partial MANDATORY criterion prevents a pass even with a high score, and sends it to review", () => {
    const r = scoreEvaluation(LANDING, [as("hero", "partial"), as("features", "verified"), as("contact", "verified")])
    assert.equal(r.score, 80, "40/2 + 30 + 30 = 80, which meets the threshold on its own")
    assert.equal(r.verdict, "Needs Review")
    assert.equal(r.passed, false)
    assert.deepEqual(r.mandatoryNotVerified, ["hero"])
    assert.match(r.reasons.join(" "), /Mandatory criteria only partly supported/)
  })

  it("all partial gives 50 and needs review", () => {
    const r = scoreEvaluation([spec("a", 50), spec("b", 50)], [as("a", "partial"), as("b", "partial")])
    assert.equal(r.score, 50)
    assert.equal(r.verdict, "Needs Review")
  })

  it("the pass threshold is exact: 79.5 does not pass, 80 passes, 80.5 passes", () => {
    const two = [spec("a", 59), spec("b", 41)]
    const r795 = scoreEvaluation(two, [as("a", "verified"), as("b", "partial")]) // 59 + 20.5
    assert.equal(r795.exactScore, 79.5)
    assert.equal(r795.score, 79, "rounded down, never up")
    assert.equal(r795.verdict, "Needs Review")
    const r80 = scoreEvaluation([spec("a", 40), spec("b", 40), spec("c", 20)], [as("a", "verified"), as("b", "verified"), as("c", "unsupported")])
    assert.equal(r80.exactScore, 80)
    assert.equal(r80.verdict, "Pass")
    const r805 = scoreEvaluation([spec("a", 41), spec("b", 39), spec("c", 20)], [as("a", "verified"), as("b", "partial"), as("c", "verified")])
    assert.equal(r805.exactScore, 80.5)
    assert.equal(r805.score, 80)
    assert.equal(r805.verdict, "Pass")
  })

  it("the Needs Review / Fail boundary sits at the review floor", () => {
    const two = [spec("a", 50), spec("b", 50)]
    assert.equal(scoreEvaluation(two, [as("a", "verified"), as("b", "unsupported")]).verdict, "Needs Review") // 50
    const odd = [spec("a", 99), spec("b", 1)]
    const r = scoreEvaluation(odd, [as("a", "partial"), as("b", "unsupported")]) // 49.5
    assert.equal(r.exactScore, 49.5)
    assert.equal(r.verdict, "Fail")
    assert.match(r.reasons.join(" "), /below 50/)
    assert.equal(REVIEW_FLOOR, 50)
  })
})

describe("missing evidence and uncertainty never count as verified", () => {
  it("no assessments at all: every criterion is unsupported, score 0, Fail", () => {
    const r = scoreEvaluation(LANDING, [])
    assert.equal(r.score, 0)
    assert.equal(r.verdict, "Fail")
    assert.ok(r.criteria.every((c) => c.assessment === "unsupported" && c.points === 0))
    assert.ok(r.criteria.every((c) => /No assessment was provided/.test(c.reason)))
    assert.deepEqual(r.mandatoryNotVerified, ["hero", "contact"])
  })

  it("an omitted criterion is unsupported even when the others are verified", () => {
    const r = scoreEvaluation(LANDING, [as("hero", "verified"), as("contact", "verified")]) // features missing
    assert.equal(r.criteria.find((c) => c.id === "features")?.assessment, "unsupported")
    assert.equal(r.score, 70)
    assert.equal(r.verdict, "Needs Review")
  })

  for (const value of ["uncertain", "unknown", "maybe", "likely", "VERIFIED", "Verified", " verified", "verified.", "", null, undefined, true, 1, 0.5, {}, [], ["verified"], NaN]) {
    it(`treats the invalid assessment ${JSON.stringify(value) ?? "undefined"} as unsupported`, () => {
      const r = scoreEvaluation([spec("a", 100)], [as("a", value)])
      assert.equal(r.criteria[0].assessment, "unsupported")
      assert.equal(r.score, 0)
      assert.equal(r.verdict, "Fail")
      assert.ok(r.warnings.length >= 1)
      assert.match(r.criteria[0].reason, /treated as unsupported/)
    })
  }

  it("conflicting duplicate assessments are unsupported, even if both say verified", () => {
    const r = scoreEvaluation([spec("a", 100)], [as("a", "verified"), as("a", "verified")])
    assert.equal(r.criteria[0].assessment, "unsupported")
    assert.equal(r.criteria[0].reportedAs, "conflicting")
    assert.equal(r.score, 0)
  })

  it("assessments for unknown criteria are ignored and flagged, never added to the score", () => {
    const r = scoreEvaluation([spec("a", 100)], [as("a", "partial"), as("ghost", "verified")])
    assert.equal(r.score, 50)
    assert.match(r.warnings.join(" "), /unknown criterion "ghost"/)
  })

  it("garbage input (not an array, null entries) cannot raise a score", () => {
    for (const bad of [null, undefined, "verified", 5, {}] as unknown[]) {
      assert.equal(scoreEvaluation([spec("a", 100)], bad as never).score, 0)
    }
    assert.equal(scoreEvaluation([spec("a", 100)], [null, undefined, 3] as never).score, 0)
  })
})

describe("mandatory failure", () => {
  it("an unsupported mandatory criterion fails even when the score is high", () => {
    const r = scoreEvaluation(LANDING, [as("hero", "unsupported"), as("features", "verified"), as("contact", "verified")])
    assert.equal(r.score, 60)
    assert.equal(r.verdict, "Fail")
    assert.equal(r.passed, false)
    assert.deepEqual(r.mandatoryNotVerified, ["hero"])
    assert.match(r.reasons.join(" "), /Mandatory criteria not supported.*Criterion hero/)

    const high = scoreEvaluation([spec("m", 10, true), spec("x", 90)], [as("m", "unsupported"), as("x", "verified")])
    assert.equal(high.score, 90, "a 90 does not rescue a failed mandatory criterion")
    assert.equal(high.verdict, "Fail")
    assert.equal(high.passed, false)
  })

  it("a mandatory criterion that is simply missing from the evaluator output fails the invoice", () => {
    const r = scoreEvaluation([spec("m", 10, true), spec("x", 90)], [as("x", "verified")])
    assert.equal(r.verdict, "Fail")
  })

  it("an optional unsupported criterion does not block a pass", () => {
    const r = scoreEvaluation([spec("m", 80, true), spec("opt", 20)], [as("m", "verified"), as("opt", "unsupported")])
    assert.equal(r.score, 80)
    assert.equal(r.verdict, "Pass")
  })
})

describe("invalid weights", () => {
  const bad = (specs: unknown, pattern: RegExp) =>
    assert.throws(() => scoreEvaluation(specs as CriterionSpec[], []), (e: unknown) => e instanceof InvalidScoringConfigError && pattern.test(e.message), String(pattern))

  it("rejects weights that do not total exactly 100", () => {
    bad([spec("a", 50), spec("b", 49)], /total exactly 100 \(they total 99\)/)
    bad([spec("a", 50), spec("b", 51)], /they total 101/)
    bad([spec("a", 99)], /they total 99/)
  })
  it("rejects zero, negative, fractional and non-numeric weights", () => {
    bad([spec("a", 0), spec("b", 100)], /weight must be a positive whole number/)
    bad([spec("a", -10), spec("b", 110)], /weight must be a positive whole number/)
    bad([spec("a", 33.3), spec("b", 33.3), spec("c", 33.4)], /weight must be a positive whole number/)
    bad([spec("a", Number.NaN), spec("b", 100)], /weight must be a positive whole number/)
    bad([spec("a", Infinity)], /weight must be a positive whole number/)
    bad([{ ...spec("a", 100), weight: "100" }], /weight must be a positive whole number/)
    bad([{ ...spec("a", 100), weight: null }], /weight must be a positive whole number/)
  })
  it("rejects an empty list, duplicate ids, blank ids and text, and a non-boolean mandatory flag", () => {
    bad([], /At least one criterion/)
    bad([spec("a", 50), spec("a", 50)], /duplicate id/)
    bad([spec("", 100)], /id must be a non-empty string/)
    bad([{ ...spec("a", 100), text: "  " }], /text must be a non-empty string/)
    bad([{ ...spec("a", 100), mandatory: "yes" }], /mandatory must be true or false/)
  })
  it("reports every problem at once", () => {
    try {
      validateCriteria([spec("a", -1), spec("a", 0.5)])
      assert.fail("should have thrown")
    } catch (e) {
      assert.ok(e instanceof InvalidScoringConfigError)
      assert.ok(e.problems.length >= 3)
    }
  })
  it("does not score at all when the configuration is invalid (no partial result)", () => {
    assert.throws(() => scoreEvaluation([spec("a", 50)], [as("a", "verified")]), InvalidScoringConfigError)
  })
})

describe("determinism and safety properties", () => {
  const specs = [spec("a", 45, true), spec("b", 35), spec("c", 20, true)]
  const states: Assessment[] = ["verified", "partial", "unsupported"]

  it("for every one of the 27 assessment combinations: score in 0..100, pass iff (score >= 80 and mandatory verified), arithmetic is exact", () => {
    for (const a of states)
      for (const b of states)
        for (const c of states) {
          const r = scoreEvaluation(specs, [as("a", a), as("b", b), as("c", c)])
          const exact = 45 * ASSESSMENT_FACTOR[a] + 35 * ASSESSMENT_FACTOR[b] + 20 * ASSESSMENT_FACTOR[c]
          assert.equal(r.exactScore, exact, `${a}/${b}/${c}`)
          assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100)
          assert.ok(r.score <= r.exactScore, "rounding only ever goes down")
          const mandatoryOk = a === "verified" && c === "verified"
          assert.equal(r.passed, exact >= PASS_SCORE_THRESHOLD && mandatoryOk, `${a}/${b}/${c}`)
          assert.equal(r.verdict === "Pass", r.passed)
          assert.equal(r.criteria.reduce((s, x) => s + x.points, 0), exact)
          if (a === "unsupported" || c === "unsupported") assert.equal(r.verdict, "Fail")
          assert.ok(r.reasons.length >= 1)
        }
  })

  it("is deterministic, order-independent and does not mutate its inputs", () => {
    const input = [as("c", "verified"), as("a", "verified"), as("b", "partial", "ok")]
    const frozenSpecs = specs.map((s) => Object.freeze({ ...s }))
    const frozenInput = Object.freeze(input.map((x) => Object.freeze({ ...x })))
    const first = scoreEvaluation(frozenSpecs, frozenInput)
    const second = scoreEvaluation(frozenSpecs, [...frozenInput].reverse())
    assert.deepEqual(first, second)
    assert.deepEqual(scoreEvaluation(frozenSpecs, frozenInput), first)
    assert.deepEqual(input.map((x) => x.id), ["c", "a", "b"])
  })

  it("keeps the product's single pass threshold", () => {
    assert.equal(PASS_SCORE_THRESHOLD, 80)
    assert.equal(PASS_SCORE_THRESHOLD, SHARED_THRESHOLD)
  })

  it("the module is pure: no model, network, database, blockchain or frontend imports", () => {
    const src = fs.readFileSync("lib/ai/scoring.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
    for (const forbidden of ["@google/genai", "lib/ai/gemini", "fetch(", "supabase", "lib/backend", "viem", "process.env", "Date.now", "Math.random"]) {
      assert.ok(!src.includes(forbidden), `scoring.ts must not reference ${forbidden}`)
    }
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(imports, ["@/lib/frontend/eligibility"], "its only import is the shared pass-threshold constant")
  })
})
