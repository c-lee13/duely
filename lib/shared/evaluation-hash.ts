import { keccak256, toBytes } from "viem"

/**
 * The `evaluationHash` passed to `InvoiceAdvance.approveAdvance(invoiceId, evaluationHash)` and emitted in
 * `AdvancePaid`. It commits the on-chain payout to the exact stored evaluation that authorized it, so anyone can later
 * check "this advance was paid because of evaluation X of submission Y against criteria Z, with score S".
 *
 * It is DETERMINISTIC from database facts (an evaluation row is immutable once completed), so it never has to be stored:
 * after a crash the server recomputes it to recognise and verify its own transaction.
 *
 * Encoding (version 1, FROZEN): Keccak-256 over the UTF-8 bytes of
 *   JSON.stringify({ v: 1, evaluationId, submissionId, criteriaHash, score })
 * with lower-case ids/hashes. The contract treats the value as opaque (any non-zero bytes32).
 */
export const EVALUATION_HASH_VERSION = 1

export interface EvaluationHashInput {
  evaluationId: string
  submissionId: string
  /** The invoice's criteria hash the evaluation was made against (= on-chain metadataHash). */
  criteriaHash: string
  /** Integer 0..100. */
  score: number
}

export function canonicalEvaluationString(i: EvaluationHashInput): string {
  if (!Number.isInteger(i.score) || i.score < 0 || i.score > 100) {
    throw new RangeError("score must be an integer between 0 and 100")
  }
  return JSON.stringify({
    v: EVALUATION_HASH_VERSION,
    evaluationId: i.evaluationId.toLowerCase(),
    submissionId: i.submissionId.toLowerCase(),
    criteriaHash: i.criteriaHash.toLowerCase(),
    score: i.score,
  })
}

export function computeEvaluationHash(i: EvaluationHashInput): `0x${string}` {
  return keccak256(toBytes(canonicalEvaluationString(i)))
}
