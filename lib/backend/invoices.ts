import type { Address, Bytes32, OnchainInvoiceStatus, SubmissionStatus } from "@/lib/frontend/domain"
import { ApiError } from "./api-error"
import { loadInvoiceAsParty, requireUser, requireVerifiedWallets } from "./access"
import { UUID_RE } from "@/lib/evidence/policy"
import { reconcileAdvance } from "./reconcile"
import { invoiceInScope } from "@/lib/shared/deployment-scope"
import { canonicalCriteriaString, computeCriteriaHash, normalizeCriteria, type CanonicalCriterion } from "./criteria"
import {
  ChainInvoiceNotFoundError,
  ChainScopeError,
  ChainUnavailableError,
  type BackendDeps,
  type ChainInvoiceState,
  type EvaluationData,
  type InvoiceData,
} from "./ports"

/** Runs a chain call, turning "no adapter" into the documented 503 and any other failure into a generic 502. */
export async function callChain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ChainUnavailableError) {
      throw new ApiError("INTEGRATION_UNAVAILABLE", "Blockchain integration isn't available yet, so this can't be verified or completed.")
    }
    if (e instanceof ChainScopeError) {
      throw new ApiError("WRONG_DEPLOYMENT", "That belongs to a different deployment than the one this server runs.")
    }
    if (e instanceof ChainInvoiceNotFoundError) {
      throw new ApiError("INTEGRITY_MISMATCH", "The invoice isn't on-chain, although we have a record of it. This needs manual review.")
    }
    throw new ApiError("CHAIN_ERROR", "The blockchain couldn't be read. Try again shortly.")
  }
}

// ---- POST /api/invoices -------------------------------------------------------------------------------------------

export interface CreateInvoiceInput {
  userId: string | null
  invoiceId: string
  txHash: string
  title?: string
  description: string
  dueDate?: string
  criteria: CanonicalCriterion[]
}

export interface InvoiceRecordView {
  /** Database id; used by the other endpoints. */
  id: string
  /** 0 = a dev TEST FIXTURE that does not exist on any blockchain. Real invoices carry the real chain id. */
  chainId: number
  isTestFixture: boolean
  createdAt: string
  /** On-chain id (uint256, decimal string). */
  invoiceId: string
  client: Address
  freelancer: Address
  amount: string
  advanceAmount: string
  criteriaHash: Bytes32
  onchainStatus: OnchainInvoiceStatus
  submissionStatus: SubmissionStatus
  description: string
  title: string
  /** True only when `onchainStatus` and `advanceAmount` were read from the chain in this response. */
  financialStatusVerified: boolean
}

const titleFrom = (description: string) => description.trim().split("\n")[0].slice(0, 200) || "Invoice"

/**
 * Off-chain registration of an invoice the client already created on-chain. Nothing is persisted until the chain
 * adapter has confirmed the creation transaction and its creator, amount, freelancer and criteria hash. Without an
 * adapter this answers 503 INTEGRATION_UNAVAILABLE: it never invents an on-chain invoice.
 */
