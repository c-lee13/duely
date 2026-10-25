import { getAddress, isAddress } from "viem"
import type { Address } from "@/lib/frontend/domain"

/** How long a challenge may be signed. Short on purpose; the database also caps it at 15 minutes. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000

/**
 * Validates an EVM address (mixed-case input must pass the EIP-55 checksum) and returns it lower-case,
 * the only form stored in the database. Returns null for anything else.
 */
export function normalizeAddress(input: unknown): Address | null {
  if (typeof input !== "string" || !isAddress(input)) return null
  return input.toLowerCase() as Address
}

/** 128 bits of randomness as hex. Uses the platform CSPRNG (Node and browsers). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

export interface ChallengeFields {
  /** Host the user believes they are signing in to, e.g. "duely.example". Shown by wallets. */
  domain: string
  address: Address
  nonce: string
  issuedAt: Date
  expiresAt: Date
  /** Only included when the team has confirmed the chain id. Never guessed. */
  chainId?: number
}

/**
 * Human-readable sign-in message (EIP-4361 style). It is generated and STORED by the server; verification
 * always uses the stored copy, never text supplied by the browser.
 */
export function buildChallengeMessage(f: ChallengeFields): string {
  const lines = [
    `${f.domain} wants you to verify that you own this wallet.`,
    "",
    `Address: ${getAddress(f.address)}`,
    `Nonce: ${f.nonce}`,
    ...(f.chainId ? [`Chain ID: ${f.chainId}`] : []),
    `Issued At: ${f.issuedAt.toISOString()}`,
    `Expires At: ${f.expiresAt.toISOString()}`,
    "",
    "Signing is free and sends no blockchain transaction. It lets Duely link this wallet to your account.",
    "Only sign if you started this sign-in on the Duely site.",
  ]
  return lines.join("\n")
}
