/**
 * Error codes shared by mock and API adapters. API mode maps
 * `{ error: { code, message } }` responses (CLAUDE.md §8) onto this class.
 */
export type DomainErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "INVALID_STATUS"
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_RESERVE"
  | "ALREADY_ADVANCED"
  | "NOT_ELIGIBLE"
  | "DUPLICATE_REQUEST"
  | "TX_FAILED"
  | "EVALUATION_FAILED"
  | "NOT_IMPLEMENTED"
  | "UNAUTHENTICATED"
  | "INTEGRATION_UNAVAILABLE"
  // browser wallet / transaction lifecycle (live mode)
  | "NO_WALLET"
  | "WALLET_NOT_CONNECTED"
  | "WRONG_NETWORK"
  | "WRONG_ACCOUNT"
  | "USER_REJECTED"
  | "TX_UNCONFIRMED"
  | "TOKEN_PAUSED"
  | "REGISTRATION_PENDING"

export class DomainError extends Error {
  readonly code: DomainErrorCode
  /** The backend's own error code (for example CHAIN_TX_PENDING) when the error came from an API response. */
  readonly apiCode?: string

  constructor(code: DomainErrorCode, message: string, apiCode?: string) {
    super(message)
    this.name = "DomainError"
    this.code = code
    this.apiCode = apiCode
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return "Something went wrong."
}
