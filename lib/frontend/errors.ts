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

export class DomainError extends Error {
  readonly code: DomainErrorCode

  constructor(code: DomainErrorCode, message: string) {
    super(message)
    this.name = "DomainError"
    this.code = code
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return "Something went wrong."
}
