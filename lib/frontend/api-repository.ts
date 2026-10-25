/**
 * ApiDuelyRepository: the LIVE data adapter. Every read and write goes through the authenticated Next.js API routes
 * (which enforce the session, verified-wallet ownership, invoice participation and RLS-backed persistence). Nothing
 * here touches localStorage for data or identity, and nothing is invented: workflows that need the blockchain
 * (create/fund/approve/dispute, advance payout, balances, transaction history) fail loudly and say why.
 *
 * Mock mode is a separate class (lib/mocks); `createRepository` picks one from NEXT_PUBLIC_DATA_MODE.
 */
import { signInWithWallet, signOut as walletSignOut } from "@/lib/auth/wallet-client"
import { EvidenceUploadError, uploadEvidence as defaultUploadEvidence } from "@/lib/evidence/upload-client"
import {
  toBundle,
  toEvaluationRecord,
  toInvoiceDetail,
  type ApiEvaluation,
  type ApiInvoiceDetail,
  type ApiInvoiceRecord,
} from "./api-mappers"
import type {
  Address,
  AdvanceRequestResult,
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
  TransactionRecord,
} from "./domain"
import { DomainError, type DomainErrorCode } from "./errors"
import type { DuelyRepository, LiveControls } from "./repository"

const CHAIN_NEEDED = "This needs the blockchain integration (deployed contract, ABI and signer), which isn't available yet."
const VIEW_KEY = "duely.live-view-role" // a UI preference only; never read as identity

/** Maps the backend's `{ error: { code } }` onto the UI's DomainError codes. */
function mapCode(code: string, status: number): DomainErrorCode {
  switch (code) {
    case "UNAUTHENTICATED":
      return "UNAUTHENTICATED"
    case "NO_VERIFIED_WALLET":
    case "FORBIDDEN":
    case "NOT_INVOICE_CREATOR":
    case "BAD_ORIGIN":
      return "FORBIDDEN"
    case "NOT_FOUND":
      return "NOT_FOUND"
    case "INVALID_INPUT":
    case "INVALID_FILE":
    case "FILE_TOO_LARGE":
    case "UNSUPPORTED_TYPE":
    case "CONTENT_MISMATCH":
    case "INVALID_PATH":
      return "INVALID_INPUT"
    case "INTEGRATION_UNAVAILABLE":
    case "EVALUATOR_UNAVAILABLE":
    case "CHAIN_UNAVAILABLE":
    case "SUPABASE_NOT_CONFIGURED":
      return "INTEGRATION_UNAVAILABLE"
    case "ALREADY_ADVANCED":
      return "ALREADY_ADVANCED"
    case "INSUFFICIENT_RESERVE":
      return "INSUFFICIENT_RESERVE"
    case "EVALUATION_IN_PROGRESS":
    case "DUPLICATE_REQUEST":
      return "DUPLICATE_REQUEST"
    case "NOT_FUNDED":
    case "INVOICE_CLOSED":
    case "INVOICE_DISPUTED":
    case "INVOICE_SETTLED":
    case "CRITERIA_INCOMPLETE":
      return "INVALID_STATUS"
    case "NO_SUBMISSION":
    case "NOT_EVALUATED":
    case "STALE_EVALUATION":
    case "STALE_SUBMISSION":
    case "EVALUATION_FAILED":
    case "EVALUATION_NOT_REAL":
    case "SUBMISSION_LIMIT":
    case "TOO_MANY_UPLOADS":
      return "NOT_ELIGIBLE"
    default:
      return status >= 500 ? "INTEGRATION_UNAVAILABLE" : "INVALID_STATUS"
  }
}

export interface ApiRepositoryDeps {
  fetch?: typeof fetch
  uploadEvidence?: typeof defaultUploadEvidence
  signIn?: () => Promise<unknown>
  signOut?: () => Promise<void>
  /** Where the (non-authoritative) view role is remembered. Defaults to sessionStorage when available. */
  storage?: Pick<Storage, "getItem" | "setItem"> | null
}

const defaultStorage = (): ApiRepositoryDeps["storage"] => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage
  } catch {
    return null
  }
}

export class ApiDuelyRepository implements DuelyRepository {
  readonly mode = "api" as const

