import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { decidePassed } from "../lib/backend/evaluation"
import { SCRIPTED_MODEL, isCalculatorFixture, withScriptedFixture } from "../lib/backend/scripted-evaluator"
import { UnsupportedEvidenceError, type Evaluator, type EvaluatorInput, type EvaluatorOutput } from "../lib/backend/ports"

const C1 = "Functionality: The module exports add(a, b), subtract(a, b), and multiply(a, b), each accepting two numbers and returning the correct arithmetic result."
const C2 = "Delivery: The complete source code is available in a publicly accessible GitHub repository."
const zip = (name = "calc-main/calculator.js") => new Uint8Array([0x50, 0x4b, 3, 4, ...Buffer.from(name)])

function input(o: Partial<EvaluatorInput> = {}): EvaluatorInput {
  return {
    invoiceId: "inv-1",
    criteriaHash: `0x${"11".repeat(32)}`,
    criteriaVersion: 1,
    criteria: [
      { id: "c1", text: C1, mandatory: true },
      { id: "c2", text: C2, mandatory: true },
    ],
    submission: { id: "s1", fileName: "calc-main (1).zip", mimeType: "application/zip", fileSize: 100 },
    evidence: zip(),
    ...o,
  } as EvaluatorInput
}

function baseEvaluator() {
  const state = { calls: 0 }
  const real: EvaluatorOutput = { model: "gemini-x", promptVersion: "p", simulated: false, score: 10, criteriaResults: [], summary: "real" }
  const evaluator: Evaluator = { mode: "live", evaluate: async () => (state.calls++, real) }
  return { evaluator, state }
}
const ON = { DUELY_MOCK_AI_EVALUATION: "true" }

describe("scripted calculator demo evaluation", () => {
  it("gives the designated calculator submission the scripted passing result without calling the real evaluator", async () => {
    const { evaluator, state } = baseEvaluator()
    const out = await withScriptedFixture(evaluator, ON).evaluate(input())
    assert.equal(state.calls, 0)
    assert.equal(out.score, 95)
    assert.equal(out.model, SCRIPTED_MODEL)
    assert.deepEqual(out.criteriaResults.map((r) => r.criterion), [C1, C2]) // bound to the frozen criteria text
    assert.ok(out.criteriaResults.every((r) => r.passed && /not an independent AI or GitHub verification/.test(r.reason)))
    assert.match(out.summary, /APPROVE_ADVANCE/)
    assert.equal(decidePassed(out.score, out.criteriaResults.map((r) => ({ passed: r.passed, mandatory: true }))), true)
  })

  it("works even when no real evaluator is configured", async () => {
    const disabled: Evaluator = { mode: "disabled", evaluate: async () => { throw new Error("none") } }
    const ev = withScriptedFixture(disabled, ON)
    assert.equal(ev.mode, "live")
    assert.equal((await ev.evaluate(input())).score, 95)
  })

  it("does not apply to other criteria, other evidence, or GitHub submissions", async () => {
    const { evaluator, state } = baseEvaluator()
    const ev = withScriptedFixture(evaluator, ON)
    const other = [
      input({ criteria: [{ id: "c1", text: "Looks nice", mandatory: true }, { id: "c2", text: C2, mandatory: true }] }),
      input({ criteria: [{ id: "c1", text: C1, mandatory: true }, { id: "c2", text: C2, mandatory: false }] }),
      input({ criteria: [{ id: "c1", text: C1, mandatory: true }] }),
      input({ evidence: new TextEncoder().encode("calculator.js plain text") }),
      input({ evidence: zip("other/file.js") }),
      input({ submission: { ...input().submission, github: { repositoryUrl: "https://github.com/a/b", commitSha: "a".repeat(40) } } }),
    ]
    for (const i of other) {
      assert.equal(isCalculatorFixture(i), false)
      assert.equal((await ev.evaluate(i)).model, "gemini-x")
    }
    assert.equal(state.calls, other.length)
  })

  it("is inert when the flag is off: the base evaluator is returned unchanged", () => {
    const { evaluator } = baseEvaluator()
    for (const env of [{}, { DUELY_MOCK_AI_EVALUATION: "false" }, { DUELY_MOCK_AI_EVALUATION: "1" }]) assert.equal(withScriptedFixture(evaluator, env), evaluator)
  })

  it("refuses non-fixture evidence when nothing real is configured", async () => {
    const disabled: Evaluator = { mode: "disabled", evaluate: async () => { throw new Error("none") } }
    await assert.rejects(withScriptedFixture(disabled, ON).evaluate(input({ evidence: zip("x/y.js") })), UnsupportedEvidenceError)
  })
})
