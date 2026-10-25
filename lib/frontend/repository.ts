import type {
  Address,
  AdvanceRequestResult,
  CreateInvoiceInput,
  DemoRole,
  EvaluationRecord,
  InvoiceBundle,
  InvoiceDetail,
  InvoiceId,
  PlatformBalances,
  Session,
  Submission,
  SubmitEvidenceInput,
  TimelineEvent,
  TokenAmount,
  TransactionRecord,
} from "./domain"
import type { ProgressListener } from "./tx-runner"
import type { WalletState } from "./wallet-chain"

/**
 * The one data boundary the UI talks to. `MockDuelyRepository` implements it
 * today; `ApiDuelyRepository` will implement it against `app/api/*` and the
 * wallet/contract adapter. Pages and components must not import fixtures.
 *
 * Identity for mutations comes from the session (demo role in mock mode,
 * authenticated wallet session in API mode) — never from method arguments.
 */
export interface DuelyRepository {
  readonly mode: "mock" | "api"

  getSession(): Promise<Session>

  listInvoices(role: DemoRole, wallet: string): Promise<InvoiceDetail[]>
  getInvoice(invoiceId: InvoiceId): Promise<InvoiceBundle>
  /**
   * Wallet tx: createInvoice, then registration with the backend. Resolves with the new invoice ONLY after the chain
   * confirmed the transaction (and the backend verified it). `onProgress` reports each wallet step as it happens.
   */
  createInvoice(input: CreateInvoiceInput, onProgress?: ProgressListener): Promise<InvoiceDetail>
  /** Wallet tx: ERC-20 approve (exact amount, only if needed) + fundInvoice. Resolves after both are confirmed. */
  fundInvoice(invoiceId: InvoiceId, onProgress?: ProgressListener): Promise<void>

  submitEvidence(input: SubmitEvidenceInput): Promise<Submission>
  getEvaluation(submissionId: string): Promise<EvaluationRecord | null>
  requestEvaluation(submissionId: string): Promise<EvaluationRecord>

  /** Explicit freelancer request; backend signer submits approveAdvance. */
  requestAdvance(invoiceId: InvoiceId): Promise<AdvanceRequestResult>
  /** Client wallet tx: approveCompletion. */
  approveInvoice(invoiceId: InvoiceId, onProgress?: ProgressListener): Promise<void>
  /** Client wallet tx: raiseDispute. */
  disputeInvoice(invoiceId: InvoiceId, onProgress?: ProgressListener): Promise<void>
  /**
   * Operator wallet tx: resolveDispute. `releaseToFreelancer: true` settles normally; `false` refunds the client's whole
   * escrow. An advance already paid is never clawed back (it is the reserve's loss).
   */
  resolveDispute(invoiceId: InvoiceId, releaseToFreelancer: boolean, onProgress?: ProgressListener): Promise<void>

  getTimeline(invoiceId: InvoiceId): Promise<TimelineEvent[]>
  listTransactions(): Promise<TransactionRecord[]>
  getBalances(): Promise<PlatformBalances>
  /** Operator wallet tx: ERC-20 approve (exact amount, only if needed) + depositReserve. */
  depositReserve(amount: TokenAmount, onProgress?: ProgressListener): Promise<void>

  /** Change notifications so open screens refresh. */
  subscribe(listener: () => void): () => void

  /** Present only in mock mode. Never authorizes anything in API mode. */
  readonly demo?: DemoControls

  /** Present only in API (live) mode. The view role is a UI preference; the server authorizes every request. */
  readonly live?: LiveControls

  /** Present only in API (live) mode: the browser wallet used for transactions. */
  readonly wallet?: WalletControls
}

export interface WalletControls {
  /** Reads MetaMask without prompting. */
  getState(): Promise<WalletState>
  /** Prompts MetaMask to connect this site. */
  connect(): Promise<WalletState>
  /** Switches MetaMask to XRPL EVM Testnet (adding it if unknown). */
  switchNetwork(): Promise<WalletState>
  /** Notified when the account or network changes in MetaMask. */
  subscribe(listener: () => void): () => void
}

export interface LiveControls {
  /** Who the server says is signed in, and their VERIFIED wallets. Never read from browser storage. */
  getAuth(): Promise<{ authenticated: boolean; wallets: Address[] }>
  /** Wallet sign-in: server challenge, signature, session cookie. */
  signIn(): Promise<void>
  signOut(): Promise<void>
  /** Which dashboard to show. Grants nothing: access is decided per invoice on the server. */
  setViewRole(role: DemoRole): void
}

export interface DemoSettings {
  failNextTransaction: boolean
}

export interface DemoControls {
  switchRole(role: DemoRole): void
  reset(): void
  getSettings(): DemoSettings
  setFailNextTransaction(value: boolean): void
}
