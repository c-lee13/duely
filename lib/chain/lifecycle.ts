import {
  BaseError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  isAddress,
  isHex,
  parseEventLogs,
  size,
  type Abi,
  type Hex,
  type Transaction,
  type TransactionReceipt,
  type WaitForTransactionReceiptParameters,
} from "viem"

import { MAX_UINT256 } from "./amounts"
import { getPublicClient } from "./client"
import {
  CHAIN_ID,
  contractAddresses,
  explorerTxUrl,
  tryExplorerTxUrl,
} from "./config"
import { ChainWriteError } from "./errors"
import {
  ARG_KINDS,
  EXPECTED_EVENTS,
  isWriteFunctionName,
  type ExpectedReceipt,
} from "./expected"
import { invoiceAdvanceAbi, mockUsdcAbi } from "./generated"
import {
  mapWriteError,
  releaseByHash,
  type ChainWriteClient,
  type SubmittedTransaction,
} from "./writes"

/**
 * Transaction lifecycle for the write SDK: submitted -> pending -> one terminal outcome.
 *
 *   pending     the hash exists and is awaiting confirmation (or we are still looking)
 *   confirmed   mined, succeeded, AND (when you pass the SubmittedTransaction) carried the
 *               expected event from the expected contract sent by the expected account
 *   reverted    mined but reverted: nothing changed on-chain
 *   replaced    the wallet cancelled it or replaced it with a different transaction: the
 *               intended operation did NOT run, whatever the replacement's receipt says
 *   unverified  mined and "successful" but it does not prove the intended operation (wrong
 *               transaction, wrong sender/contract, missing or ambiguous event): do not treat it
 *               as success
 *   unknown     we could not determine the outcome (timeout, RPC failure, not found): the
 *               transaction MAY still land. Never resubmit; check again or inspect the hash.
 *
 * Use `trackTransaction(submitted)` for a state machine that never throws on these outcomes, or
 * `waitForConfirmation(submitted)` if you prefer success-or-throw. Always pass the whole
 * SubmittedTransaction, not just its hash: a bare hash cannot be checked against the operation.
 */

// ---- types -----------------------------------------------------------------------------------

export type InvoiceAdvanceEvent = ReturnType<
  typeof parseEventLogs<typeof invoiceAdvanceAbi>
>[number]

export type TransactionState =
  "pending" | "confirmed" | "reverted" | "replaced" | "unverified" | "unknown"

interface StatusBase {
  /** The hash to show or link: the mined transaction once known (after a fee bump, the replacement). */
  hash: Hex
  /** The hash that was submitted / waited on. */
  requestedHash: Hex
  /** Explorer link for `hash`. */
  explorerUrl: string
  /** Set when the SubmittedTransaction was supplied. */
  functionName?: string
}

export interface PendingStatus extends StatusBase {
  state: "pending"
  submittedAt?: number
}

/** The event that proved the operation, with decoded arguments (bigint values are base units / IDs). */
export interface MatchedEvent {
  eventName: string
  args: Record<string, unknown>
}

export interface ConfirmedTransaction extends StatusBase {
  state: "confirmed"
  /** Set only when the wallet replaced the transaction with a same-call fee bump. */
  feeBumpedFrom?: Hex
  receipt: TransactionReceipt
  blockNumber: bigint
  /** All InvoiceAdvance events emitted by this transaction, decoded. */
  events: InvoiceAdvanceEvent[]
  /**
   * True when the receipt was checked against the SubmittedTransaction's expected event. False
   * for a bare hash, which only proves a transaction with that hash succeeded.
   */
  verified: boolean
  /** The matched expected event, or null when `verified` is false. */
  event: MatchedEvent | null
  /** Decimal-string invoice ID taken from the verified event (null for events without one). */
  invoiceId: string | null
}

export interface RevertedStatus extends StatusBase {
  state: "reverted"
  receipt: TransactionReceipt
  blockNumber: bigint
  error: ChainWriteError
}

export interface ReplacedStatus extends StatusBase {
  state: "replaced"
  reason: "cancelled" | "replaced"
  replacementHash: Hex
  replacementExplorerUrl: string
  error: ChainWriteError
}

export interface UnverifiedStatus extends StatusBase {
  state: "unverified"
  receipt?: TransactionReceipt
  error: ChainWriteError
}

