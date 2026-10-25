import type { Address, Bytes32 } from "@/lib/frontend/domain"
import { computeEvaluationHash } from "@/lib/shared/evaluation-hash"
import type { AdvanceRequestData, BackendDeps, ChainAdvanceTxRef, ChainInvoiceRef, ChainInvoiceState, InvoiceData } from "./ports"
import { ChainUnavailableError } from "./ports"

export const DEFAULT_NEVER_BROADCAST_AFTER_MS = 120_000

const lower = (s: string) => s.toLowerCase()

/** The evaluation hash an advance request MUST carry, recomputed from the immutable stored evaluation it relied on. */
export async function expectedEvaluationHash(deps: BackendDeps, request: AdvanceRequestData, invoice: InvoiceData): Promise<Bytes32 | null> {
  const evaluation = (await deps.db.listEvaluations(invoice.id)).find((e) => e.id === request.evaluation_id)
  if (!evaluation || evaluation.state !== "completed" || evaluation.score === null) return null
  return computeEvaluationHash({
    evaluationId: evaluation.id,
    submissionId: request.submission_id,
    criteriaHash: evaluation.criteria_hash,
    score: evaluation.score,
  })
}

const refOf = (invoice: InvoiceData): ChainInvoiceRef => ({
  chainId: invoice.chain_id,
  contractAddress: invoice.contract_address,
  invoiceId: BigInt(invoice.invoice_id),
})

/**
 * Brings ONE advance request in line with the chain. This is the only code that may set an advance to `paid`, and it does
 * so only from a receipt that (a) was mined successfully, (b) came from the recorded evaluator to this deployment's
 * InvoiceAdvance, and (c) carries an `AdvancePaid` event whose invoice, evaluation hash, freelancer and amount all equal
 * what we asked for. Anything short of that leaves the request `pending` (still unknown, or needing a person); only a
 * definitive "this transaction did not run" (reverted / replaced), or proof that nothing was ever broadcast, releases it.
 *
 * It is safe to call repeatedly and concurrently with itself: every database write is conditional on `pending`, and a
 * crash between the steps of a confirmation is repaired by the next call.
 */
export async function reconcileAdvance(
  deps: BackendDeps,
  input: { request: AdvanceRequestData; invoice: InvoiceData; waitMs?: number }
): Promise<AdvanceRequestData> {
  const { request, invoice } = input
  if (request.status !== "pending") return request
  if (!deps.chain.available) return request // cannot judge; stays pending, never "paid"

  const expectedHash = await expectedEvaluationHash(deps, request, invoice)
  if (!expectedHash) {
    await deps.db.noteAdvanceReview(request.id, "The evaluation this request relied on can't be read; needs manual review.")
    return (await deps.db.getAdvanceRequest(request.id)) ?? request
  }

  let current = request
  if (!current.tx_hash) {
    const resolved = await resolveUnrecordedTransaction(deps, current, invoice, expectedHash)
    if (!resolved) return (await deps.db.getAdvanceRequest(request.id)) ?? current
    current = resolved
  }
  return confirmRecordedTransaction(deps, current, invoice, expectedHash, input.waitMs ?? 0)
}

/** A pending request with no transaction hash: the broadcast either never happened or its hash was lost in a crash. */
async function resolveUnrecordedTransaction(
  deps: BackendDeps,
  request: AdvanceRequestData,
  invoice: InvoiceData,
  expectedHash: Bytes32
): Promise<AdvanceRequestData | null> {
  const now = (deps.now ?? Date.now)()
  const grace = deps.neverBroadcastAfterMs ?? DEFAULT_NEVER_BROADCAST_AFTER_MS
  // Inside the grace window another request handler may be about to record the hash: do not interfere.
  if (now - Date.parse(request.created_at) < grace) return null

  const ref = refOf(invoice)
  let state: ChainInvoiceState
  try {
    state = await deps.chain.getInvoiceState(ref)
  } catch {
    return null // chain unreadable: unknown, keep waiting
  }
  const advanced = state.advanceAmount > BigInt(0) || state.onchainStatus === "Advanced"
  if (!advanced) {
    if (state.onchainStatus === "Funded") {
      await deps.db.recordAdvanceFailed({ requestId: request.id, transactionId: null, reason: "The advance transaction was never broadcast. Nothing was paid; you can request it again." })
    } else {
      await deps.db.recordAdvanceFailed({ requestId: request.id, transactionId: null, reason: `The invoice is ${state.onchainStatus} on-chain, so no advance can be paid.` })
    }
    return null
  }
  // The chain shows an advance, but we never recorded its hash: find our own payout among the events.
  let found
  try {
    found = await deps.chain.findAdvancePaid(ref)
  } catch {
    return null
  }
  if (!found || lower(found.evaluationHash) !== lower(expectedHash)) {
    await deps.db.noteAdvanceReview(request.id, "The chain shows an advance that does not match this request's evaluation; needs manual review.")
    return null
  }
  return deps.db.attachRecoveredTransaction({
    requestId: request.id,
    invoiceId: invoice.id,
    chainId: invoice.chain_id,
    from: found.from,
    amount: request.amount,
    txHash: found.txHash,
  })
}

