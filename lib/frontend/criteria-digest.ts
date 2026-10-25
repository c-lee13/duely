import { computeCriteriaHash } from "@/lib/shared/criteria"
import type { AcceptanceCriterion } from "./domain"

/**
 * The criteria hash the UI shows and (in live mode) commits on-chain as `metadataHash`. It is the SAME function the
 * backend uses to verify the commitment (lib/shared/criteria.ts): there is no separate frontend/mock encoding.
 * `version` is the invoice's criteria version; it is stored next to the hash, not hashed (criteria are immutable per invoice).
 */
export function criteriaDigest(_version: number, criteria: AcceptanceCriterion[]): `0x${string}` {
  void _version
  return computeCriteriaHash(criteria)
}

/** Kept for the mock ledger's existing call sites; identical to `criteriaDigest`. */
export const mockCriteriaDigest = criteriaDigest

export function shortHash(hash: string, chars = 6): string {
  if (hash.length <= chars * 2 + 2) return hash
  return `${hash.slice(0, chars + 2)}…${hash.slice(-chars)}`
}