export interface UnknownStatus extends StatusBase {
  state: "unknown"
  /** timeout: not confirmed in time. rpc_error: lookup failed. not_found: neither mined nor in the mempool. */
  reason: "timeout" | "rpc_error" | "not_found"
  error: ChainWriteError
}

export type TransactionStatus =
  | PendingStatus
  | ConfirmedTransaction
  | RevertedStatus
  | ReplacedStatus
  | UnverifiedStatus
  | UnknownStatus

/** confirmed, reverted, replaced and unverified will not change; pending and unknown might. */
export function isTerminalStatus(
  status: TransactionStatus
): status is
  ConfirmedTransaction | RevertedStatus | ReplacedStatus | UnverifiedStatus {
  return status.state !== "pending" && status.state !== "unknown"
}

export interface WaitOptions {
  publicClient?: ChainWriteClient
  /** Default 1. */
  confirmations?: number
  /** Default 120_000. */
  timeoutMs?: number
}

export interface TrackOptions extends WaitOptions {
  /** Called with `pending` immediately and with the final status. Errors it throws are ignored. */
  onStatus?: (status: TransactionStatus) => void
}

// ---- event decoding ----------------------------------------------------------------------------

/** Decodes the InvoiceAdvance events in a receipt (ignores logs from other contracts). */
export function decodeInvoiceAdvanceEvents(
  receipt: TransactionReceipt
): InvoiceAdvanceEvent[] {
  const own = receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() ===
      contractAddresses.invoiceAdvance.toLowerCase()
  )
  return parseEventLogs({ abi: invoiceAdvanceAbi, logs: own })
}

export interface InvoiceCreatedFilter {
  client?: string
  freelancer?: string
  amount?: bigint
  metadataHash?: string
}

/**
 * The invoice ID from a receipt's InvoiceCreated event, or null when there is none.
 *
 * It never guesses: if more than one InvoiceCreated event matches (a batched transaction), it
 * throws RECEIPT_MISMATCH instead of picking one. Pass `filter` to select by client, freelancer,
 * amount or metadataHash. Prefer `confirmed.invoiceId` from a verified confirmation, which is
 * already matched to the exact invoice that was submitted.
 */
export function getInvoiceIdFromReceipt(
  receipt: TransactionReceipt,
  filter?: InvoiceCreatedFilter
): bigint | null {
  const created = decodeInvoiceAdvanceEvents(receipt).filter(
    (
      event
    ): event is Extract<InvoiceAdvanceEvent, { eventName: "InvoiceCreated" }> =>
      event.eventName === "InvoiceCreated" &&
      (filter?.client === undefined ||
        sameAddress(event.args.client, filter.client)) &&
      (filter?.freelancer === undefined ||
        sameAddress(event.args.freelancer, filter.freelancer)) &&
      (filter?.amount === undefined || event.args.amount === filter.amount) &&
      (filter?.metadataHash === undefined ||
        sameAddress(event.args.metadataHash, filter.metadataHash))
  )
  if (created.length === 0) return null
  if (created.length > 1) {
    throw new ChainWriteError(
      "RECEIPT_MISMATCH",
      `the receipt contains ${created.length} matching InvoiceCreated events; refusing to guess which invoice ID is meant`,
      { txHash: receipt.transactionHash }
    )
  }
  return created[0].args.invoiceId
}

// ---- verification ------------------------------------------------------------------------------

type ReplacementEvent = Parameters<
  NonNullable<WaitForTransactionReceiptParameters["onReplaced"]>
>[0]

function sameAddress(a: unknown, b: unknown): boolean {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.toLowerCase() === b.toLowerCase()
  )
}

/** Same sender, nonce, target, value and calldata: the same intended call (a fee bump). */
function isSameCall(a: Transaction, b: Transaction): boolean {
  return (
    sameAddress(a.from, b.from) &&
    sameAddress(a.to ?? null, b.to ?? null) &&
    a.nonce === b.nonce &&
    a.value === b.value &&
    a.input.toLowerCase() === b.input.toLowerCase()
  )
}

function argEquals(
  actual: unknown,
  wanted: string | bigint | boolean
): boolean {
  if (typeof wanted === "string") return sameAddress(actual, wanted)
  return actual === wanted
}

