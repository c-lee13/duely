import type { Address, Bytes32, OnchainInvoiceStatus } from "@/lib/frontend/domain"
import type { EvidenceObjectStore } from "@/lib/evidence/service"

/**
 * Everything the backend services need from the outside world, as ports. Production wiring is in
 * lib/backend/server.ts; tests inject fakes and a Postgres-backed database.
 */

// ---- Chain (the integration owner supplies the real adapter; nothing here invents an ABI or address) --------------

export class ChainUnavailableError extends Error {
  constructor(message = "The blockchain integration is not available.") {
    super(message)
    this.name = "ChainUnavailableError"
  }
}

export interface ChainInvoiceCreation {
  /** pending = mined but not final enough; reverted/not_found = not a valid creation. */
  status: "confirmed" | "pending" | "reverted" | "not_found"
  chainId: number
  contractAddress: Address
  tokenAddress: Address
  invoiceId: bigint
  /** msg.sender of createInvoice: the client. */
  creator: Address
  freelancer: Address
  amount: bigint
  criteriaHash: Bytes32
  blockNumber: bigint
}

export interface ChainInvoiceRef {
  chainId: number
  contractAddress: Address
  invoiceId: bigint
}

export interface ChainInvoiceState {
  onchainStatus: OnchainInvoiceStatus
  amount: bigint
  /** Actual amount advanced on-chain, 0 before an advance. */
  advanceAmount: bigint
  blockNumber: bigint
}

export interface ChainAdapter {
  /** False when no confirmed contract/ABI/RPC config exists. Every method then throws ChainUnavailableError. */
  readonly available: boolean
  getInvoiceCreation(txHash: Bytes32): Promise<ChainInvoiceCreation>
  getInvoiceState(ref: ChainInvoiceRef): Promise<ChainInvoiceState>
  /** Platform reserve available to advance, in token base units. */
  getReserveAvailable(): Promise<bigint>
}

export const unavailableChainAdapter: ChainAdapter = {
  available: false,
  getInvoiceCreation: async () => {
    throw new ChainUnavailableError()
  },
  getInvoiceState: async () => {
    throw new ChainUnavailableError()
  },
  getReserveAvailable: async () => {
    throw new ChainUnavailableError()
  },
}

// ---- Authorized signer (never given to the AI; never imported by client code) ---------------------------------------

export interface AdvanceSigner {
  /** False until a protected signer integration exists. */
  readonly available: boolean
  /** Submits approveAdvance(invoiceId) from the platform role. Returns the broadcast hash; confirmation is reconciled separately. */
  submitApproveAdvance(ref: ChainInvoiceRef): Promise<{ txHash: Bytes32; /** The platform signer's address (the on-chain sender). */ from: Address }>
}

export const unavailableSigner: AdvanceSigner = {
  available: false,
  submitApproveAdvance: async () => {
    throw new ChainUnavailableError("The advance signer is not available.")
  },
}

// ---- Evaluator ---------------------------------------------------------------------------------------------------

export interface EvaluationCriterionInput {
  id: string
  text: string
  mandatory: boolean
}

export interface EvaluatorInput {
  invoiceId: string
  criteriaHash: Bytes32
  criteriaVersion: number
  criteria: EvaluationCriterionInput[]
  submission: {
    id: string
    fileName: string
    mimeType: string
    fileSize: number
    /**
     * Stored GitHub metadata, present only when the submission row has repository_url and/or commit_sha. These columns are
     * authoritative: when present the evaluator reviews exactly this repository and commit and ignores the evidence file.
     * Absent for file submissions (including the legacy declaration-file convention, which is read from `evidence`).
     */
    github?: { repositoryUrl: string | null; commitSha: string | null }
  }
  /** Leading bytes of the stored evidence. Never logged. */
  evidence: Uint8Array
}

