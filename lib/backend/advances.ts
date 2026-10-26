import type { Address, Bytes32 } from "@/lib/frontend/domain"
import { UUID_RE } from "@/lib/evidence/policy"
import { ApiError } from "./api-error"
import { loadInvoiceAsParty, requireFreelancer, requireUser } from "./access"
import { callChain } from "./invoices"
import { reconcileAdvance } from "./reconcile"
import { advanceAmountFor } from "@/lib/chain/amounts"
import { isV2 } from "@/lib/chain/protocol"
import { computeEvaluationHash } from "@/lib/shared/evaluation-hash"
import { DuplicateAdvanceError, type AdvanceRequestData, type BackendDeps, type ChainInvoiceState, type InvoiceData } from "./ports"
import { PASS_RULE_TEXT } from "@/lib/frontend/eligibility"
import { decidePassed } from "./evaluation"
import { scripted } from "./scripted-evaluator"

/** floor(amount * 9000 / 10000) in token base units: THE SDK's function (identical to the contract's), not a copy. */
export { advanceAmountFor } from "@/lib/chain/amounts"

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

export function checkOnchainEligibility(state: ChainInvoiceState) {
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
    case "Cancelled":
      throw new ApiError("INVOICE_CANCELLED", "The invoice was cancelled.")
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
  const access = await loadInvoiceAsParty(deps.db, userId, input.invoiceId, deps.scope)
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
  if (live) {
    // A retry after an interruption is also the moment to settle the question: look at the chain before answering.
    return view(await reconcileAdvance(deps, { request: live, invoice, waitMs: 0 }), true)
  }

  const scriptedSubmissionId = deps.scriptedDemoAdvance ? await ensureScriptedDemoEvaluation(deps, invoice, userId) : null

  // Latest submission and ITS evaluation: an older passing result can never authorize newer evidence.
  // (Scripted demo: the submission it just recorded, or the latest one if that already passed.)
  const submissions = await deps.db.listSubmissions(invoice.id)
  const latest = scriptedSubmissionId ? submissions.find((s) => s.id === scriptedSubmissionId) : submissions[0]
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
  // The contract's own record of the parties and the committed criteria must be what we registered and evaluated against.
  if (
    (state.freelancer !== undefined && state.freelancer.toLowerCase() !== invoice.freelancer_address) ||
    (state.client !== undefined && state.client.toLowerCase() !== invoice.client_address) ||
    (state.criteriaHash !== undefined && state.criteriaHash.toLowerCase() !== invoice.criteria_hash.toLowerCase())
  ) {
    throw new ApiError("INTEGRITY_MISMATCH", "The on-chain invoice's parties or criteria commitment don't match our records. This needs manual review.")
  }
  // The chain's slider decides the advance. Our mirrored copy must agree, otherwise the DB integrity check would refuse the row.
  const shareBps = state.advanceShareBps ?? BigInt(10000)
  if (shareBps !== BigInt(invoice.advance_share_bps)) {
    throw new ApiError("INTEGRITY_MISMATCH", "The on-chain advance rate doesn't match our records. This needs manual review.")
  }
  const advance = advanceAmountFor(state.amount, shareBps)
  const reserve = await callChain(() => deps.chain.getReserveAvailable())
  if (reserve < advance) {
    throw new ApiError(
      "INSUFFICIENT_RESERVE",
      isV2()
        ? "The vault can't fund this advance right now (not enough available liquidity, or a vault limit applies). Try again after liquidity is added or other advances are repaid."
        : "The platform reserve can't cover this advance right now. Try again after it is topped up."
    )
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

  // The evaluation that authorizes this payout, committed on-chain with it. Deterministic, so it never needs storing.
  const evaluationHash = computeEvaluationHash({
    evaluationId: forLatest.id,
    submissionId: latest.id,
    criteriaHash: forLatest.criteria_hash,
    score: forLatest.score as number,
  })

  let sent: { txHash: Bytes32; from: Address }
  try {
    sent = await deps.signer.submitApproveAdvance(ref, evaluationHash)
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
    from: sent.from.toLowerCase() as Address, // stored lower-case (the database domain requires it)
    amount: advance.toString(),
    txHash: sent.txHash,
  })
  // Wait (bounded) for the receipt. `paid` appears only if the confirmed AdvancePaid event proves it; otherwise the answer is `pending`.
  const settled = await reconcileAdvance(deps, { request: { ...linked, tx_from: sent.from }, invoice, waitMs: deps.confirmWaitMs ?? 0 })
  return view(settled, false)
}

