import { verifyMessage } from "viem"
import type { Address } from "@/lib/frontend/domain"
import { buildChallengeMessage, CHALLENGE_TTL_MS, generateNonce, normalizeAddress } from "./wallet-message"

export type WalletAuthErrorCode =
  | "INVALID_ADDRESS"
  | "INVALID_SIGNATURE_FORMAT"
  | "RATE_LIMITED"
  | "CHALLENGE_INVALID"
  | "BAD_SIGNATURE"
  | "WALLET_TAKEN"
  | "WALLET_LIMIT"

const STATUS: Record<WalletAuthErrorCode, number> = {
  INVALID_ADDRESS: 400,
  INVALID_SIGNATURE_FORMAT: 400,
  RATE_LIMITED: 429,
  CHALLENGE_INVALID: 401,
  BAD_SIGNATURE: 401,
  WALLET_TAKEN: 409,
  WALLET_LIMIT: 409,
}

export class WalletAuthError extends Error {
  readonly status: number
  constructor(
    readonly code: WalletAuthErrorCode,
    message: string
  ) {
    super(message)
    this.name = "WalletAuthError"
    this.status = STATUS[code]
  }
}

/** Translates the SQL functions' error messages into WalletAuthError. Exported for tests. */
export function mapWalletDbError(message: string): WalletAuthError | null {
  if (message.includes("WALLET_CHALLENGE_RATE_LIMITED"))
    return new WalletAuthError("RATE_LIMITED", "Too many sign-in attempts for this wallet. Wait a few minutes and try again.")
  if (message.includes("WALLET_OWNED_BY_OTHER"))
    return new WalletAuthError("WALLET_TAKEN", "This wallet is already verified for a different account.")
  if (message.includes("WALLET_LIMIT_REACHED"))
    return new WalletAuthError("WALLET_LIMIT", "This account already has the maximum number of verified wallets.")
  return null
}

/** Persistence for challenges. The production implementation calls the service-role-only SQL functions. */
export interface WalletChallengeStore {
  create(c: { address: Address; nonce: string; message: string; expiresAt: Date }): Promise<void>
  /** Atomically burns the challenge and returns the exact issued message, or null if unknown/used/expired/wrong address. */
  consume(c: { nonce: string; address: Address }): Promise<string | null>
}

export interface WalletBindingStore {
  findVerifiedOwner(address: Address): Promise<string | null>
  /** Call only after verifyChallengeSignature succeeded for this address and nonce. */
  bind(b: { userId: string; address: Address; nonce: string }): Promise<void>
}

export interface IssuedChallenge {
  address: Address
  nonce: string
  message: string
  expiresAt: Date
}

export async function issueChallenge(
  store: WalletChallengeStore,
  input: { address: unknown; domain: string; chainId?: number; now?: Date }
): Promise<IssuedChallenge> {
  const address = normalizeAddress(input.address)
  if (!address) throw new WalletAuthError("INVALID_ADDRESS", "Enter a valid 0x wallet address.")
  const issuedAt = input.now ?? new Date()
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS)
  const nonce = generateNonce()
  const message = buildChallengeMessage({ domain: input.domain, address, nonce, issuedAt, expiresAt, chainId: input.chainId })
  await store.create({ address, nonce, message, expiresAt })
  return { address, nonce, message, expiresAt }
}

/**
 * Proves control of `address`: consumes the single-use challenge, then checks the EIP-191 signature over the
 * STORED message. Returns the verified lower-case address. The challenge is burned even when the signature is
 * wrong, so a nonce can never be guessed at twice. Smart-contract wallets (ERC-1271) are not supported.
 */
export async function verifyChallengeSignature(
  store: WalletChallengeStore,
  input: { address: unknown; nonce: unknown; signature: unknown }
): Promise<Address> {
  const address = normalizeAddress(input.address)
  if (!address) throw new WalletAuthError("INVALID_ADDRESS", "Enter a valid 0x wallet address.")
  if (typeof input.nonce !== "string" || input.nonce.length < 16 || input.nonce.length > 128)
    throw new WalletAuthError("CHALLENGE_INVALID", "This sign-in request is invalid or expired. Start again.")
  if (typeof input.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(input.signature))
    throw new WalletAuthError("INVALID_SIGNATURE_FORMAT", "The signature is malformed.")

  const message = await store.consume({ nonce: input.nonce, address })
  if (message === null)
    throw new WalletAuthError("CHALLENGE_INVALID", "This sign-in request is invalid, already used, or expired. Start again.")

  let valid = false
  try {
    valid = await verifyMessage({ address, message, signature: input.signature as `0x${string}` })
  } catch {
    valid = false
  }
  if (!valid) throw new WalletAuthError("BAD_SIGNATURE", "That signature does not match this wallet address.")
  return address
}
