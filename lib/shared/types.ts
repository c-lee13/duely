/**
 * Shared interface types (CLAUDE.md section 6). The single source for the on-chain status enum and the
 * transaction-action names; the frontend, backend, database checks and tests are all aligned to these.
 * Enum order and function names mirror the compiled contract (docs/CONTRACT_SPEC.md v1.1).
 */

export type Address = `0x${string}`
export type Bytes32 = `0x${string}`
export type InvoiceId = string // uint256 in decimal string form
export type TokenAmount = string // ERC-20 base units; never floating point

/** Same order as the Solidity `InvoiceStatus` enum (index = on-chain value). */
export const ONCHAIN_INVOICE_STATUSES = [
  "Created",
  "Funded",
  "Advanced",
  "Settled",
  "Disputed",
  "Cancelled",
] as const
export type OnchainInvoiceStatus = (typeof ONCHAIN_INVOICE_STATUSES)[number]

export type SubmissionStatus = "NotSubmitted" | "Submitted" | "Evaluated"

/**
 * Every state-changing InvoiceAdvance function, named exactly like the contract function. These are also the
 * allowed values of `transactions.action` in Supabase (migration 9 keeps the two legacy names for old rows).
 */
export const TX_ACTIONS = [
  "createInvoice",
  "cancelInvoice",
  "fundInvoice",
  "depositReserve",
  "withdrawReserve",
  "approveAdvance",
  "approveCompletion",
  "raiseDispute",
  "resolveDispute",
] as const
export type TxAction = (typeof TX_ACTIONS)[number]

/** Names used by the first frontend/DB draft. Rows may still carry them; new code never writes them. */
export const LEGACY_TX_ACTIONS = ["approveWork", "disputeInvoice"] as const

export interface InvoiceRecord {
  invoiceId: InvoiceId
  client: Address
  freelancer: Address
  amount: TokenAmount
  advanceAmount: TokenAmount // actual amount advanced, 0 before advance
  /** Keccak-256 of the canonical criteria (lib/shared/criteria.ts); on-chain it is `metadataHash`. */
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
