import { isV2 } from "@/lib/chain/protocol"
import { DATA_MODE } from "./data-mode"
import type { TokenAmount } from "./domain"

/**
 * What the UI says (and computes for previews) depends on the protocol behind the active deployment:
 *   v1  advances come from a platform-funded RESERVE; settlement repays the actual advance; payouts are pushed.
 *   v2  advances come from the DuelyVault (LP-funded); settlement repays advance + a fixed 10% fee to the vault; the
 *       freelancer's remainder and any client refund are CREDITED and must be claimed (pull payments).
 * Mock mode always uses v1 semantics (it simulates the original demo and never touches a chain).
 */

/** True only in live mode with the v2 deployment selected. A misconfigured selection counts as v1 here and is reported where the chain is used. */
export function v2Active(): boolean {
  if (DATA_MODE !== "api") return false
  try {
    return isV2()
  } catch {
    return false
  }
}

const FEE_BPS = BigInt(1000)
const BPS = BigInt(10000)

/** v2 financing fee: floor(amount * 1000 / 10000), the contract's own formula (InvoiceAdvanceV2.quoteAdvance). 0 under v1. */
export function advanceFeeFor(amount: TokenAmount): TokenAmount {
  return v2Active() ? ((BigInt(amount) * FEE_BPS) / BPS).toString() : "0"
}

export interface FundingCopy {
  /** "the platform reserve" / "the liquidity vault" */
  source: string
  /** "reserve" / "vault" */
  short: string
  /** True when settlement/refund proceeds are claimed rather than pushed. */
  pull: boolean
}

/** Label of the platform/operator nav entry. */
export const platformNavLabel = (): string => (v2Active() ? "Liquidity" : "Reserve")

export function fundingCopy(): FundingCopy {
  return v2Active() ? { source: "the liquidity vault", short: "vault", pull: true } : { source: "the platform reserve", short: "reserve", pull: false }
}