export async function registerInvoice(deps: BackendDeps, input: CreateInvoiceInput): Promise<{ invoice: InvoiceRecordView; created: boolean }> {
  const userId = requireUser(input.userId)
  const wallets = await requireVerifiedWallets(deps.db, userId)

  const criteria = normalizeCriteria(input.criteria)
  const criteriaHash = computeCriteriaHash(criteria)

  // Fail before any lookup when there is no chain integration: a clear, honest answer.
  if (!deps.chain.available) {
    throw new ApiError("INTEGRATION_UNAVAILABLE", "Blockchain integration isn't available yet, so an invoice can't be verified or registered.")
  }

  const creation = await callChain(() => deps.chain.getInvoiceCreation(input.txHash as Bytes32))
  if (creation.status === "pending") throw new ApiError("CHAIN_TX_PENDING", "The transaction isn't confirmed yet. Try again shortly.")
  if (creation.status !== "confirmed") throw new ApiError("CHAIN_TX_INVALID", "No successful invoice-creation transaction was found for that hash.")
  if (creation.invoiceId !== BigInt(input.invoiceId)) {
    throw new ApiError("CHAIN_TX_INVALID", "That transaction did not create this invoice id.")
  }
  if (!wallets.includes(creation.creator)) {
    throw new ApiError("NOT_INVOICE_CREATOR", "Only the wallet that created the invoice on-chain, verified on your account, can register it.")
  }
  if (creation.criteriaHash.toLowerCase() !== criteriaHash) {
    throw new ApiError("CRITERIA_HASH_MISMATCH", "The acceptance criteria don't match the hash committed on-chain.")
  }
  if (creation.amount <= BigInt(0)) throw new ApiError("CHAIN_TX_INVALID", "The on-chain invoice amount is invalid.")
  // The transaction must have created the invoice on THIS server's deployment, not another contract or token.
  if (
    !invoiceInScope(
      { chain_id: creation.chainId, contract_address: creation.contractAddress, token_address: creation.tokenAddress },
      deps.scope
    )
  ) {
    throw new ApiError("WRONG_DEPLOYMENT", `That invoice was created on a different deployment than this server's (${deps.scope.key.toUpperCase()}).`)
  }

  const state = await callChain(() =>
    deps.chain.getInvoiceState({ chainId: creation.chainId, contractAddress: creation.contractAddress, invoiceId: creation.invoiceId })
  )

  // Terms (parties, amount, token, contract, chain) come from the chain, never from the request body.
  const { id, created } = await deps.db.registerInvoice({
    chainId: creation.chainId,
    contractAddress: creation.contractAddress,
    tokenAddress: creation.tokenAddress,
    invoiceId: creation.invoiceId.toString(),
    client: creation.creator,
    freelancer: creation.freelancer,
    amount: creation.amount.toString(),
    criteriaHash,
    canonical: canonicalCriteriaString(criteria),
    criteria,
    title: (input.title ?? titleFrom(input.description)).slice(0, 200),
    description: input.description,
    dueDate: input.dueDate ?? null,
    createTxHash: input.txHash.toLowerCase() as Bytes32,
    userId,
    status: state.onchainStatus,
    blockNumber: Number(state.blockNumber),
  })
  const invoice = await deps.db.getInvoice(id)
  if (!invoice) throw new Error("registered invoice could not be read back")
  return { invoice: toRecordView(invoice, "NotSubmitted", state), created }
}

export function toRecordView(invoice: InvoiceData, submissionStatus: SubmissionStatus, chain: ChainInvoiceState | null): InvoiceRecordView {
  return {
    id: invoice.id,
    chainId: invoice.chain_id,
    isTestFixture: invoice.chain_id === 0,
    createdAt: invoice.created_at,
    invoiceId: invoice.invoice_id,
    client: invoice.client_address,
    freelancer: invoice.freelancer_address,
    amount: invoice.amount,
    // Never a cached figure presented as fact: without chain data the advance is reported as unknown-zero only if the cache says so, flagged unverified.
    advanceAmount: chain ? chain.advanceAmount.toString() : invoice.advance_amount,
    criteriaHash: invoice.criteria_hash,
    onchainStatus: chain ? chain.onchainStatus : invoice.onchain_status,
    submissionStatus,
    description: invoice.description,
    title: invoice.title,
    financialStatusVerified: chain !== null,
  }
}

// ---- GET /api/invoices/:id -----------------------------------------------------------------------------------------

export interface EvaluationView {
  evaluationId: string
  submissionId: string
  state: EvaluationData["state"]
  score: number | null
  passed: boolean | null
  criteriaResults: EvaluationData["criteria_results"]
  summary: string | null
  criteriaHash: Bytes32
  criteriaVersion: number
  model: string
  promptVersion: string
  passRule: string
  /** True for deterministic development evaluations; these can never authorize a payment. */
  simulated: boolean
  evaluatedAt: string | null
}