  private listeners = new Set<() => void>()
  private viewRole: DemoRole
  private auth: Promise<{ authenticated: boolean; wallets: Address[] }> | null = null
  /** On-chain id (what the UI shows and routes by) -> database UUID (what write endpoints take). Never used as authorization. */
  private uuidByRef = new Map<string, string>()
  private bundles = new Map<string, InvoiceBundle>()
  private readonly doFetch: typeof fetch
  private readonly upload: typeof defaultUploadEvidence
  private readonly storage: ApiRepositoryDeps["storage"]
  private readonly doSignIn: () => Promise<unknown>
  private readonly doSignOut: () => Promise<void>

  constructor(deps: ApiRepositoryDeps = {}) {
    this.doFetch = deps.fetch ?? ((...a) => fetch(...a))
    this.upload = deps.uploadEvidence ?? defaultUploadEvidence
    this.storage = deps.storage === undefined ? defaultStorage() : deps.storage
    this.doSignIn = deps.signIn ?? signInWithWallet
    this.doSignOut = deps.signOut ?? walletSignOut
    let saved: string | null = null
    try {
      saved = this.storage?.getItem(VIEW_KEY) ?? null
    } catch {
      saved = null
    }
    this.viewRole = saved === "freelancer" ? "freelancer" : "client"
  }

  // ---- plumbing ---------------------------------------------------------------------------------------------

