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

/**
 * Message for a failed wallet sign-in. The server accepts sign-in POSTs only from the origin it is configured for (the request's own
 * origin, or NEXT_PUBLIC_SITE_URL), which is a CSRF protection and stays as it is. In local development that is
 * http://localhost:3000, so opening the app at 127.0.0.1 or a network address makes sign-in fail with BAD_ORIGIN. Say so in plain words.
 */
export function signInErrorMessage(error: unknown, currentOrigin?: string): string {
  if ((error as { code?: unknown } | null)?.code === "BAD_ORIGIN") {
    const where = currentOrigin ? ` (you are on ${currentOrigin})` : ""
    return `Sign-in is only accepted from the address this app was started on${where}. Open the app at http://localhost:3000, or at the address set in NEXT_PUBLIC_SITE_URL, then try again.`
  }
  return errorMessage(error)
}