export const toEvaluationView = (e: EvaluationData): EvaluationView => ({
  evaluationId: e.id,
  submissionId: e.submission_id,
  state: e.state,
  score: e.score,
  passed: e.passed,
  criteriaResults: e.criteria_results,
  summary: e.summary,
  criteriaHash: e.criteria_hash,
  criteriaVersion: e.criteria_version,
  model: e.model,
  promptVersion: e.prompt_version,
  passRule: e.pass_rule,
  simulated: e.simulated,
  evaluatedAt: e.evaluated_at,
})

export interface InvoiceDetailView {
  invoice: InvoiceRecordView
  /** Verified chain snapshot, or the reason there is none. The database cache is reported separately and labelled. */
  chain:
    | { verified: true; onchainStatus: OnchainInvoiceStatus; advanceAmount: string; blockNumber: string }
    | { verified: false; reason: "INTEGRATION_UNAVAILABLE" | "CHAIN_ERROR"; cachedOnchainStatus: OnchainInvoiceStatus; cachedStatusIsProof: false }
  criteria: Array<{ position: number; id: string; text: string; mandatory: boolean }>
  criteriaVersion: number
  dueDate: string | null
  submissions: Array<{
    submissionId: string
    note: string
    fileName: string
    fileSize: number
    mimeType: string
    createdAt: string
    fundingVerifiedOnchain: boolean
  }>
  evaluations: EvaluationView[]
  advanceRequests: Array<{ requestId: string; status: string; amount: string; reason: string | null; txHash: string | null; txFrom: string | null; createdAt: string }>
}

/**
 * `ref` is a database UUID or an on-chain decimal id. A numeric ref is resolved ONLY among invoices the caller is a
 * party to (verified wallets), so it cannot be used to probe other people's invoices.
 */
async function resolveInvoiceRef(deps: BackendDeps, userId: string, ref: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref
  const wallets = await requireVerifiedWallets(deps.db, userId)
  if (!/^(0|[1-9][0-9]{0,77})$/.test(ref)) throw new ApiError("NOT_FOUND", "Invoice not found.")
  // On-chain ids repeat across deployments: only the active deployment's invoices can match, so a dUSD #1 never shadows an RLUSD #1.
  const matches = (await deps.db.findInvoicesByOnchainId(ref, wallets)).filter((i) => invoiceInScope(i, deps.scope))
  if (matches.length === 0) throw new ApiError("NOT_FOUND", "Invoice not found.")
  if (matches.length > 1) throw new ApiError("AMBIGUOUS_INVOICE", "More than one of your invoices has that on-chain id. Use the invoice's UUID.")
  return matches[0].id
}

