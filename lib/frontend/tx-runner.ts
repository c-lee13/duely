import {
  ChainWriteError,
  explorerTxUrl,
  serializeSubmittedTransaction,
  trackTransaction,
  type ConfirmedTransaction,
  type SubmittedTransaction,
  type TransactionStatus,
  type WriteContext,
} from "@/lib/chain"
import type { Address, Bytes32, UiTxAction } from "./domain"
import { DomainError, type DomainErrorCode } from "./errors"
import type { TxLog } from "./tx-log"

/**
 * One wallet transaction, from "ask the wallet" to a VERIFIED outcome. This is the only place the live UI turns a hash
 * into a result, and it returns normally only for `confirmed`: mined, succeeded, AND carrying the expected event for the
 * exact operation that was submitted (the SDK's `trackTransaction`). A pending, unknown, reverted, replaced or unverified
 * transaction throws a DomainError and is never reported as done, so a caller cannot show a payment that did not happen.
 */
export type TxStep = "awaiting_wallet" | "pending" | "confirmed" | "failed" | "unknown"

export interface TxProgress {
  /** Stable for one transaction attempt (the hash once known). */
  id: string
  label: string
  status: TxStep
  txHash?: Bytes32
  explorerUrl?: string
  error?: string
}
export type ProgressListener = (progress: TxProgress) => void

/** Maps the SDK's write errors to the UI's error codes. Messages are the SDK's own (already free of RPC URLs and keys). */
export function toDomainError(e: unknown): DomainError {
  if (e instanceof DomainError) return e
  if (e instanceof ChainWriteError) {
    const map: Partial<Record<ChainWriteError["code"], DomainErrorCode>> = {
      INVALID_INPUT: "INVALID_INPUT",
      WRONG_CHAIN: "WRONG_NETWORK",
      NO_ACCOUNT: "WALLET_NOT_CONNECTED",
      UNAUTHORIZED_SIGNER: "FORBIDDEN",
      INVOICE_NOT_FOUND: "NOT_FOUND",
      INSUFFICIENT_ALLOWANCE: "INSUFFICIENT_BALANCE",
      INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
      TOKEN_PAUSED: "TOKEN_PAUSED",
      SIMULATION_REVERTED: "TX_FAILED",
      USER_REJECTED: "USER_REJECTED",
      DUPLICATE_SUBMISSION: "DUPLICATE_REQUEST",
      DEPLOYMENT_MISMATCH: "INTEGRATION_UNAVAILABLE",
      RPC_ERROR: "INTEGRATION_UNAVAILABLE",
      // The wallet may or may not have broadcast it: never claim failure, never invite a blind retry.
      SEND_FAILED: "TX_UNCONFIRMED",
      WAIT_TIMEOUT: "TX_UNCONFIRMED",
      TX_REVERTED: "TX_FAILED",
      TX_REPLACED: "TX_FAILED",
      RECEIPT_MISMATCH: "TX_FAILED",
    }
    return new DomainError(map[e.code] ?? "TX_FAILED", e.message)
  }
  return new DomainError("TX_FAILED", e instanceof Error ? e.message : "The transaction failed.")
}

let attempt = 0

export interface RunTransactionInput {
  label: string
  action: UiTxAction
  from: Address
  invoiceId?: string
  ctx: WriteContext
  /** Asks the wallet to sign and send. Throws ChainWriteError for validation/simulation/user rejection. */
  submit: () => Promise<SubmittedTransaction>
  log?: TxLog
  onProgress?: ProgressListener
  /** How long to wait for a verified outcome before reporting "still unconfirmed" (default 120 s). */
  timeoutMs?: number
  meta?: Record<string, unknown>
}

export async function runTransaction(input: RunTransactionInput): Promise<ConfirmedTransaction> {
  const { label, ctx, onProgress, log } = input
  const localId = `${label}#${++attempt}`
  const emit = (p: Omit<TxProgress, "id" | "label"> & { id?: string }) => onProgress?.({ id: localId, label, ...p })

  emit({ status: "awaiting_wallet" })
  let submitted: SubmittedTransaction
  try {
    submitted = await input.submit()
  } catch (e) {
    const err = toDomainError(e)
    emit({ status: "failed", error: err.message })
    throw err
  }

  const base = { txHash: submitted.hash as Bytes32, explorerUrl: explorerTxUrl(submitted.hash) }
  log?.add({
    hash: submitted.hash as Bytes32,
    label,
    action: input.action,
    invoiceId: input.invoiceId,
    from: input.from,
    createdAt: Date.now(),
    status: "pending",
    explorerUrl: base.explorerUrl,
    serialized: serializeSubmittedTransaction(submitted),
    meta: input.meta,
  })
  emit({ status: "pending", ...base })

  let status: TransactionStatus
  try {
    status = await trackTransaction(submitted, { publicClient: ctx.publicClient, timeoutMs: input.timeoutMs ?? 120_000 })
  } catch (e) {
    const err = toDomainError(e)
    log?.update(submitted.hash, { status: "unknown", error: err.message })
    emit({ status: "unknown", ...base, error: err.message })
    throw err
  }

  switch (status.state) {
    case "confirmed":
      log?.update(submitted.hash, { status: "confirmed", blockNumber: status.blockNumber.toString(10) })
      emit({ status: "confirmed", ...base })
      return status
    case "reverted":
    case "replaced":
    case "unverified": {
      const message = `${status.error.message} Nothing was changed by this transaction.`
      log?.update(submitted.hash, { status: "failed", error: message })
      emit({ status: "failed", ...base, error: message })
      throw new DomainError("TX_FAILED", message)
    }
    default: {
      // pending / unknown: the outcome is not known. It may still land: say so, and never invite a duplicate.
      const message = `The transaction ${submitted.hash} isn't confirmed yet. It may still complete; check it on the explorer before trying again. Do not send it twice.`
      log?.update(submitted.hash, { status: "unknown", error: message })
      emit({ status: "unknown", ...base, error: message })
      throw new DomainError("TX_UNCONFIRMED", message)
    }
  }
}
