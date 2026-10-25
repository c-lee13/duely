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
  SubmitGithubInput,
  TimelineEvent,
  TokenAmount,
  TransactionRecord,
} from "./domain"

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
  /** Wallet tx: createInvoice. Resolves with the new invoice once confirmed. */
  createInvoice(input: CreateInvoiceInput): Promise<InvoiceDetail>
  /** Wallet tx: ERC-20 approve + fundInvoice. */
  fundInvoice(invoiceId: InvoiceId): Promise<void>

  submitEvidence(input: SubmitEvidenceInput): Promise<Submission>
  /** Records a GitHub repository + commit as the submission (POST /api/submissions { type: "github" }). Nothing is paid. */
  submitGithubRepository(input: SubmitGithubInput): Promise<Submission>
  getEvaluation(submissionId: string): Promise<EvaluationRecord | null>
  requestEvaluation(submissionId: string): Promise<EvaluationRecord>

  /** Explicit freelancer request; backend signer submits approveAdvance. */
  requestAdvance(invoiceId: InvoiceId): Promise<AdvanceRequestResult>
  /** Client wallet tx: approveWork. */
  approveInvoice(invoiceId: InvoiceId): Promise<void>
  /** Client wallet tx: disputeInvoice. */
  disputeInvoice(invoiceId: InvoiceId): Promise<void>

  getTimeline(invoiceId: InvoiceId): Promise<TimelineEvent[]>
  listTransactions(): Promise<TransactionRecord[]>
  getBalances(): Promise<PlatformBalances>
  /** Platform role: depositReserve. */
  depositReserve(amount: TokenAmount): Promise<void>

  /** Change notifications so open screens refresh. */
  subscribe(listener: () => void): () => void

  /** Present only in mock mode. Never authorizes anything in API mode. */
  readonly demo?: DemoControls

  /** Present only in API (live) mode. The view role is a UI preference; the server authorizes every request. */
  readonly live?: LiveControls
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