export interface EvaluatorOutput {
  model: string
  promptVersion: string
  /** True for deterministic development evaluators. Such results can never authorize a payment. */
  simulated: boolean
  score: number
  criteriaResults: Array<{
    criterion: string
    passed: boolean
    reason: string
    /** Optional audit detail stored with the result. Evaluators that classify criteria (Gemini) fill these in. */
    assessment?: "verified" | "partial" | "unsupported"
    evidenceQuote?: string | null
    weight?: number
    points?: number
    /** Source-code references (GitHub evaluations), already checked against the retrieved source. */
    evidence?: EvidenceReference[]
  }>
  summary: string
  /** What was evaluated, when it is not the uploaded file itself (GitHub evaluations). Stored with every criterion result. */
  source?: EvaluationSource
  /**
   * Reasons this result must never be a Pass whatever its score (for example: the source retrieval was incomplete).
   * Non-empty means the stored `passed` is false. An evaluator can only block a pass with this, never grant one.
   */
  passBlocked?: string[]
}

export type EvidenceReference = {
  path: string
  startLine: number
  endLine: number
  quote: string
}

export type EvaluationSource = {
  kind: "github"
  repository: string
  /** The exact 40-hex commit that was reviewed. */
  commitSha: string
}

/** Thrown by an evaluator that cannot read this kind of evidence. Reported as 422, distinct from an evaluator failure. */
export class UnsupportedEvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsupportedEvidenceError"
  }
}

export interface Evaluator {
  /** disabled = no evaluator is configured (the endpoint answers 503). demo = deterministic, simulated. live = a real model (Gemini). */
  readonly mode: "disabled" | "demo" | "live"
  evaluate(input: EvaluatorInput): Promise<EvaluatorOutput>
}

export const disabledEvaluator: Evaluator = {
  mode: "disabled",
  evaluate: async () => {
    throw new Error("No evaluator is configured.")
  },
}

// ---- Database ----------------------------------------------------------------------------------------------------

/** uint256 values are decimal strings here; convert with BigInt() when doing arithmetic. */
export interface InvoiceData {
  id: string
  chain_id: number
  contract_address: Address
  token_address: Address
  invoice_id: string
  client_address: Address
  freelancer_address: Address
  amount: string
  criteria_hash: Bytes32
  criteria_version: number
  criteria_count: number
  criteria_canonical: string
  title: string
  description: string
  due_date: string | null
  /** CACHE of chain state. Never proof of anything. */
  onchain_status: OnchainInvoiceStatus
  advance_amount: string
  chain_synced_at: string | null
  created_at: string
}

export interface CriterionData {
  position: number
  criterion_key: string
  text: string
  mandatory: boolean
}

export interface SubmissionData {
  id: string
  invoice_uuid: string
  freelancer_user_id: string
  freelancer_address: Address
  storage_path: string
  file_name: string
  file_size: number
  mime_type: string
  note: string
  funding_verified_onchain: boolean
  /** GitHub code submission (migration 9): canonical repository URL + full commit SHA, both or neither. null for file submissions. */
  repository_url: string | null
  commit_sha: string | null
  created_at: string
}

export interface EvaluationData {
  id: string
  submission_id: string
  invoice_uuid: string
  criteria_hash: Bytes32
  criteria_version: number
  model: string
  prompt_version: string
  state: "running" | "completed" | "error"
  score: number | null
  passed: boolean | null
  criteria_results: Array<{
    criterion: string
    passed: boolean
    reason: string
    mandatory: boolean
    assessment?: "verified" | "partial" | "unsupported"
    evidenceQuote?: string | null
    weight?: number
    points?: number
    evidence?: EvidenceReference[]
    source?: EvaluationSource
  }> | null
  summary: string | null
  pass_rule: string
  simulated: boolean
  error_message: string | null
  created_at: string
  evaluated_at: string | null
}

export type AdvanceStatus = "pending" | "paid" | "failed" | "denied"

