/**
 * Frontend domain types.
 *
 * The first block mirrors the shared interface in CLAUDE.md §6 field-for-field.
 * `lib/shared/types.ts` is owned by the integration owner and does not exist yet;
 * once it is published, replace this block with re-exports from `@/lib/shared/types`.
 * Everything below the divider is a UI-only extension used by the repository layer.
 */

// ---- Mirror of CLAUDE.md §6 (do not change shape here) ----------------------

export type Address = `0x${string}`
export type Bytes32 = `0x${string}`
export type InvoiceId = string // uint256 in decimal string form
export type TokenAmount = string // ERC-20 base units; never floating point

export type OnchainInvoiceStatus =
  | "Created"
  | "Funded"
  | "Advanced"
  | "Disputed"
  | "Settled"
export type SubmissionStatus = "NotSubmitted" | "Submitted" | "Evaluated"

export interface InvoiceRecord {
  invoiceId: InvoiceId
  client: Address
  freelancer: Address
  amount: TokenAmount
  advanceAmount: TokenAmount // actual amount advanced, 0 before advance
  criteriaHash: Bytes32
  onchainStatus: OnchainInvoiceStatus
  submissionStatus: SubmissionStatus
  description?: string
}

export interface CriterionResult {
  criterion: string
  passed: boolean
  reason: string
}

export interface EvaluationResult {
  invoiceId: InvoiceId
  submissionId: string
  score: number // integer 0..100
  passed: boolean
  criteriaResults: CriterionResult[]
  summary: string
}

// ---- UI-only extensions ----------------------------------------------------

export type DemoRole = "client" | "freelancer" | "platform"

export interface Session {
  role: DemoRole
  wallet: Address
  displayName: string
  /** True when identity comes from the demo role switcher, not real auth. */
  isDemo: boolean
}

/** Canonical criterion entry: ordered, versioned, immutable after creation. */
export interface AcceptanceCriterion {
  id: string
  text: string
  mandatory: boolean
}

export interface InvoiceDetail extends InvoiceRecord {
  title: string
  criteria: AcceptanceCriterion[]
  criteriaVersion: number
  clientName: string
  freelancerName: string
  createdAt: string
  dueDate?: string
  /** Escrow still held for this invoice (separate from the platform reserve). */
  escrowBalance: TokenAmount
  /** Total transferred to the freelancer for this invoice (advance + settlement). */
  freelancerReceived: TokenAmount
  /** Escrow credited back to the reserve at settlement (equals actual advance). */
  reserveCredited: TokenAmount
}

export interface Submission {
  submissionId: string
  invoiceId: InvoiceId
  fileName: string
  fileSize: number
  mimeType: string
  note: string
  /** Mock storage path; real uploads will go to private Supabase Storage. */
  storagePath: string
  createdAt: string
}

export type EvaluationState = "running" | "completed" | "error"

export interface EvaluationRecord extends EvaluationResult {
  evaluationId: string
  state: EvaluationState
  criteriaHash: Bytes32
  criteriaVersion: number
  model: string
  promptVersion: string
  evaluatedAt: string
  passRule: string
  /** Mandatory flag per criterion, same order as criteriaResults. */
  mandatory: boolean[]
  simulated: boolean
  errorMessage?: string
}

export type TxAction =
  | "createInvoice"
  | "fundInvoice"
  | "depositReserve"
  | "approveAdvance"
  | "approveWork"
  | "disputeInvoice"

export type TxStatus = "pending" | "confirmed" | "failed"

export interface TransactionRecord {
  id: string
  action: TxAction
  status: TxStatus
  invoiceId?: InvoiceId
  amount?: TokenAmount
  from: Address
  /** Only set for real, confirmed chain transactions. Always undefined in mock mode. */
  txHash?: `0x${string}`
  simulated: boolean
  createdAt: string
  settledAt?: string
  error?: string
}

export type AdvanceRequestStatus = "pending" | "paid" | "failed" | "denied"

export interface AdvanceRequest {
  requestId: string
  invoiceId: InvoiceId
  status: AdvanceRequestStatus
  amount: TokenAmount
  createdAt: string
  reason?: string
  transactionId?: string
}

export type TimelineLayer = "onchain" | "offchain"

export type TimelineKind =
  | "created"
  | "funded"
  | "submitted"
  | "evaluated"
  | "advance_requested"
  | "advance_paid"
  | "advance_denied"
  | "settled"
  | "disputed"
  | "tx_failed"

export interface TimelineEvent {
  id: string
  invoiceId: InvoiceId
  at: string
  kind: TimelineKind
  layer: TimelineLayer
  title: string
  description: string
  amount?: TokenAmount
  simulated: boolean
}

export interface InvoiceBundle {
  invoice: InvoiceDetail
  submissions: Submission[] // newest first
  evaluations: EvaluationRecord[] // newest first
  advanceRequests: AdvanceRequest[] // newest first
  timeline: TimelineEvent[] // oldest first
  transactions: TransactionRecord[] // newest first
  reserveAvailable: TokenAmount
}

export interface PlatformBalances {
  /** Reserve tokens available to fund advances. */
  reserveAvailable: TokenAmount
  /** Sum of all client escrow currently locked across invoices. */
  escrowLocked: TokenAmount
  /** Advances paid on invoices that are not yet settled (repayment pending). */
  advancesOutstanding: TokenAmount
  /** Advances on disputed invoices (platform bears this risk pending manual resolution). */
  advancesAtRisk: TokenAmount
  /** Balance of the connected demo wallet. */
  walletBalance: TokenAmount
}

export interface CreateInvoiceInput {
  title: string
  freelancer: Address
  amount: TokenAmount
  description: string
  dueDate?: string
  criteria: Array<{ text: string; mandatory: boolean }>
}

export interface SubmitEvidenceInput {
  invoiceId: InvoiceId
  fileName: string
  fileSize: number
  mimeType: string
  note: string
  /** Mock-only: which deterministic outcome the simulated evaluator returns. */
  simulatedOutcome?: "pass" | "fail"
}

export interface AdvanceRequestResult {
  requestId: string
  status: AdvanceRequestStatus
  reason?: string
}
