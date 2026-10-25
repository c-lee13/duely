import { formatUnits, parseUnits } from "viem"

import { paymentTokenInfo } from "./config"

/**
 * Token amount helpers. Amounts are always `bigint` base units; decimal strings only cross JSON
 * boundaries (CLAUDE.md `TokenAmount`). No floating-point is ever used for money.
 * Note: tsconfig targets ES2017, so bigint literals (`1n`) are not allowed; use BigInt().
 */

export const DUSD_DECIMALS: number = paymentTokenInfo.decimals
export const MAX_UINT256: bigint = (BigInt(1) << BigInt(256)) - BigInt(1)

/** Advance = floor(amount * ADVANCE_BPS / BPS_DENOMINATOR), as in InvoiceAdvance.sol. */
export const ADVANCE_BPS: bigint = BigInt(9000)
export const BPS_DENOMINATOR: bigint = BigInt(10000)

const DECIMAL_STRING = new RegExp(`^\\d+(\\.\\d{1,${DUSD_DECIMALS}})?$`)
const BASE_UNITS_STRING = /^\d+$/

function assertUint256(value: bigint, what: string): void {
  if (typeof value !== "bigint") throw new TypeError(`${what} must be a bigint`)
  if (value < BigInt(0) || value > MAX_UINT256) {
    throw new RangeError(`${what} is outside the uint256 range`)
  }
}

/** Parses a human dUSD amount ("1000", "12.5") to base units. Rejects extra decimals, never rounds. */
export function parseDusd(value: string): bigint {
  if (typeof value !== "string" || !DECIMAL_STRING.test(value)) {
    throw new RangeError(
      `invalid dUSD amount: expected a non-negative decimal with at most ${DUSD_DECIMALS} decimals`
    )
  }
  const parsed = parseUnits(value, DUSD_DECIMALS)
  assertUint256(parsed, "amount")
  return parsed
}

/** Formats base units as a human dUSD string without trailing zeros ("1000", "12.5"). */
export function formatDusd(value: bigint): string {
  assertUint256(value, "amount")
  return formatUnits(value, DUSD_DECIMALS)
}

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

/** Advance the contract will pay for an invoice amount (floor division, integer math only). */
export function advanceAmountFor(amount: bigint): bigint {
  assertUint256(amount, "amount")
  return (amount * ADVANCE_BPS) / BPS_DENOMINATOR
}