type Verification =
  | { ok: true; event: MatchedEvent }
  | { ok: false; why: "sender" | "target" | "missing" | "ambiguous" }

/** Checks the receipt carries the expected event, from the expected contract, sent by `from`. */
function verifyReceipt(
  receipt: TransactionReceipt,
  expected: ExpectedReceipt,
  from: string
): Verification {
  const address = contractAddresses[expected.contract]
  if (!sameAddress(receipt.from, from)) return { ok: false, why: "sender" }
  if (!sameAddress(receipt.to ?? null, address)) {
    return { ok: false, why: "target" }
  }
  const logs = receipt.logs.filter((log) => sameAddress(log.address, address))
  const abi =
    expected.contract === "invoiceAdvance" ? invoiceAdvanceAbi : mockUsdcAbi
  const decoded = parseEventLogs({
    abi: abi as Abi,
    logs,
    eventName: expected.eventName,
  } as never) as unknown as { args: Record<string, unknown> }[]
  const matches = decoded.filter((log) =>
    Object.entries(expected.args).every(([name, wanted]) =>
      argEquals(log.args[name], wanted)
    )
  )
  if (matches.length === 0) return { ok: false, why: "missing" }
  // A new invoice's ID is not known in advance, so two identical InvoiceCreated events would
  // leave the resulting ID ambiguous.
  if (expected.eventName === "InvoiceCreated" && matches.length > 1) {
    return { ok: false, why: "ambiguous" }
  }
  return {
    ok: true,
    event: { eventName: expected.eventName, args: matches[0].args },
  }
}

// ---- status construction -----------------------------------------------------------------------

function link(hash: string, fallback: string): string {
  return tryExplorerTxUrl(hash) ?? explorerTxUrl(fallback)
}

function base(
  hash: string,
  requestedHash: string,
  functionName?: string
): StatusBase {
  return {
    hash: hash as Hex,
    requestedHash: requestedHash as Hex,
    explorerUrl: link(hash, requestedHash),
    functionName,
  }
}

function normalizeTarget(target: string | SubmittedTransaction): {
  hash: Hex
  submitted?: SubmittedTransaction
} {
  const submitted = typeof target === "string" ? undefined : target
  const hash = typeof target === "string" ? target : target.hash
  if (
    typeof hash !== "string" ||
    !isHex(hash, { strict: true }) ||
    size(hash) !== 32
  ) {
    throw new ChainWriteError(
      "INVALID_INPUT",
      "transaction hash must be a 32-byte hex string"
    )
  }
  return { hash: hash as Hex, submitted }
}

function pendingStatus(
  hash: Hex,
  submitted?: SubmittedTransaction
): PendingStatus {
  return {
    ...base(hash, hash, submitted?.functionName),
    state: "pending",
    submittedAt: submitted?.submittedAt,
  }
}

function unverifiedStatus(
  requestedHash: Hex,
  minedHash: string,
  message: string,
  submitted: SubmittedTransaction | undefined,
  receipt: TransactionReceipt | undefined,
  details: { txHash?: string; replacementHash?: string }
): UnverifiedStatus {
  return {
    ...base(minedHash, requestedHash, submitted?.functionName),
    state: "unverified",
    receipt,
    error: new ChainWriteError("RECEIPT_MISMATCH", message, details),
  }
}

