import { keccak256, toBytes } from "viem"
import type { Bytes32 } from "@/lib/frontend/domain"

/**
 * Canonical acceptance-criteria representation and hash.
 *
 * STATUS: PROPOSED. CLAUDE.md §6 makes the canonical encoding and the shared Keccak-256 helper the integration
 * owner's decision, and it is not frozen. This implements the proposal in that section (versioned, ordered
 * {id, text, mandatory} entries, NFC-normalized UTF-8, Keccak-256) so the API can be built and tested. If the
 * integration owner chooses a different encoding, replace this one module: invoice registration compares the
 * on-chain hash with this function's output and will (correctly) reject mismatches until the two agree.
 * `lib/frontend/criteria-digest.ts` is a MOCK-ONLY placeholder and is NOT this hash.
 */
export const CRITERIA_ENCODING_VERSION = 1

export interface CanonicalCriterion {
  id: string
  text: string
  mandatory: boolean
}

export function normalizeCriteria(criteria: readonly CanonicalCriterion[]): CanonicalCriterion[] {
  return criteria.map((c) => ({ id: c.id, text: c.text.normalize("NFC").trim(), mandatory: c.mandatory === true }))
}

/** `{"v":1,"criteria":[{"id":..,"text":..,"mandatory":..},...]}`: fixed key order, no whitespace, order preserved. */
export function canonicalCriteriaString(criteria: readonly CanonicalCriterion[]): string {
  const entries = normalizeCriteria(criteria).map((c) => ({ id: c.id, text: c.text, mandatory: c.mandatory }))
  return JSON.stringify({ v: CRITERIA_ENCODING_VERSION, criteria: entries })
}

export function computeCriteriaHash(criteria: readonly CanonicalCriterion[]): Bytes32 {
  return keccak256(toBytes(canonicalCriteriaString(criteria))) as Bytes32
}
