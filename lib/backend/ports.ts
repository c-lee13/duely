import type { Address, Bytes32, OnchainInvoiceStatus } from "@/lib/frontend/domain"
import type { EvidenceObjectStore } from "@/lib/evidence/service"
import type { DeploymentScope } from "@/lib/shared/deployment-scope"

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

/** The chain was reached but has no such invoice (or the transaction created none). Not an outage. */
export class ChainInvoiceNotFoundError extends Error {
  constructor(message = "The invoice does not exist on-chain.") {
    super(message)
    this.name = "ChainInvoiceNotFoundError"
  }
}

/** A reference points at a chain/contract other than the deployment this server serves. Never read or acted on. */
export class ChainScopeError extends Error {
  constructor(message = "That reference belongs to a different deployment.") {
    super(message)
    this.name = "ChainScopeError"
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
  /** The client's slider as committed in InvoiceCreated (V2); absent for V1 deployments, which always advance the 90% ceiling. */
  advanceShareBps?: bigint
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
  /** Parties and commitments as the contract records them. The real adapter always fills these; services verify them when present. */
  client?: Address
  freelancer?: Address
  /** The contract's `metadataHash` (= our criteria hash). */
  criteriaHash?: Bytes32
  /** Non-zero once an advance was paid. */
  evaluationHash?: Bytes32
  /** The client's slider (5000..10000 bps of the 90% ceiling). Absent = 10000 (V1). */
  advanceShareBps?: bigint
}

/** Everything needed to look up (or rebuild after a restart) one broadcast `approveAdvance`. */
export interface ChainAdvanceTxRef {
  txHash: Bytes32
  /** The evaluator account that sent it. */
  from: Address
  invoiceId: bigint
  evaluationHash: Bytes32
  /** When it was broadcast (ms since epoch), for the explorer/lifecycle record only. */
  submittedAt: number
}

/** A verified view of a broadcast approveAdvance. `confirmed` means: mined, succeeded, and the expected AdvancePaid event was decoded. */
export type ChainTxStatus =
  | { state: "pending" }
  | { state: "unknown"; reason: string }
  | { state: "reverted"; blockNumber: bigint; reason: string }
  | { state: "replaced"; reason: string }
  | { state: "unverified"; reason: string }
  | {
      state: "confirmed"
      blockNumber: bigint
      blockHash: Bytes32
      logIndex: number
      /** The decoded AdvancePaid event arguments (what was actually paid, to whom, for which evaluation). */
      paid: { invoiceId: bigint; freelancer: Address; amount: bigint; evaluationHash: Bytes32 }
    }

/** A paid advance found by scanning the chain's events, used to recover a transaction whose hash was never recorded. */
export interface ChainAdvanceFound {
  txHash: Bytes32
  from: Address
  blockNumber: bigint
  evaluationHash: Bytes32
}

export interface ChainAdapter {
  /** False when no confirmed contract/ABI/RPC config exists. Every method then throws ChainUnavailableError. */
  readonly available: boolean
  getInvoiceCreation(txHash: Bytes32): Promise<ChainInvoiceCreation>
  getInvoiceState(ref: ChainInvoiceRef): Promise<ChainInvoiceState>
  /** Platform reserve available to advance, in token base units. */
  getReserveAvailable(): Promise<bigint>
  /**
   * Looks at a broadcast approveAdvance. `waitMs > 0` waits up to that long for a final answer; 0 is one non-blocking look.
   * A final answer for a transaction that did not run (`reverted`, `replaced`) is the only thing that may release the slot.
   */
  getAdvanceTransaction(ref: ChainAdvanceTxRef, opts?: { waitMs?: number }): Promise<ChainTxStatus>
  /** The AdvancePaid event of this invoice, if one exists (crash recovery). Null when the chain has none. */
  findAdvancePaid(ref: ChainInvoiceRef): Promise<ChainAdvanceFound | null>
  /** Whether `address` holds the contract role right now (the on-chain role, not a database flag). */
  hasRole(role: "operator" | "evaluator" | "admin", address: Address): Promise<boolean>
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
  getAdvanceTransaction: async () => {
    throw new ChainUnavailableError()
  },
  findAdvancePaid: async () => {
    throw new ChainUnavailableError()
  },
  hasRole: async () => {
    throw new ChainUnavailableError()
  },
}

// ---- Authorized signer (never given to the AI; never imported by client code) ---------------------------------------

export interface AdvanceSigner {
  /** False when no evaluator key is configured or it is not the deployment's evaluator. Every method then throws ChainUnavailableError. */
  readonly available: boolean
  /** The evaluator account's address, or null when unavailable. */
  readonly address: Address | null
  /**
   * Submits approveAdvance(invoiceId, evaluationHash) from the EVALUATOR_ROLE account. Returns the broadcast hash; it never
   * waits for or claims confirmation (that is reconciled from the receipt). Never retried by the signer.
   */
  submitApproveAdvance(
    ref: ChainInvoiceRef,
    evaluationHash: Bytes32
  ): Promise<{ txHash: Bytes32; /** The evaluator's address (the on-chain sender). */ from: Address }>
}

export const unavailableSigner: AdvanceSigner = {
  available: false,
  address: null,
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
  /** Client-chosen slider mirrored from the chain: 5000..10000 bps of the 90% ceiling. */
  advance_share_bps: number
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
  /** The sender recorded with the transaction (the evaluator account), when a transaction is linked. */
  tx_from?: Address | null
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
  /** Slider read from the chain's InvoiceCreated event (5000..10000). */
  advanceShareBps: number
}

export interface BackendDb {
  verifiedAddresses(userId: string): Promise<Address[]>
  getInvoice(id: string): Promise<InvoiceData | null>
  /** Invoices where one of these (verified) wallets is the client or freelancer, newest first. */
  listInvoicesForWallets(addresses: Address[]): Promise<InvoiceData[]>
  /** Every registered invoice of ONE deployment (chain + contract), newest first. Operator views only. */
  listInvoicesInScope(scope: { chainId: number; contractAddress: string }, limit: number): Promise<InvoiceData[]>
  /** Same visibility rule, matched by on-chain id (may match several deployments). */
  findInvoicesByOnchainId(onchainId: string, addresses: Address[]): Promise<InvoiceData[]>
  listSubmissionsForInvoices(invoiceIds: string[]): Promise<SubmissionData[]> // newest first
  listEvaluationsForInvoices(invoiceIds: string[]): Promise<EvaluationData[]> // newest first
  getCriteria(invoiceId: string): Promise<CriterionData[]>
  listSubmissions(invoiceId: string): Promise<SubmissionData[]> // newest first
  getSubmission(id: string): Promise<SubmissionData | null>
  /** Scripted demo only: records a submission row for the calculator fixture without a stored file. */
  insertScriptedDemoSubmission?(row: { invoice_uuid: string; freelancer_user_id: string; freelancer_address: Address; storage_path: string; file_name: string; file_size: number; mime_type: string; note: string }): Promise<SubmissionData>
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
  getAdvanceRequest(id: string): Promise<AdvanceRequestData | null>
  /** Pending requests of an invoice (at most one), with their transaction hash when one was recorded. */
  listPendingAdvances(invoiceId: string): Promise<AdvanceRequestData[]>
  /**
   * A receipt-verified payout: the transaction becomes `confirmed` (with block data and the decoded event), the request
   * becomes `paid`, and the invoice's chain cache is updated. Idempotent: safe to call again after a crash between steps.
   */
  recordAdvanceConfirmed(args: {
    requestId: string
    transactionId: string
    invoiceId: string
    blockNumber: bigint
    blockHash: Bytes32
    logIndex: number
    receipt: Record<string, string>
    advanceAmount: string
    /** Fresh chain state to cache on the invoice, if it could be read. Absent = leave the cache alone. */
    cache?: { status: OnchainInvoiceStatus; blockNumber: bigint }
  }): Promise<AdvanceRequestData>
  /** A definitive non-payment (reverted/replaced/never broadcast): transaction `failed` (if any), request `failed`, slot released. */
  recordAdvanceFailed(args: { requestId: string; transactionId: string | null; reason: string }): Promise<void>
  /** Keeps the request pending but records why it needs a person to look (e.g. an unverified receipt). */
  noteAdvanceReview(requestId: string, reason: string): Promise<void>
  /** Links a transaction recovered from the chain's events to a request that never recorded one. */
  attachRecoveredTransaction(args: {
    requestId: string
    invoiceId: string
    chainId: number
    from: Address
    amount: string
    txHash: Bytes32
  }): Promise<AdvanceRequestData>
  registerInvoice(args: RegisterInvoiceArgs): Promise<{ id: string; created: boolean }>
}

export interface BackendDeps {
  /** The one deployment (chain + InvoiceAdvance + token) this process serves. Required: there is no unscoped mode. */
  scope: DeploymentScope
  /** How long POST /api/advances may wait for the receipt before answering `pending` (default 0: answer immediately). */
  confirmWaitMs?: number
  /** A pending request with no recorded transaction is only judged "never broadcast" after this long (default 120 s). */
  neverBroadcastAfterMs?: number
  now?: () => number
  db: BackendDb
  objects: EvidenceObjectStore
  chain: ChainAdapter
  signer: AdvanceSigner
  evaluator: Evaluator
  newId?: () => string
  /** DUELY_MOCK_AI_EVALUATION=true: an advance request on the calculator fixture invoice records its own scripted evaluation. */
  scriptedDemoAdvance?: boolean
}
