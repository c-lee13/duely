import { BaseError, ContractFunctionRevertedError } from "viem"

export type ChainReadErrorCode =
  | "INVALID_INVOICE_ID"
  | "INVALID_ADDRESS"
  | "INVOICE_NOT_FOUND"
  | "CONTRACT_REVERT"
  | "UNEXPECTED_RESPONSE"
  | "RPC_BEHIND"
  | "RPC_ERROR"

/**
 * Error thrown by the read SDK. Messages are sanitized: they never contain RPC URLs, so a
 * server-side authenticated endpoint (QuickNode) cannot leak through logs or API responses.
 * The original provider error is deliberately not attached as `cause`.
 */
export class ChainReadError extends Error {
  readonly code: ChainReadErrorCode

  constructor(code: ChainReadErrorCode, message: string) {
    super(message)
    this.name = "ChainReadError"
    this.code = code
  }
}

/** Replaces any URL in free text with a placeholder. */
export function redactUrls(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi, "<url>")
}

/** Maps a viem/provider failure to a sanitized ChainReadError. */
export function toChainReadError(
  error: unknown,
  action: string
): ChainReadError {
  if (error instanceof ChainReadError) return error

  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName
      if (name === "InvoiceNotFound") {
        return new ChainReadError(
          "INVOICE_NOT_FOUND",
          `${action}: invoice does not exist`
        )
      }
      return new ChainReadError(
        "CONTRACT_REVERT",
        `${action} reverted${name ? `: ${name}` : ""}`
      )
    }
    return new ChainReadError(
      "RPC_ERROR",
      `${action} failed: ${redactUrls(error.shortMessage)}`
    )
  }

  const message = error instanceof Error ? error.message : String(error)
  return new ChainReadError(
    "RPC_ERROR",
    `${action} failed: ${redactUrls(message)}`
  )
}

// ---- writes ------------------------------------------------------------------------------------

export type ChainWriteErrorCode =
  | "INVALID_INPUT"
  | "WRONG_CHAIN"
  | "NO_ACCOUNT"
  | "UNAUTHORIZED_SIGNER"
  | "INVOICE_NOT_FOUND"
  | "INSUFFICIENT_ALLOWANCE"
  | "INSUFFICIENT_BALANCE"
  | "TOKEN_PAUSED"
  | "DEPLOYMENT_MISMATCH"
  | "SIMULATION_REVERTED"
  | "USER_REJECTED"
  | "DUPLICATE_SUBMISSION"
  | "RPC_ERROR"
  | "SEND_FAILED"
  | "TX_REVERTED"
  | "TX_REPLACED"
  | "RECEIPT_MISMATCH"
  | "WAIT_TIMEOUT"

/**
 * Error thrown by the write SDK. Sanitized like ChainReadError (no RPC URLs, no attached cause).
 * Non-idempotent writes are never retried automatically: after SEND_FAILED, TX_REVERTED or
 * WAIT_TIMEOUT, check the chain (or `txHash`) before submitting again.
 */
export class ChainWriteError extends Error {
  readonly code: ChainWriteErrorCode
  /** Decoded custom-error name for revert-related codes, e.g. "InvalidStatus". */
  readonly revertName?: string
  /**
   * The relevant transaction hash: the submitted tx for TX_REVERTED / WAIT_TIMEOUT /
   * TX_REPLACED / RECEIPT_MISMATCH, or the still-pending tx for DUPLICATE_SUBMISSION.
   */
  readonly txHash?: string
  /** For TX_REPLACED: the hash of the transaction that replaced `txHash`. */
  readonly replacementHash?: string

  constructor(
    code: ChainWriteErrorCode,
    message: string,
    details?: { revertName?: string; txHash?: string; replacementHash?: string }
  ) {
    super(message)
    this.name = "ChainWriteError"
    this.code = code
    this.revertName = details?.revertName
    this.txHash = details?.txHash
    this.replacementHash = details?.replacementHash
  }
}