/** Turns a fetched receipt into a terminal status. Shared by the waiting and one-shot paths. */
function finishReceipt(args: {
  receipt: TransactionReceipt
  requestedHash: Hex
  submitted?: SubmittedTransaction
  feeBumpedFrom?: Hex
}): TransactionStatus {
  const { receipt, requestedHash, submitted, feeBumpedFrom } = args
  const minedHash = receipt.transactionHash
  const functionName = submitted?.functionName

  // The transaction reached a terminal state: stop blocking identical resubmissions.
  releaseByHash(requestedHash)
  releaseByHash(minedHash)

  if (receipt.status !== "success") {
    return {
      ...base(minedHash, requestedHash, functionName),
      state: "reverted",
      receipt,
      blockNumber: receipt.blockNumber,
      error: new ChainWriteError(
        "TX_REVERTED",
        `transaction ${minedHash} was mined but reverted; no state changed`,
        { txHash: minedHash }
      ),
    }
  }

  let event: MatchedEvent | null = null
  if (submitted) {
    const verification = verifyReceipt(
      receipt,
      submitted.expected,
      submitted.from
    )
    if (!verification.ok) {
      const detail = {
        sender: `was not sent by ${submitted.from}`,
        target: "was not addressed to the expected contract",
        missing: `does not contain the expected ${submitted.expected.eventName} event for ${submitted.functionName} from ${submitted.from}`,
        ambiguous: `contains more than one matching ${submitted.expected.eventName} event, so the resulting invoice ID is ambiguous`,
      }[verification.why]
      return unverifiedStatus(
        requestedHash,
        minedHash,
        `transaction ${minedHash} succeeded but ${detail}; not treating it as proof that the operation ran`,
        submitted,
        receipt,
        { txHash: minedHash }
      )
    }
    event = verification.event
  }

  const eventInvoiceId = event?.args.invoiceId
  return {
    ...base(minedHash, requestedHash, functionName),
    state: "confirmed",
    feeBumpedFrom,
    receipt,
    blockNumber: receipt.blockNumber,
    events: decodeInvoiceAdvanceEvents(receipt),
    verified: submitted !== undefined,
    event,
    invoiceId:
      typeof eventInvoiceId === "bigint" ? eventInvoiceId.toString(10) : null,
  }
}

// ---- settling ----------------------------------------------------------------------------------

async function settle(
  target: string | SubmittedTransaction,
  opts?: WaitOptions
): Promise<TransactionStatus> {
  const { hash, submitted } = normalizeTarget(target)
  const client = opts?.publicClient ?? getPublicClient()
  const functionName = submitted?.functionName

  const seen: { replacement?: ReplacementEvent } = {}
  let receipt: TransactionReceipt
  try {
    receipt = await client.waitForTransactionReceipt({
      hash,
      confirmations: opts?.confirmations ?? 1,
      timeout: opts?.timeoutMs ?? 120_000,
      onReplaced: (replacement) => {
        seen.replacement = replacement
      },
    })
  } catch (error) {
    if (
      error instanceof BaseError &&
      error.walk((e) => e instanceof WaitForTransactionReceiptTimeoutError)
    ) {
      return {
        ...base(hash, hash, functionName),
        state: "unknown",
        reason: "timeout",
        error: new ChainWriteError(
          "WAIT_TIMEOUT",
          `transaction ${hash} was not confirmed in time; it may still be mined. Do not resubmit; check its status first.`,
          { txHash: hash }
        ),
      }
    }
    const mapped = mapWriteError(error, `waiting for ${hash}`, "simulate")
    return {
      ...base(hash, hash, functionName),
      state: "unknown",
      reason: "rpc_error",
      error: new ChainWriteError(mapped.code, mapped.message, { txHash: hash }),
    }
  }

  const replacement = seen.replacement
  let feeBumpedFrom: Hex | undefined
  if (replacement) {
    // The original no longer exists whatever happens next.
    releaseByHash(hash)
    const replacementHash = replacement.transaction.hash
    const genuineFeeBump =
      replacement.reason === "repriced" &&
      isSameCall(replacement.replacedTransaction, replacement.transaction) &&
      replacement.replacedTransaction.hash.toLowerCase() === hash.toLowerCase()
    if (!genuineFeeBump) {
      const reason =
        replacement.reason === "cancelled" ? "cancelled" : "replaced"
      return {
        ...base(hash, hash, functionName),
        state: "replaced",
        reason,
        replacementHash,
        replacementExplorerUrl: link(replacementHash, hash),
        error: new ChainWriteError(
          "TX_REPLACED",
          `transaction ${hash} was ${reason === "cancelled" ? "cancelled" : "replaced by a different transaction"} (${replacementHash}); the intended operation did NOT run. Its receipt status says nothing about the intended call.`,
          { txHash: hash, replacementHash }
        ),
      }
    }
    if (
      receipt.transactionHash.toLowerCase() !== replacementHash.toLowerCase()
    ) {
      return unverifiedStatus(
        hash,
        receipt.transactionHash,
        `transaction ${hash} was fee-bumped to ${replacementHash} but the receipt belongs to ${receipt.transactionHash}`,
        submitted,
        receipt,
        { txHash: hash, replacementHash }
      )
    }
    feeBumpedFrom = hash
  } else if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    return unverifiedStatus(
      hash,
      receipt.transactionHash,
      `asked for the receipt of ${hash} but received the receipt of ${receipt.transactionHash}; not treating it as proof`,
      submitted,
      receipt,
      { txHash: hash, replacementHash: receipt.transactionHash }
    )
  }

  return finishReceipt({
    receipt,
    requestedHash: hash,
    submitted,
    feeBumpedFrom,
  })
}