  private emit() {
    this.listeners.forEach((l) => l())
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private async api<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    let res: Response
    try {
      res = await this.doFetch(path, {
        method: init.method ?? "GET",
        credentials: "same-origin",
        headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
    } catch {
      throw new DomainError("INTEGRATION_UNAVAILABLE", "Couldn't reach the server. Check your connection and try again.")
    }
    const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    if (!res.ok) {
      throw new DomainError(mapCode(json?.error?.code ?? "", res.status), json?.error?.message ?? "The request failed.")
    }
    return json as T
  }

  private fetchAuth() {
    if (!this.auth) {
      this.auth = this.api<{ authenticated: boolean; wallets: Address[] }>("/api/auth/session")
        .then((a) => ({ authenticated: a.authenticated === true, wallets: (a.wallets ?? []).map((w) => w.toLowerCase() as Address) }))
        .catch((e) => {
          this.auth = null
          throw e
        })
    }
    return this.auth
  }

  private async mine(): Promise<Address[]> {
    const a = await this.fetchAuth()
    if (!a.authenticated) throw new DomainError("UNAUTHENTICATED", "Connect your wallet to continue.")
    return a.wallets
  }

  readonly live: LiveControls = {
    getAuth: () => this.fetchAuth(),
    signIn: async () => {
      await this.doSignIn()
      this.auth = null
      this.emit()
    },
    signOut: async () => {
      await this.doSignOut()
      this.auth = null
      this.uuidByRef.clear()
      this.bundles.clear()
      this.emit()
    },
    setViewRole: (role) => {
      this.viewRole = role
      try {
        this.storage?.setItem(VIEW_KEY, role)
      } catch {
        /* preference only */
      }
      this.emit()
    },
  }

  /** Database UUID for a UI invoice id, fetched (and authorized by the server) if not already known. */
  private async uuidFor(ref: InvoiceId): Promise<string> {
    const known = this.uuidByRef.get(ref)
    if (known) return known
    await this.getInvoice(ref)
    const id = this.uuidByRef.get(ref)
    if (!id) throw new DomainError("NOT_FOUND", "Invoice not found.")
    return id
  }

  // ---- session and reads --------------------------------------------------------------------------------------

  async getSession(): Promise<Session> {
    const wallets = await this.mine()
    if (wallets.length === 0) throw new DomainError("FORBIDDEN", "No verified wallet is linked to this account.")
    return {
      role: this.viewRole,
      wallet: wallets[0],
      displayName: `${wallets[0].slice(0, 6)}…${wallets[0].slice(-4)}`,
      isDemo: false,
    }
  }

  async listInvoices(role: DemoRole, _wallet: string): Promise<InvoiceDetail[]> {
    void _wallet // identity comes from the server session, never from an argument
    const mine = await this.mine()
    if (role === "platform") return [] // the platform view needs the chain; no invoice is "the platform's" off-chain
    const { invoices } = await this.api<{ invoices: ApiInvoiceRecord[] }>("/api/invoices")
    invoices.forEach((i) => this.uuidByRef.set(i.invoiceId, i.id))
    return invoices
      .filter((i) => (role === "client" ? mine.includes(i.client) : mine.includes(i.freelancer)))
      .map((i) => toInvoiceDetail(i, mine))
  }

  async getInvoice(invoiceId: InvoiceId): Promise<InvoiceBundle> {
    const mine = await this.mine()
    const detail = await this.api<ApiInvoiceDetail>(`/api/invoices/${encodeURIComponent(invoiceId)}`)
    this.uuidByRef.set(detail.invoice.invoiceId, detail.invoice.id)
    const bundle = toBundle(detail, mine)
    this.bundles.set(detail.invoice.invoiceId, bundle)
    return bundle
  }

  async getEvaluation(submissionId: string): Promise<EvaluationRecord | null> {
    for (const b of this.bundles.values()) {
      const hit = b.evaluations.find((e) => e.submissionId === submissionId)
      if (hit) return hit
    }
    return null
  }

  async getTimeline(invoiceId: InvoiceId): Promise<TimelineEvent[]> {
    return (await this.getInvoice(invoiceId)).timeline
  }

  /** No on-chain transaction data is exposed by the backend yet, so there is honestly nothing to list. */
  async listTransactions(): Promise<TransactionRecord[]> {
    await this.mine()
    return []
  }

  async getBalances(): Promise<PlatformBalances> {
    throw new DomainError("NOT_IMPLEMENTED", `Balances come from the contract. ${CHAIN_NEEDED}`)
  }

  // ---- writes the backend supports ---------------------------------------------------------------------------

  async submitEvidence(input: SubmitEvidenceInput): Promise<Submission> {
    await this.mine()
    if (!input.file) throw new DomainError("INVALID_INPUT", "Choose a file to upload.")
    const invoiceUuid = await this.uuidFor(input.invoiceId)
    try {
      const r = await this.upload({ invoiceId: invoiceUuid, file: input.file, note: input.note })
      this.emit()
      return {
        submissionId: r.submissionId,
        invoiceId: input.invoiceId,
        fileName: r.fileName,
        fileSize: r.fileSize,
        mimeType: r.mimeType,
        note: input.note,
        storagePath: "",
        createdAt: r.createdAt,
      }
    } catch (e) {
      if (e instanceof EvidenceUploadError) throw new DomainError(mapCode(e.code, 400), e.message)
      throw e
    }
  }

  async requestEvaluation(submissionId: string): Promise<EvaluationRecord> {
    await this.mine()
    const r = await this.api<ApiEvaluation & { invoiceId: string; criteriaResults: ApiEvaluation["criteriaResults"] }>("/api/evaluate", {
      method: "POST",
      body: { submissionId },
    })
    this.emit()
    return toEvaluationRecord({ ...r, state: "completed" }, r.invoiceId)
  }

  async requestAdvance(invoiceId: InvoiceId): Promise<AdvanceRequestResult> {
    await this.mine()
    const uuid = await this.uuidFor(invoiceId)
    const r = await this.api<{ requestId: string; status: AdvanceRequestResult["status"] }>("/api/advances", {
      method: "POST",
      body: { invoiceId: uuid },
    })
    this.emit()
    return { requestId: r.requestId, status: r.status }
  }

  // ---- workflows that need the blockchain: never faked ---------------------------------------------------------

  async createInvoice(): Promise<InvoiceDetail> {
    throw new DomainError("NOT_IMPLEMENTED", `Creating an invoice is a wallet transaction on the XRPL EVM chain. ${CHAIN_NEEDED}`)
  }
  async fundInvoice(): Promise<void> {
    throw new DomainError("NOT_IMPLEMENTED", `Funding escrow is a wallet transaction. ${CHAIN_NEEDED}`)
  }
  async approveInvoice(): Promise<void> {
    throw new DomainError("NOT_IMPLEMENTED", `Approving work settles escrow on-chain. ${CHAIN_NEEDED}`)
  }
  async disputeInvoice(): Promise<void> {
    throw new DomainError("NOT_IMPLEMENTED", `Opening a dispute is an on-chain action. ${CHAIN_NEEDED}`)
  }
  async depositReserve(): Promise<void> {
    throw new DomainError("NOT_IMPLEMENTED", `Depositing to the reserve is a platform wallet transaction. ${CHAIN_NEEDED}`)
  }
}
