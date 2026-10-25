import type { Address, Bytes32 } from "@/lib/frontend/domain"
import { ApiError } from "./api-error"
import { loadInvoiceAsParty, requireFreelancer, requireUser } from "./access"
import { callChain } from "./invoices"
import { DuplicateAdvanceError, type AdvanceRequestData, type BackendDeps, type ChainInvoiceState } from "./ports"

export const ADVANCE_NUMERATOR = BigInt(90)
export const ADVANCE_DENOMINATOR = BigInt(100)

/** floor(amount * 90 / 100) in token base units. bigint only. */
export const advanceAmountFor = (amount: bigint): bigint => (amount * ADVANCE_NUMERATOR) / ADVANCE_DENOMINATOR

export interface AdvanceResult {
  requestId: string
  /** pending = submitted and awaiting on-chain confirmation. `paid` is only ever set after a confirmed receipt (not built yet). */
  status: AdvanceRequestData["status"]
  amount: string
  txHash: Bytes32 | null
  /** True when an existing request was returned instead of creating a new one. */
  duplicate: boolean
}

const view = (r: AdvanceRequestData, duplicate: boolean): AdvanceResult => ({
  requestId: r.id,
  status: r.status,
  amount: r.amount,
  txHash: r.tx_hash,
  duplicate,
})

function checkOnchainEligibility(state: ChainInvoiceState) {
  switch (state.onchainStatus) {
    case "Funded":
      break
    case "Created":
      throw new ApiError("NOT_FUNDED", "Escrow isn't funded on-chain yet.")
    case "Advanced":
      throw new ApiError("ALREADY_ADVANCED", "An advance was already paid for this invoice.")
    case "Disputed":
      throw new ApiError("INVOICE_DISPUTED", "The invoice is disputed, so advances are frozen.")
    case "Settled":
      throw new ApiError("INVOICE_SETTLED", "The invoice is already settled.")
  }
  if (state.advanceAmount > BigInt(0)) throw new ApiError("ALREADY_ADVANCED", "An advance was already paid for this invoice.")
}

/**
 * Explicit freelancer request for the 90% advance. Checks, in order: session, verified wallet, freelancer role,
 * duplicates, the LATEST submission's passing REAL evaluation, live on-chain state, platform reserve, and signer
 * availability. Only then is a pending request recorded and the signer asked to broadcast approveAdvance.
 *
 * It never reports success it cannot back: with no chain adapter or signer it answers 503 INTEGRATION_UNAVAILABLE
 * and records nothing; with a signer it returns `pending` plus the tx hash. Confirmation (`paid`) is reconciled
 * from a chain receipt by a separate process.
 */
export async function requestAdvance(
  deps: BackendDeps,
  input: { userId: string | null; invoiceId: string; idempotencyKey?: string }
): Promise<AdvanceResult> {
  const userId = requireUser(input.userId)
  const access = await loadInvoiceAsParty(deps.db, userId, input.invoiceId)
  requireFreelancer(access, "request an advance")
  const { invoice } = access

  // Idempotency: the same key returns the same request; a live request on the invoice blocks any new one.
  if (input.idempotencyKey) {
    const byKey = await deps.db.findAdvanceByKey(userId, input.idempotencyKey)
    if (byKey) {
      if (byKey.invoice_uuid !== invoice.id) throw new ApiError("INVALID_INPUT", "That idempotency key was used for a different invoice.")
      return view(byKey, true)
    }
  }
  const live = await deps.db.findLiveAdvance(invoice.id)
  if (live) return view(live, true)

  // Latest submission and ITS evaluation: an older passing result can never authorize newer evidence.
  const submissions = await deps.db.listSubmissions(invoice.id)
  const latest = submissions[0]
  if (!latest) throw new ApiError("NO_SUBMISSION", "Submit evidence of the completed work first.")
  const evaluations = await deps.db.listEvaluations(invoice.id)
  const forLatest = evaluations.find((e) => e.submission_id === latest.id && e.state === "completed")
  if (!forLatest) {
    const olderPass = evaluations.some((e) => e.state === "completed" && e.passed && e.submission_id !== latest.id)
    throw new ApiError(
      olderPass ? "STALE_EVALUATION" : "NOT_EVALUATED",
      olderPass
        ? "Your latest submission hasn't been evaluated. A passing result on an older submission can't authorize an advance."
        : "Your latest submission hasn't been evaluated yet."
    )
  }
  if (forLatest.simulated) {
    throw new ApiError("EVALUATION_NOT_REAL", "A simulated evaluation can't authorize a payment.")
  }
  if (forLatest.criteria_hash !== invoice.criteria_hash) {
    throw new ApiError("STALE_EVALUATION", "The evaluation was made against different criteria than the invoice's.")
  }
  if (!forLatest.passed) throw new ApiError("EVALUATION_FAILED", "The latest evaluation didn't pass. Submit improved evidence to be re-evaluated.")

  // Live chain truth. The database cache is never used here.
  if (!deps.chain.available || !deps.signer.available) {
    throw new ApiError("INTEGRATION_UNAVAILABLE", "Blockchain integration isn't available yet, so an advance can't be verified or paid.")
  }
  const ref = { chainId: invoice.chain_id, contractAddress: invoice.contract_address, invoiceId: BigInt(invoice.invoice_id) }
  const state = await callChain(() => deps.chain.getInvoiceState(ref))
  checkOnchainEligibility(state)
  if (state.amount !== BigInt(invoice.amount)) {
    throw new ApiError("INTEGRITY_MISMATCH", "The on-chain invoice amount doesn't match our records. This needs manual review.")
  }
  const advance = advanceAmountFor(state.amount)
  const reserve = await callChain(() => deps.chain.getReserveAvailable())
  if (reserve < advance) {
    throw new ApiError("INSUFFICIENT_RESERVE", "The platform reserve can't cover this advance right now. Try again after it is topped up.")
  }

  let request: AdvanceRequestData
  try {
    request = await deps.db.createAdvanceRequest({
      invoice_uuid: invoice.id,
      requester_user_id: userId,
      requester_address: latest.freelancer_address as Address,
      submission_id: latest.id,
      evaluation_id: forLatest.id,
      amount: advance.toString(),
      idempotency_key: input.idempotencyKey ?? `auto-${(deps.newId ?? (() => crypto.randomUUID()))()}`,
    })
  } catch (e) {
    if (e instanceof DuplicateAdvanceError) {
      const winner = (await deps.db.findLiveAdvance(invoice.id)) ?? (input.idempotencyKey ? await deps.db.findAdvanceByKey(userId, input.idempotencyKey) : null)
      if (winner) return view(winner, true)
    }
    throw e
  }

  let sent: { txHash: Bytes32; from: Address }
  try {
    sent = await deps.signer.submitApproveAdvance(ref)
  } catch (e) {
    // Nothing was broadcast. Release the one-live-advance slot so the freelancer can retry.
    await deps.db.failAdvanceRequest(request.id, e instanceof Error ? e.message.slice(0, 200) : "signer failed").catch(() => undefined)
    throw new ApiError("SIGNER_FAILED", "The advance transaction couldn't be submitted. Nothing was paid. Try again.")
  }

  // From here the transaction may be on-chain, so the request is NEVER failed or released on an error: a retry could
  // broadcast a second advance. If recording fails, the request stays pending and the error propagates for follow-up.
  const linked = await deps.db.attachPendingTransaction({
    requestId: request.id,
    invoiceId: invoice.id,
    chainId: invoice.chain_id,
    from: sent.from,
    amount: advance.toString(),
    txHash: sent.txHash,
  })
  return view(linked, false)
}
