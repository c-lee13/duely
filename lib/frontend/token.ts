import { paymentTokenInfo } from "@/lib/chain/config"
import { DATA_MODE, type DataMode } from "./data-mode"
import type { TokenAmount } from "./domain"

export const ADVANCE_BPS_NUMERATOR = BigInt(90)
export const ADVANCE_BPS_DENOMINATOR = BigInt(100)

const ZERO = BigInt(0)
const HUNDRED = BigInt(100)

/**
 * What the UI calls and how it scales the payment token.
 *
 * - Live (api) mode: the ACTIVE deployment's token from the chain SDK (`paymentTokenInfo`): dUSD = 6 decimals and a
 *   demo token, RLUSD = 18 decimals and NOT a demo token. Nothing here is hard-coded to one token.
 * - Mock mode: every figure is simulated and never touches a chain, so it keeps a clearly fictional "DEMO" token
 *   (18 decimals) rather than borrowing a real token's name.
 */
export interface TokenDisplay {
  symbol: string
  name: string
  decimals: number
  /** A token with no value (dUSD, or the mock-mode DEMO token). RLUSD is false. */
  isDemoToken: boolean
  /** True only in mock mode. */
  simulated: boolean
}

export const MOCK_TOKEN: TokenDisplay = {
  symbol: "DEMO",
  name: "Duely Demo Token (simulated)",
  decimals: 18,
  isDemoToken: true,
  simulated: true,
}

export function tokenDisplay(mode: DataMode = DATA_MODE): TokenDisplay {
  if (mode === "mock") return MOCK_TOKEN
  return {
    symbol: paymentTokenInfo.symbol,
    name: paymentTokenInfo.name,
    decimals: paymentTokenInfo.decimals,
    isDemoToken: paymentTokenInfo.isDemoToken,
    simulated: false,
  }
}

/** One honest sentence about the token in use, for footers and notices. */
export function tokenNotice(token: TokenDisplay = tokenDisplay()): string {
  if (token.simulated) return `${token.symbol} tokens are simulated: not RLUSD and not real dollars.`
  if (token.isDemoToken) return `${token.symbol} is a demo token with no real value; it is not USDC or RLUSD.`
  return `${token.symbol} is the issuer's XRPL EVM testnet token (test funds). Its issuer can pause or claw back test balances.`
}

const unitOf = (token: TokenDisplay) => BigInt(10) ** BigInt(token.decimals)

export function toBig(amount: TokenAmount): bigint {
  return BigInt(amount)
}

/** floor(amount * 90 / 100) in base units: the contract's rule (identical at 6 and 18 decimals). */
export function advanceFor(amount: TokenAmount): TokenAmount {
  return ((toBig(amount) * ADVANCE_BPS_NUMERATOR) / ADVANCE_BPS_DENOMINATOR).toString()
}

/** Convert whole/decimal token text (e.g. "1000.5") to base units. Returns null if invalid. */
export function parseTokenInput(text: string, token: TokenDisplay = tokenDisplay()): TokenAmount | null {
  const trimmed = text.trim().replace(/,/g, "")
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const [whole, fraction = ""] = trimmed.split(".")
  if (fraction.length > token.decimals) return null
  const padded = fraction.padEnd(token.decimals, "0")
  return (BigInt(whole) * unitOf(token) + BigInt(padded || "0")).toString()
}

/** Whole tokens → base units. For fixtures only. */
export function tokens(whole: number | bigint, token: TokenDisplay = tokenDisplay()): TokenAmount {
  return (BigInt(whole) * unitOf(token)).toString()
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** Display formatting only. Truncates (never rounds up) to `maxFraction` digits. */
export function formatToken(
  amount: TokenAmount,
  { maxFraction = 2, symbol = true, token = tokenDisplay() }: { maxFraction?: number; symbol?: boolean; token?: TokenDisplay } = {}
): string {
  const unit = unitOf(token)
  const value = toBig(amount)
  const negative = value < ZERO
  const abs = negative ? -value : value
  const whole = abs / unit
  const fraction = (abs % unit)
    .toString()
    .padStart(token.decimals, "0")
    .slice(0, maxFraction)
    .replace(/0+$/, "")
  const text = `${negative ? "-" : ""}${groupThousands(whole.toString())}${fraction ? `.${fraction}` : ""}`
  return symbol ? `${text} ${token.symbol}` : text
}

export function sum(amounts: TokenAmount[]): TokenAmount {
  return amounts.reduce((acc, a) => acc + toBig(a), ZERO).toString()
}

export function sub(a: TokenAmount, b: TokenAmount): TokenAmount {
  return (toBig(a) - toBig(b)).toString()
}

export function gte(a: TokenAmount, b: TokenAmount): boolean {
  return toBig(a) >= toBig(b)
}

export function isZero(a: TokenAmount): boolean {
  return toBig(a) === ZERO
}

/** Integer percentage of part/whole for progress bars (display only). */
export function percentOf(part: TokenAmount, whole: TokenAmount): number {
  const w = toBig(whole)
  if (w === ZERO) return 0
  return Number((toBig(part) * HUNDRED) / w)
}
