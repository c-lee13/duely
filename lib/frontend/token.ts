import type { TokenAmount } from "./domain"

/**
 * Demo token metadata. MOCK ASSUMPTION: Track A has not published the token
 * address/decimals yet. Replace with the confirmed chain config when available.
 */
export const DEMO_TOKEN = {
  symbol: "DEMO",
  name: "Duely Demo Token",
  decimals: 18,
} as const

export const ADVANCE_BPS_NUMERATOR = BigInt(90)
export const ADVANCE_BPS_DENOMINATOR = BigInt(100)

const ZERO = BigInt(0)
const HUNDRED = BigInt(100)
const UNIT = BigInt(10) ** BigInt(DEMO_TOKEN.decimals)

export function toBig(amount: TokenAmount): bigint {
  return BigInt(amount)
}

/** floor(amount * 90 / 100) in base units — matches the contract rule. */
export function advanceFor(amount: TokenAmount): TokenAmount {
  return ((toBig(amount) * ADVANCE_BPS_NUMERATOR) / ADVANCE_BPS_DENOMINATOR).toString()
}

/** Convert whole/decimal token text (e.g. "1000.5") to base units. Returns null if invalid. */
export function parseTokenInput(text: string): TokenAmount | null {
  const trimmed = text.trim().replace(/,/g, "")
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const [whole, fraction = ""] = trimmed.split(".")
  if (fraction.length > DEMO_TOKEN.decimals) return null
  const padded = fraction.padEnd(DEMO_TOKEN.decimals, "0")
  return (BigInt(whole) * UNIT + BigInt(padded || "0")).toString()
}

/** Whole tokens → base units. For fixtures only. */
export function tokens(whole: number | bigint): TokenAmount {
  return (BigInt(whole) * UNIT).toString()
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** Display formatting only. Truncates (never rounds up) to `maxFraction` digits. */
export function formatToken(
  amount: TokenAmount,
  { maxFraction = 2, symbol = true }: { maxFraction?: number; symbol?: boolean } = {}
): string {
  const value = toBig(amount)
  const negative = value < ZERO
  const abs = negative ? -value : value
  const whole = abs / UNIT
  const fraction = (abs % UNIT)
    .toString()
    .padStart(DEMO_TOKEN.decimals, "0")
    .slice(0, maxFraction)
    .replace(/0+$/, "")
  const text = `${negative ? "-" : ""}${groupThousands(whole.toString())}${fraction ? `.${fraction}` : ""}`
  return symbol ? `${text} ${DEMO_TOKEN.symbol}` : text
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