async function confirmRecordedTransaction(
  deps: BackendDeps,
  request: AdvanceRequestData,
  invoice: InvoiceData,
  expectedHash: Bytes32,
  waitMs: number
): Promise<AdvanceRequestData> {
  const from = request.tx_from ?? deps.signer.address
  const reload = async () => (await deps.db.getAdvanceRequest(request.id)) ?? request
  if (!from || !request.tx_hash || !request.transaction_id) {
    await deps.db.noteAdvanceReview(request.id, "The transaction's sender isn't recorded; needs manual review.")
    return reload()
  }
  const ref: ChainAdvanceTxRef = {
    txHash: request.tx_hash,
    from,
    invoiceId: BigInt(invoice.invoice_id),
    evaluationHash: expectedHash,
    submittedAt: Date.parse(request.created_at),
  }
  let status
  try {
    status = await deps.chain.getAdvanceTransaction(ref, { waitMs })
  } catch (e) {
    if (e instanceof ChainUnavailableError) return request
    return request // RPC trouble: still unknown, still pending
  }

  switch (status.state) {
    case "pending":
    case "unknown":
      return request
    case "reverted":
      await deps.db.recordAdvanceFailed({ requestId: request.id, transactionId: request.transaction_id, reason: "The advance transaction reverted on-chain. Nothing was paid; you can request it again." })
      return reload()
    case "replaced":
      await deps.db.recordAdvanceFailed({ requestId: request.id, transactionId: request.transaction_id, reason: "The advance transaction was replaced or cancelled. Nothing was paid; you can request it again." })
      return reload()
    case "unverified":
      await deps.db.noteAdvanceReview(request.id, `The receipt couldn't be verified (${status.reason}); needs manual review.`)
      return reload()
    case "confirmed": {
      const p = status.paid
      const matches =
        p.invoiceId === BigInt(invoice.invoice_id) &&
        lower(p.evaluationHash) === lower(expectedHash) &&
        p.amount === BigInt(request.amount) &&
        lower(p.freelancer) === lower(invoice.freelancer_address)
      if (!matches) {
        await deps.db.noteAdvanceReview(request.id, "The confirmed payout does not match the request (invoice, evaluation, recipient or amount); needs manual review.")
        return reload()
      }
      // Refresh the invoice's cached chain state when readable; a failed read only leaves the cache stale (it is labelled unverified).
      let cache: { status: ChainInvoiceState["onchainStatus"]; blockNumber: bigint } | undefined
      try {
        const s = await deps.chain.getInvoiceState(refOf(invoice))
        cache = { status: s.onchainStatus, blockNumber: s.blockNumber }
      } catch {
        cache = undefined
      }
      return deps.db.recordAdvanceConfirmed({
        requestId: request.id,
        transactionId: request.transaction_id,
        invoiceId: invoice.id,
        blockNumber: status.blockNumber,
        blockHash: status.blockHash,
        logIndex: status.logIndex,
        receipt: {
          event: "AdvancePaid",
          invoiceId: p.invoiceId.toString(10),
          freelancer: p.freelancer,
          amount: p.amount.toString(10),
          evaluationHash: p.evaluationHash,
        },
        advanceAmount: p.amount.toString(10),
        cache,
      })
    }
  }
}

export type { Address }
