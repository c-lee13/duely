import type { AcceptanceCriterion } from "./domain"

/**
 * MOCK ONLY — NOT the on-chain criteria hash.
 *
 * CLAUDE.md §6 requires one canonical criteria encoding + Keccak-256, owned by
 * the integration owner and not yet frozen. Until then this produces a stable,
 * clearly-labeled placeholder digest from a canonical (ordered, NFC-normalized)
 * representation so the UI can show "criteria locked" behavior. Replace with
 * the shared hashing helper from `lib/shared` when it is published.
 */
export function canonicalCriteria(version: number, criteria: AcceptanceCriterion[]): string {
  const entries = criteria.map((c) => [c.id, c.text.normalize("NFC").trim(), c.mandatory ? 1 : 0])
  return JSON.stringify(["duely-criteria", version, entries])
}

function fnv1a32(text: string, seed: number): number {
  let hash = 0x811c9dc5 ^ seed
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function mockCriteriaDigest(version: number, criteria: AcceptanceCriterion[]): `0x${string}` {
  const canonical = canonicalCriteria(version, criteria)
  let hex = ""
  for (let round = 0; round < 8; round++) {
    hex += fnv1a32(canonical, round * 0x9e3779b1).toString(16).padStart(8, "0")
  }
  return `0x${hex}`
}

export function shortHash(hash: string, chars = 6): string {
  if (hash.length <= chars * 2 + 2) return hash
  return `${hash.slice(0, chars + 2)}…${hash.slice(-chars)}`
}