// ---- public API --------------------------------------------------------------------------------

/**
 * Waits for the transaction and resolves ONLY when the intended operation provably succeeded
 * on-chain; every other outcome throws a ChainWriteError (TX_REVERTED, TX_REPLACED,
 * RECEIPT_MISMATCH, WAIT_TIMEOUT or RPC_ERROR). Pass the SubmittedTransaction, not just the hash.
 * See `trackTransaction` for a version that returns every outcome as a status instead.
 */
export async function waitForConfirmation(
  target: string | SubmittedTransaction,
  opts?: WaitOptions
): Promise<ConfirmedTransaction> {
  const status = await settle(target, opts)
  if (status.state === "confirmed") return status
  if (status.state === "pending") {
    // settle() never returns pending; keep the type honest.
    throw new ChainWriteError("RPC_ERROR", "transaction is still pending")
  }
  throw status.error
}

/**
 * Tracks a transaction to a final answer without throwing on lifecycle outcomes. Calls
 * `onStatus` with `pending` right away and again with the final status, and returns the final
 * status: confirmed, reverted, replaced, unverified, or unknown (timeout / RPC failure). Only
 * programmer errors (an invalid hash) throw. An `unknown` result is not a failure of the
 * transaction: call this again later rather than resubmitting.
 */
export async function trackTransaction(
  target: string | SubmittedTransaction,
  opts?: TrackOptions
): Promise<TransactionStatus> {
  const { hash, submitted } = normalizeTarget(target)
  const emit = (status: TransactionStatus) => {
    try {
      opts?.onStatus?.(status)
    } catch {
      // A UI callback must never mask the transaction's outcome.
    }
  }
  emit(pendingStatus(hash, submitted))
  const status = await settle(target, opts)
  emit(status)
  return status
}

/**
 * One non-blocking look at the chain, for polling UIs. Returns confirmed / reverted /
 * unverified when a receipt exists, pending when the transaction is known but not mined, and
 * unknown (not_found or rpc_error) otherwise. Unlike `trackTransaction` it cannot recognise a
 * cancellation or replacement; use `trackTransaction` for that.
 */
export async function getTransactionStatus(
  target: string | SubmittedTransaction,
  opts?: { publicClient?: ChainWriteClient }
): Promise<TransactionStatus> {
  const { hash, submitted } = normalizeTarget(target)
  const client = opts?.publicClient ?? getPublicClient()
  const functionName = submitted?.functionName

  let receipt: TransactionReceipt
  try {
    receipt = await client.getTransactionReceipt({ hash })
  } catch (error) {
    if (
      error instanceof BaseError &&
      error.walk((e) => e instanceof TransactionReceiptNotFoundError)
    ) {
      try {
        await client.getTransaction({ hash })
        return pendingStatus(hash, submitted)
      } catch (txError) {
        if (
          txError instanceof BaseError &&
          txError.walk((e) => e instanceof TransactionNotFoundError)
        ) {
          return {
            ...base(hash, hash, functionName),
            state: "unknown",
            reason: "not_found",
            error: new ChainWriteError(
              "RPC_ERROR",
              `transaction ${hash} was not found (not mined and not pending). It may have been dropped or replaced, or the RPC has not indexed it yet. Do not resubmit; keep tracking it.`,
              { txHash: hash }
            ),
          }
        }
        error = txError
      }
    }
    const mapped = mapWriteError(error, `looking up ${hash}`, "simulate")
    return {
      ...base(hash, hash, functionName),
      state: "unknown",
      reason: "rpc_error",
      error: new ChainWriteError(mapped.code, mapped.message, { txHash: hash }),
    }
  }

  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    return unverifiedStatus(
      hash,
      receipt.transactionHash,
      `asked for the receipt of ${hash} but received the receipt of ${receipt.transactionHash}; not treating it as proof`,
      submitted,
      receipt,
      { txHash: hash, replacementHash: receipt.transactionHash }
    )
  }
  return finishReceipt({ receipt, requestedHash: hash, submitted })
}

