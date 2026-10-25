/**
 * Frontend domain types.
 *
 * The shared CLAUDE.md §6 types now live in `lib/shared/types.ts` and are re-exported below.
 * Everything below the divider is a UI-only extension used by the repository layer.
 */

// ---- Shared interface (CLAUDE.md section 6): defined once in lib/shared/types.ts -----------------------------

import type {
  Address,
  Bytes32,
  CriterionResult,
  EvaluationResult,
  InvoiceId,
  InvoiceRecord,
  OnchainInvoiceStatus,
  SubmissionStatus,
  TokenAmount,
  TxAction,
} from "@/lib/shared/types"

export type {
  Address,
  Bytes32,
  CriterionResult,
  EvaluationResult,
  InvoiceId,
  InvoiceRecord,
  OnchainInvoiceStatus,
  SubmissionStatus,
  TokenAmount,
  TxAction,
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
  /**
   * Live (API) mode only. False when `onchainStatus` is a database cache that was NOT read from the chain: the
   * escrow/received figures are then 0 placeholders, not facts. Undefined in mock mode.
   */
  financialStatusVerified?: boolean
  /** Live mode only: a dev test fixture that does not exist on any blockchain. */
  isTestFixture?: boolean
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

export type TxStatus = "pending" | "confirmed" | "failed"

export interface TransactionRecord {
  id: string
  /** `approve` is the ERC-20 allowance step that precedes funding or a reserve deposit. */
  action: TxAction | "approve"
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
  /** The broadcast approveAdvance, once the backend recorded one. It is pending until reconciled from a verified receipt. */
  txHash?: `0x${string}`
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
  /** Live mode only: false when no chain read happened, so reserve/funding cannot be verified. Undefined in mock mode. */
  chainVerified?: boolean
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
  /** The chosen file. Ignored by the mock adapter; the API adapter uploads it to private storage. */
  file?: File
  /** Mock-only: which deterministic outcome the simulated evaluator returns. */
  simulatedOutcome?: "pass" | "fail"
}

export interface AdvanceRequestResult {
  requestId: string
  status: AdvanceRequestStatus
  reason?: string
  txHash?: `0x${string}`
  amount?: TokenAmount
}