/**
 * The current state of one advance request, for either party of its invoice. The request is first settled against the chain
 * (receipt + event), so a poll after a restart or a slow confirmation reflects what actually happened on-chain.
 */
export async function getAdvanceStatus(deps: BackendDeps, input: { userId: string | null; requestId: string }): Promise<AdvanceResult & { reason: string | null }> {
  const userId = requireUser(input.userId)
  if (!UUID_RE.test(input.requestId)) throw new ApiError("NOT_FOUND", "Advance request not found.")
  const request = await deps.db.getAdvanceRequest(input.requestId)
  if (!request) throw new ApiError("NOT_FOUND", "Advance request not found.")
  const { invoice } = await loadInvoiceAsParty(deps.db, userId, request.invoice_uuid, deps.scope)
  const settled = await reconcileAdvance(deps, { request, invoice, waitMs: 0 }).catch(() => request)
  return { ...view(settled, false), reason: settled.reason }
}

/**
 * SCRIPTED DEMO ONLY (DUELY_MOCK_AI_EVALUATION=true). The advance must not wait on the evidence upload, so on ANY invoice whose
 * latest submission has no passing evaluation, this records a submission (no stored file; the note says so) and the scripted
 * 95/100 evaluation against the invoice's own criteria. The flag itself is the gate: leave it off outside the demo. Everything
 * after it is unchanged: live chain state, vault limits, and the evaluator-role signer still decide whether anything is paid.
 */
async function ensureScriptedDemoEvaluation(deps: BackendDeps, invoice: InvoiceData, userId: string): Promise<string | null> {
  const criteria = await deps.db.getCriteria(invoice.id)
  if (!deps.db.insertScriptedDemoSubmission) return null
  const [latest] = await deps.db.listSubmissions(invoice.id)
  if (latest) {
    const done = (await deps.db.listEvaluations(invoice.id)).find((e) => e.submission_id === latest.id && e.state === "completed")
    if (done?.passed && !done.simulated) return latest.id
  }
  const t0 = Date.now()
  const submission = await deps.db.insertScriptedDemoSubmission({
    invoice_uuid: invoice.id,
    freelancer_user_id: userId,
    freelancer_address: invoice.freelancer_address as Address,
    storage_path: `scripted-demo/${invoice.id}/${(deps.newId ?? (() => crypto.randomUUID()))()}.zip`,
    file_name: "calc-main (1).zip",
    file_size: 656,
    mime_type: "application/zip",
    note: "AI evaluation.",
  })
  const out = scripted({ criteria: criteria.map((c) => ({ id: c.criterion_key, text: c.text, mandatory: c.mandatory })) })
  const running = await deps.db.createRunningEvaluation({
    submission_id: submission.id,
    invoice_uuid: invoice.id,
    criteria_hash: invoice.criteria_hash as Bytes32,
    criteria_version: invoice.criteria_version,
    model: out.model,
    prompt_version: out.promptVersion,
    pass_rule: PASS_RULE_TEXT,
    simulated: false,
  })
  const results = out.criteriaResults.map((r, i) => ({ ...r, mandatory: criteria[i].mandatory }))
  await deps.db.finalizeEvaluation(running.id, {
    model: out.model,
    prompt_version: out.promptVersion,
    simulated: false,
    score: out.score,
    passed: decidePassed(out.score, results),
    criteria_results: results,
    summary: out.summary,
  })
  console.info(`[submit-evidence] advance: recorded scripted demo submission ${submission.id} + passing evaluation (${Date.now() - t0}ms)`)
  return submission.id
}