export async function getInvoiceDetail(deps: BackendDeps, input: { userId: string | null; invoiceId: string }): Promise<InvoiceDetailView> {
  const userId = requireUser(input.userId)
  const { invoice } = await loadInvoiceAsParty(deps.db, userId, await resolveInvoiceRef(deps, userId, input.invoiceId), deps.scope)

  // A refresh is the natural moment to settle any pending advance against the chain (idempotent, best-effort: a chain
  // or database hiccup just leaves it pending, it is never turned into "paid" or "failed" without proof).
  if (deps.chain.available && invoice.chain_id !== 0) {
    for (const pending of await deps.db.listPendingAdvances(invoice.id)) {
      await reconcileAdvance(deps, { request: pending, invoice, waitMs: 0 }).catch(() => undefined)
    }
  }

  const [criteria, submissions, evaluations, advances] = await Promise.all([
    deps.db.getCriteria(invoice.id),
    deps.db.listSubmissions(invoice.id),
    deps.db.listEvaluations(invoice.id),
    deps.db.listAdvanceRequests(invoice.id),
  ])

  let chain: ChainInvoiceState | null = null
  let reason: "INTEGRATION_UNAVAILABLE" | "CHAIN_ERROR" = "INTEGRATION_UNAVAILABLE"
  if (deps.chain.available) {
    try {
      chain = await deps.chain.getInvoiceState({
        chainId: invoice.chain_id,
        contractAddress: invoice.contract_address,
        invoiceId: BigInt(invoice.invoice_id),
      })
    } catch (e) {
      reason = e instanceof ChainUnavailableError ? "INTEGRATION_UNAVAILABLE" : "CHAIN_ERROR"
    }
  }

  const latest = submissions[0]
  const latestEval = latest ? evaluations.find((e) => e.submission_id === latest.id && e.state === "completed") : undefined
  const submissionStatus: SubmissionStatus = !latest ? "NotSubmitted" : latestEval ? "Evaluated" : "Submitted"

  return {
    invoice: toRecordView(invoice, submissionStatus, chain),
    chain: chain
      ? { verified: true, onchainStatus: chain.onchainStatus, advanceAmount: chain.advanceAmount.toString(), blockNumber: chain.blockNumber.toString() }
      : { verified: false, reason, cachedOnchainStatus: invoice.onchain_status, cachedStatusIsProof: false },
    criteria: criteria.map((c) => ({ position: c.position, id: c.criterion_key, text: c.text, mandatory: c.mandatory })),
    criteriaVersion: invoice.criteria_version,
    dueDate: invoice.due_date,
    // Storage paths are deliberately omitted: files are fetched through the authorized download endpoint.
    submissions: submissions.map((s) => ({
      submissionId: s.id,
      note: s.note,
      fileName: s.file_name,
      fileSize: s.file_size,
      mimeType: s.mime_type,
      createdAt: s.created_at,
      fundingVerifiedOnchain: s.funding_verified_onchain,
    })),
    evaluations: evaluations.map(toEvaluationView),
    advanceRequests: advances.map((a) => ({ requestId: a.id, status: a.status, amount: a.amount, reason: a.reason, txHash: a.tx_hash, txFrom: a.tx_from ?? null, createdAt: a.created_at })),
  }
}


// ---- GET /api/invoices (list) --------------------------------------------------------------------------------------

export interface InvoiceListView {
  invoices: InvoiceRecordView[]
}

/**
 * Invoices the caller is a party to, newest first, with a submission status derived from stored evidence. Each item
 * is chain-verified when an adapter exists (capped to keep one request cheap); otherwise it is labelled unverified.
 */
export async function listInvoices(deps: BackendDeps, input: { userId: string | null }): Promise<InvoiceListView> {
  const userId = requireUser(input.userId)
  const wallets = await requireVerifiedWallets(deps.db, userId)
  const invoices = (await deps.db.listInvoicesForWallets(wallets)).filter((i) => invoiceInScope(i, deps.scope))
  const ids = invoices.map((i) => i.id)
  const [submissions, evaluations] = ids.length ? await Promise.all([deps.db.listSubmissionsForInvoices(ids), deps.db.listEvaluationsForInvoices(ids)]) : [[], []]

  const views = await Promise.all(
    invoices.map(async (invoice, index) => {
      const latest = submissions.find((s) => s.invoice_uuid === invoice.id)
      const done = latest ? evaluations.some((e) => e.submission_id === latest.id && e.state === "completed") : false
      const status: SubmissionStatus = !latest ? "NotSubmitted" : done ? "Evaluated" : "Submitted"
      let chain: ChainInvoiceState | null = null
      if (deps.chain.available && index < 50) {
        chain = await deps.chain
          .getInvoiceState({ chainId: invoice.chain_id, contractAddress: invoice.contract_address, invoiceId: BigInt(invoice.invoice_id) })
          .catch(() => null)
      }
      return toRecordView(invoice, status, chain)
    })
  )
  return { invoices: views }
}
