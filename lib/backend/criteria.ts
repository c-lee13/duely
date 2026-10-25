/**
 * Re-export of the single shared implementation (lib/shared/criteria.ts). Kept so existing imports keep working;
 * there is exactly one canonical encoding and hash, and it lives there.
 */
export {
  CRITERIA_ENCODING_VERSION,
  canonicalCriteriaString,
  computeCriteriaHash,
  computeMetadataHash,
  normalizeCriteria,
  type CanonicalCriterion,
  type CriteriaHash,
} from "@/lib/shared/criteria"
