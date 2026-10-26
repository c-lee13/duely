import { formatUnits, parseUnits } from "viem"

import { paymentTokenInfo } from "./config"
import { deployments as generatedDeployments } from "./generated/deployments"

/**
 * Token amount helpers. Amounts are always `bigint` base units; decimal strings only cross JSON
 * boundaries (CLAUDE.md `TokenAmount`). No floating-point is ever used for money.
 * Note: tsconfig targets ES2017, so bigint literals (`1n`) are not allowed; use BigInt().
 */

/**
 * Decimals of the dUSD demo token (6). Kept for existing callers; it does NOT follow
 * DUELY_DEPLOYMENT. Use `tokenDecimals()` or the `*Token*` helpers for the active token.
 */
export const DUSD_DECIMALS: number = generatedDeployments.dusd.token.decimals

/** Decimals of the active payment token (6 for dUSD, 18 for RLUSD), resolved on every call. */
export function tokenDecimals(): number {
  return paymentTokenInfo.decimals
}
export const MAX_UINT256: bigint = (BigInt(1) << BigInt(256)) - BigInt(1)

/** Advance ceiling = 90% of the invoice (the client's slider can only lower it), as in InvoiceAdvance.sol. */
export const ADVANCE_BPS: bigint = BigInt(9000)
export const BPS_DENOMINATOR: bigint = BigInt(10000)
/** V2 client slider: the share of the 90% ceiling a freelancer may draw early (5000..10000 bps). */
export const MIN_ADVANCE_SHARE_BPS: bigint = BigInt(5000)
export const MAX_ADVANCE_SHARE_BPS: bigint = BPS_DENOMINATOR
/** V2 financing fee: fixed 10% of the invoice, paid to the vault at settlement whatever the slider says. */
export const FEE_BPS: bigint = BigInt(1000)

export function assertAdvanceShareBps(advanceShareBps: bigint): void {
  if (advanceShareBps < MIN_ADVANCE_SHARE_BPS || advanceShareBps > MAX_ADVANCE_SHARE_BPS) {
    throw new RangeError("advanceShareBps must be between 5000 and 10000")
  }
}

const BASE_UNITS_STRING = /^\d+$/

function assertUint256(value: bigint, what: string): void {
  if (typeof value !== "bigint") throw new TypeError(`${what} must be a bigint`)
  if (value < BigInt(0) || value > MAX_UINT256) {
    throw new RangeError(`${what} is outside the uint256 range`)
  }
}

/**
 * Parses a human amount ("1000", "12.5") to base units for a token with `decimals` decimals.
 * Rejects extra decimals, signs and exponents; never rounds.
 */
export function parseTokenUnits(
  value: string,
  decimals: number,
  label = "token"
): bigint {
  assertDecimals(decimals)
  const pattern = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`)
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new RangeError(
      `invalid ${label} amount: expected a non-negative decimal with at most ${decimals} decimals`
    )
  }
  const parsed = parseUnits(value, decimals)
  assertUint256(parsed, "amount")
  return parsed
}

/** Formats base units as a human string without trailing zeros ("1000", "12.5"). */
export function formatTokenUnits(value: bigint, decimals: number): string {
  assertDecimals(decimals)
  assertUint256(value, "amount")
  return formatUnits(value, decimals)
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError("decimals must be an integer between 0 and 36")
  }
}

/** Parses a human amount using the ACTIVE deployment's token decimals and symbol. */
export function parseToken(value: string): bigint {
  return parseTokenUnits(
    value,
    paymentTokenInfo.decimals,
    paymentTokenInfo.symbol
  )
}

/** Formats base units using the ACTIVE deployment's token decimals. */
export function formatToken(value: bigint): string {
  return formatTokenUnits(value, paymentTokenInfo.decimals)
}

/** @deprecated Alias of `parseToken` (active token). Kept for existing dUSD callers. */
export const parseDusd = parseToken

/** @deprecated Alias of `formatToken` (active token). Kept for existing dUSD callers. */
export const formatDusd = formatToken

/** Base-unit bigint -> decimal string for JSON (CLAUDE.md `TokenAmount`). */
export function toTokenAmount(value: bigint): string {
  assertUint256(value, "amount")
  return value.toString(10)
}

/** Decimal base-unit string from JSON -> bigint. Rejects decimals, signs, exponents, whitespace. */
export function fromTokenAmount(value: string): bigint {
  if (typeof value !== "string" || !BASE_UNITS_STRING.test(value)) {
    throw new RangeError(
      "invalid token amount: expected a string of decimal digits"
    )
  }
  const parsed = BigInt(value)
  assertUint256(parsed, "amount")
  return parsed
}

/**
 * Advance the contract will pay for an invoice amount (floor division, integer math only):
 * floor(amount * 9000 * advanceShareBps / 1e8). `advanceShareBps` defaults to 10000 (the 90% ceiling), which is
 * also the only value the V1 contracts know.
 */
export function advanceAmountFor(amount: bigint, advanceShareBps: bigint = MAX_ADVANCE_SHARE_BPS): bigint {
  assertUint256(amount, "amount")
  assertAdvanceShareBps(advanceShareBps)
  return (amount * ADVANCE_BPS * advanceShareBps) / (BPS_DENOMINATOR * BPS_DENOMINATOR)
}

/** V2 financing fee for an invoice amount: floor(amount * 1000 / 10000). */
export function advanceFeeFor(amount: bigint): bigint {
  assertUint256(amount, "amount")
  return (amount * FEE_BPS) / BPS_DENOMINATOR
}