// ---- persistence ---------------------------------------------------------------------------------

/**
 * A SubmittedTransaction holds bigints and cannot go straight into JSON. These helpers make it
 * storable (localStorage, a cookie, your backend) so tracking can resume after a page reload:
 * `trackTransaction(parseSubmittedTransaction(stored))`. Stored data is untrusted: parsing
 * validates every field and rejects anything inconsistent with the operation's evidence table.
 */
export function serializeSubmittedTransaction(
  submitted: SubmittedTransaction
): string {
  return JSON.stringify({
    version: 1,
    hash: submitted.hash,
    functionName: submitted.functionName,
    from: submitted.from,
    chainId: submitted.chainId,
    submittedAt: submitted.submittedAt,
    expected: {
      contract: submitted.expected.contract,
      eventName: submitted.expected.eventName,
      args: Object.fromEntries(
        Object.entries(submitted.expected.args).map(([k, v]) => [
          k,
          typeof v === "bigint" ? { $bigint: v.toString(10) } : v,
        ])
      ),
    },
  })
}

function malformed(why: string): ChainWriteError {
  return new ChainWriteError(
    "INVALID_INPUT",
    `stored transaction is malformed: ${why}`
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseSubmittedTransaction(json: string): SubmittedTransaction {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw malformed("not valid JSON")
  }
  if (!isRecord(raw) || raw.version !== 1)
    throw malformed("unsupported version")

  const { hash, functionName, from, chainId, submittedAt, expected } = raw
  if (
    typeof hash !== "string" ||
    !isHex(hash, { strict: true }) ||
    size(hash) !== 32
  ) {
    throw malformed("hash")
  }
  if (typeof functionName !== "string" || !isWriteFunctionName(functionName)) {
    throw malformed("functionName")
  }
  if (typeof from !== "string" || !isAddress(from, { strict: true })) {
    throw malformed("from")
  }
  if (chainId !== CHAIN_ID) throw malformed("chainId")
  if (
    typeof submittedAt !== "number" ||
    !Number.isSafeInteger(submittedAt) ||
    submittedAt < 0
  ) {
    throw malformed("submittedAt")
  }

  const table = EXPECTED_EVENTS[functionName]
  if (
    !isRecord(expected) ||
    expected.contract !== table.contract ||
    expected.eventName !== table.eventName ||
    !isRecord(expected.args)
  ) {
    throw malformed("expected event does not match the operation")
  }
  const given = Object.keys(expected.args).sort().join(",")
  if (given !== [...table.args].sort().join(",")) {
    throw malformed("expected arguments do not match the operation")
  }

  const args: ExpectedReceipt["args"] = {}
  for (const name of table.args) {
    const value = expected.args[name]
    const kind = ARG_KINDS[name as keyof typeof ARG_KINDS]
    if (kind === "address") {
      if (typeof value !== "string" || !isAddress(value, { strict: true })) {
        throw malformed(`argument ${name}`)
      }
      args[name] = value
    } else if (kind === "bytes32") {
      if (
        typeof value !== "string" ||
        !isHex(value, { strict: true }) ||
        size(value) !== 32
      ) {
        throw malformed(`argument ${name}`)
      }
      args[name] = value
    } else if (kind === "uint") {
      const digits = isRecord(value) ? value.$bigint : undefined
      if (
        typeof digits !== "string" ||
        !/^\d+$/.test(digits) ||
        BigInt(digits) > MAX_UINT256
      ) {
        throw malformed(`argument ${name}`)
      }
      args[name] = BigInt(digits)
    } else if (kind === "bool") {
      if (typeof value !== "boolean") throw malformed(`argument ${name}`)
      args[name] = value
    } else {
      throw malformed(`argument ${name}`)
    }
  }

  return {
    hash: hash as Hex,
    functionName,
    from: from as SubmittedTransaction["from"],
    chainId: CHAIN_ID,
    expected: { contract: table.contract, eventName: table.eventName, args },
    submittedAt,
    explorerUrl: explorerTxUrl(hash),
  }
}
