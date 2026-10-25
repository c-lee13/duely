import { keccak256, toBytes } from "viem"

/**
 * THE canonical acceptance-criteria encoding and its hash. One module, used by the browser (before it sends
 * `createInvoice`), the backend (when it verifies the on-chain commitment) and tests. Do not re-implement it.
 *
 * Encoding (version 1, FROZEN: a change is a new version, never an edit):
 *   1. every entry is `{ id, text, mandatory }`; `text` is Unicode NFC-normalized and trimmed, `mandatory` is a boolean;
 *   2. the entries keep the order the client gave them (order is part of the agreement);
 *   3. the document is `JSON.stringify({ v: 1, criteria: [...] })`: fixed key order, no whitespace;
 *   4. the hash is Keccak-256 over the UTF-8 bytes of that string, as a lower-case 0x-prefixed 32-byte hex.
 *
 * On-chain it is the contract's `metadataHash` (CONTRACT_SPEC v1.1): InvoiceAdvance stores any non-zero bytes32 and
 * emits it in `InvoiceCreated`, so the contract imposes no format; this rule is what makes the commitment verifiable.
 * The database column, the API field and the UI call the same value `criteriaHash`.
 */
export const CRITERIA_ENCODING_VERSION = 1

export type CriteriaHash = `0x${string}`

export interface CanonicalCriterion {
  id: string
  text: string
  mandatory: boolean
}

export function normalizeCriteria(
  criteria: readonly CanonicalCriterion[]
): CanonicalCriterion[] {
  return criteria.map((c) => ({
    id: c.id,
    text: c.text.normalize("NFC").trim(),
    mandatory: c.mandatory === true,
  }))
}

/** `{"v":1,"criteria":[{"id":..,"text":..,"mandatory":..},...]}`: fixed key order, no whitespace, order preserved. */
export function canonicalCriteriaString(
  criteria: readonly CanonicalCriterion[]
): string {
  const entries = normalizeCriteria(criteria).map((c) => ({
    id: c.id,
    text: c.text,
    mandatory: c.mandatory,
  }))
  return JSON.stringify({ v: CRITERIA_ENCODING_VERSION, criteria: entries })
}

export function computeCriteriaHash(
  criteria: readonly CanonicalCriterion[]
): CriteriaHash {
  return keccak256(toBytes(canonicalCriteriaString(criteria)))
}

/** The value to pass as `metadataHash` to `createInvoice`. Same bytes as `computeCriteriaHash`. */
export const computeMetadataHash = computeCriteriaHash