export interface AdvanceRequestData {
  id: string
  invoice_uuid: string
  requester_user_id: string
  requester_address: Address
  submission_id: string
  evaluation_id: string
  status: AdvanceStatus
  amount: string
  reason: string | null
  idempotency_key: string
  transaction_id: string | null
  tx_hash: Bytes32 | null
  created_at: string
}

export class DuplicateEvaluationError extends Error {}
export class DuplicateAdvanceError extends Error {}

export interface RegisterInvoiceArgs {
  chainId: number
  contractAddress: Address
  tokenAddress: Address
  invoiceId: string
  client: Address
  freelancer: Address
  amount: string
  criteriaHash: Bytes32
  canonical: string
  criteria: Array<{ id: string; text: string; mandatory: boolean }>
  title: string
  description: string
  dueDate: string | null
  createTxHash: Bytes32
  userId: string
  status: OnchainInvoiceStatus
  blockNumber: number | null
}

export interface BackendDb {
  verifiedAddresses(userId: string): Promise<Address[]>
  getInvoice(id: string): Promise<InvoiceData | null>
  /** Invoices where one of these (verified) wallets is the client or freelancer, newest first. */
  listInvoicesForWallets(addresses: Address[]): Promise<InvoiceData[]>
  /** Same visibility rule, matched by on-chain id (may match several deployments). */
  findInvoicesByOnchainId(onchainId: string, addresses: Address[]): Promise<InvoiceData[]>
  listSubmissionsForInvoices(invoiceIds: string[]): Promise<SubmissionData[]> // newest first
  listEvaluationsForInvoices(invoiceIds: string[]): Promise<EvaluationData[]> // newest first
  getCriteria(invoiceId: string): Promise<CriterionData[]>
  listSubmissions(invoiceId: string): Promise<SubmissionData[]> // newest first
  getSubmission(id: string): Promise<SubmissionData | null>
  listEvaluations(invoiceId: string): Promise<EvaluationData[]> // newest first
  /** The live (running or completed) evaluation of a submission, if any. */
  findLiveEvaluation(submissionId: string): Promise<EvaluationData | null>
  createRunningEvaluation(row: {
    submission_id: string
    invoice_uuid: string
    criteria_hash: Bytes32
    criteria_version: number
    model: string
    prompt_version: string
    pass_rule: string
    simulated: boolean
  }): Promise<EvaluationData>
  finalizeEvaluation(
    id: string,
    result: {
      model: string
      prompt_version: string
      simulated: boolean
      score: number
      passed: boolean
      criteria_results: NonNullable<EvaluationData["criteria_results"]>
      summary: string
    }
  ): Promise<EvaluationData>
  failEvaluation(id: string, message: string): Promise<void>
  /** The advance request that currently blocks a new one (pending or paid), if any. */
  findLiveAdvance(invoiceId: string): Promise<AdvanceRequestData | null>
  findAdvanceByKey(userId: string, key: string): Promise<AdvanceRequestData | null>
  listAdvanceRequests(invoiceId: string): Promise<AdvanceRequestData[]>
  createAdvanceRequest(row: {
    invoice_uuid: string
    requester_user_id: string
    requester_address: Address
    submission_id: string
    evaluation_id: string
    amount: string
    idempotency_key: string
  }): Promise<AdvanceRequestData>
  /** Records the broadcast approveAdvance as a PENDING transaction and links it to the request. Never marks anything paid. */
  attachPendingTransaction(args: {
    requestId: string
    invoiceId: string
    chainId: number
    from: Address
    amount: string
    txHash: Bytes32
  }): Promise<AdvanceRequestData>
  failAdvanceRequest(id: string, reason: string): Promise<void>
  registerInvoice(args: RegisterInvoiceArgs): Promise<{ id: string; created: boolean }>
}

export interface BackendDeps {
  db: BackendDb
  objects: EvidenceObjectStore
  chain: ChainAdapter
  signer: AdvanceSigner
  evaluator: Evaluator
  newId?: () => string
}
