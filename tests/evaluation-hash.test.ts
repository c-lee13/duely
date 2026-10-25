import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { keccak256, toBytes } from "viem"
import { canonicalEvaluationString, computeEvaluationHash, EVALUATION_HASH_VERSION } from "@/lib/shared/evaluation-hash"

/**
 * The evaluationHash committed on-chain with every advance. Frozen: changing the encoding would stop old payouts from
 * being recognisable by the reconciler (it recomputes the hash from the stored evaluation to verify its own transaction).
 */
const A = {
  evaluationId: "00000000-0000-4000-8000-000000000a01",
  submissionId: "00000000-0000-4000-8000-000000000b02",
  criteriaHash: "0x798688a068be344ed04c1e6bcdfdf9e8a1f5c6da80d7bd0050671c166a3f3160",
  score: 95,
}
const A_STRING =
  '{"v":1,"evaluationId":"00000000-0000-4000-8000-000000000a01","submissionId":"00000000-0000-4000-8000-000000000b02","criteriaHash":"0x798688a068be344ed04c1e6bcdfdf9e8a1f5c6da80d7bd0050671c166a3f3160","score":95}'

describe("evaluation hash", () => {
  it("frozen vector: exact canonical string and Keccak-256 over its UTF-8 bytes", () => {
    assert.equal(EVALUATION_HASH_VERSION, 1)
    assert.equal(canonicalEvaluationString(A), A_STRING)
    assert.equal(computeEvaluationHash(A), keccak256(toBytes(A_STRING)))
    assert.match(computeEvaluationHash(A), /^0x[0-9a-f]{64}$/)
    assert.notEqual(computeEvaluationHash(A), "0x" + "0".repeat(64), "never the zero hash the contract could treat as 'no evaluation'")
  })

  it("is case-insensitive for ids and hashes, so database casing cannot change it", () => {
    assert.equal(
      computeEvaluationHash({ ...A, evaluationId: A.evaluationId.toUpperCase(), submissionId: A.submissionId.toUpperCase(), criteriaHash: A.criteriaHash.toUpperCase().replace("0X", "0x") }),
      computeEvaluationHash(A)
    )
  })

  it("every committed fact changes it: evaluation, submission, criteria and score", () => {
    const base = computeEvaluationHash(A)
    assert.notEqual(computeEvaluationHash({ ...A, evaluationId: "00000000-0000-4000-8000-000000000a02" }), base)
    assert.notEqual(computeEvaluationHash({ ...A, submissionId: "00000000-0000-4000-8000-000000000b03" }), base)
    assert.notEqual(computeEvaluationHash({ ...A, criteriaHash: "0x" + "2".repeat(64) }), base)
    assert.notEqual(computeEvaluationHash({ ...A, score: 94 }), base)
  })

  it("rejects a score that is not an integer 0..100", () => {
    for (const score of [-1, 101, 95.5, Number.NaN]) assert.throws(() => computeEvaluationHash({ ...A, score }), RangeError)
  })
})
