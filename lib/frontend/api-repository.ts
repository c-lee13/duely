/**
 * ApiDuelyRepository: the LIVE data adapter. Every read and write goes through the authenticated Next.js API routes
 * (which enforce the session, verified-wallet ownership, invoice participation and RLS-backed persistence). Nothing
 * here touches localStorage for data or identity, and nothing is invented: workflows that need the blockchain
 * (create/fund/approve/dispute, advance payout, balances, transaction history) fail loudly and say why.
 *
 * Mock mode is a separate class (lib/mocks); `createRepository` picks one from NEXT_PUBLIC_DATA_MODE.
 */
import {
  approveCompletion,
  approveEscrowAllowance,
  createInvoice as sdkCreateInvoice,
  depositReserve as sdkDepositReserve,
  fundInvoice as sdkFundInvoice,
  getAvailableReserve,
  getInvoice as readChainInvoice,
  getPublicClient,
  getReserveSnapshot,
  getTokenBalance,
  hasRole,
  prepareDepositReserve,
  prepareFundInvoice,
  raiseDispute,
  resolveDispute as sdkResolveDispute,
  type ChainReader,
  type WriteContext,
} from "@/lib/chain"
import { signInWithWallet, signOut as walletSignOut } from "@/lib/auth/wallet-client"
import { computeMetadataHash } from "@/lib/shared/criteria"
import { browserTxLog, type TxLog, type TxLogEntry } from "./tx-log"
import { runTransaction, type ProgressListener, type TxProgress } from "./tx-runner"
import { connectWallet, readWalletState, requireWallet, switchToExpectedChain, watchWallet } from "./wallet-chain"
import { EvidenceUploadError, uploadEvidence as defaultUploadEvidence } from "@/lib/evidence/upload-client"
import {
  toBundle,
  toEvaluationRecord,
  toInvoiceDetail,
  type ApiEvaluation,
  type ApiInvoiceDetail,
  type ApiInvoiceRecord,
} from "./api-mappers"
import { formatToken, tokenDisplay } from "./token"
import type {
  Address,
  AdvanceRequestResult,
  CreateInvoiceInput,
  TokenAmount,
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
import type { DuelyRepository, LiveControls, WalletControls } from "./repository"

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
    case "EVIDENCE_NOT_EVALUABLE":
      return "INVALID_INPUT"
    case "WRONG_DEPLOYMENT":
    case "INTEGRITY_MISMATCH":
    case "CHAIN_TX_INVALID":
    case "CRITERIA_HASH_MISMATCH":
      return "INVALID_STATUS"
    case "INVOICE_CANCELLED":
      return "INVALID_STATUS"
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
  /** The browser wallet (MetaMask). Tests inject a fake; the default talks to window.ethereum. */
  wallet?: WalletPort
  /** This browser's record of submitted transactions (default: localStorage, scoped to the deployment). */
  txLog?: TxLog
  /** Client used for chain READS in the browser (default: the SDK's public-RPC client). */
  readClient?: ChainReader
  /** Wait between registration retries (injectable so tests don't sleep). */
  sleep?: (ms: number) => Promise<void>
  /** How long a wallet transaction is tracked before the UI reports it "still unconfirmed" (default 120 s). */
  txTimeoutMs?: number
}

/** What the repository needs from MetaMask. The default implementation is lib/frontend/wallet-chain. */
export interface WalletPort {
  require(opts?: { expectedAccount?: string }): Promise<WriteContext & { account: Address }>
  state: typeof readWalletState
  connect: typeof connectWallet
  switchNetwork: typeof switchToExpectedChain
  watch: typeof watchWallet
}

const defaultWallet: WalletPort = {
  require: (opts) => requireWallet(opts),
  state: () => readWalletState(),
  connect: () => connectWallet(),
  switchNetwork: () => switchToExpectedChain(),
  watch: (l) => watchWallet(l),
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
  private readonly walletPort: WalletPort
  private readonly txLog: TxLog
  private readonly readClientOverride: ChainReader | undefined
  private readonly sleep: (ms: number) => Promise<void>
  private readonly txTimeoutMs: number | undefined

  constructor(deps: ApiRepositoryDeps = {}) {
    this.txTimeoutMs = deps.txTimeoutMs
    this.walletPort = deps.wallet ?? defaultWallet
    this.txLog = deps.txLog ?? browserTxLog()
    this.readClientOverride = deps.readClient
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
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
    this.viewRole = saved === "freelancer" || saved === "platform" ? saved : "client"
  }

  readonly wallet: WalletControls = {
    getState: () => this.walletPort.state(),
    connect: async () => {
      const s = await this.walletPort.connect()
      this.emit()
      return s
    },
    switchNetwork: async () => {
      const s = await this.walletPort.switchNetwork()
      this.emit()
      return s
    },
    subscribe: (listener) => this.walletPort.watch(listener),
  }

  /** Browser-side chain READS (the public RPC). Authoritative for a wallet's own pre-flight checks; the server re-verifies independently. */
  private reader(): ChainReader {
    return this.readClientOverride ?? (getPublicClient() as unknown as ChainReader)
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
      throw new DomainError(mapCode(json?.error?.code ?? "", res.status), json?.error?.message ?? "The request failed.", json?.error?.code)
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
    if (role === "platform") {
      // The operator is not a party to invoices: the server authorizes this by the ON-CHAIN operator role and returns only
      // invoices whose Advanced/Disputed status it just read from the chain.
      const { invoices } = await this.api<{ invoices: ApiInvoiceRecord[] }>("/api/operator/invoices")
      invoices.forEach((i) => this.uuidByRef.set(i.invoiceId, i.id))
      return invoices.map((i) => toInvoiceDetail(i, mine))
    }
    if (role === "client" && mine.length > 0) await this.completePendingRegistrations(mine[0]).catch(() => undefined)
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
    // This browser's own wallet transactions for the invoice (pending until the SDK verified a receipt), newest first.
    for (const w of mine) await this.refreshLog(w).catch(() => undefined) // learn the verified outcome of anything still pending
    const own = this.txLog.list().filter((e) => e.invoiceId === detail.invoice.invoiceId).map(toTransactionRecord)
    bundle.transactions = [...own, ...bundle.transactions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    if (detail.chain.verified) {
      try {
        bundle.reserveAvailable = (await getAvailableReserve({ client: this.reader() })).toString(10)
      } catch {
        bundle.chainVerified = false // the reserve could not be read: say so instead of showing 0
      }
    }
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

  /** This browser's wallet transactions for the connected wallet. `confirmed` only where a verified receipt was recorded. */
  async listTransactions(): Promise<TransactionRecord[]> {
    const mine = await this.mine()
    const state = await this.walletPort.state().catch(() => null)
    const account = (state?.account && mine.includes(state.account) ? state.account : mine[0]) as Address
    await this.refreshLog(account).catch(() => undefined)
    return this.txLog.list(account).map(toTransactionRecord)
  }

  /** Confirmed balances read from the contract and token on the public RPC, plus the operator's server-verified exposure. */
  async getBalances(): Promise<PlatformBalances> {
    const mine = await this.mine()
    const state = await this.walletPort.state().catch(() => null)
    const account = (state?.account && mine.includes(state.account) ? state.account : mine[0]) as Address
    const [snapshot, walletBalance, operator] = await Promise.all([
      getReserveSnapshot({ client: this.reader() }),
      getTokenBalance(account, { client: this.reader() }),
      this.api<{ invoices: ApiInvoiceRecord[] }>("/api/operator/invoices"),
    ])
    const sum = (status: "Advanced" | "Disputed") =>
      operator.invoices.filter((i) => i.onchainStatus === status).reduce((acc, i) => acc + BigInt(i.advanceAmount), BigInt(0)).toString(10)
    return {
      reserveAvailable: snapshot.availableReserve.toString(10),
      escrowLocked: snapshot.totalEscrow.toString(10),
      advancesOutstanding: sum("Advanced"),
      advancesAtRisk: sum("Disputed"),
      walletBalance: walletBalance.toString(10),
    }
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
    const r = await this.api<{ requestId: string; status: AdvanceRequestResult["status"]; amount?: string; txHash?: `0x${string}` | null }>("/api/advances", {
      method: "POST",
      body: { invoiceId: uuid },
    })
    this.bundles.delete(invoiceId)
    this.emit()
    return { requestId: r.requestId, status: r.status, amount: r.amount, txHash: r.txHash ?? undefined }
  }

  // ---- wallet transactions ---------------------------------------------------------------------------------
  //
  // Every method below: (1) requires MetaMask on XRPL EVM Testnet and on the exact account allowed to act, (2) re-reads the
  // authoritative chain state and refuses an action the contract would reject, (3) sends through the SDK, (4) returns only
  // after `runTransaction` verified a confirmed receipt with the expected event. Nothing is optimistic.

  private async sdkContext(expectedAccount: string | undefined): Promise<WriteContext & { account: Address }> {
    const mine = await this.mine()
    const ctx = await this.walletPort.require({ expectedAccount })
    if (!mine.includes(ctx.account)) {
      throw new DomainError("WRONG_ACCOUNT", `MetaMask has ${ctx.account} selected, which isn't a wallet verified on this sign-in. Select your signed-in wallet, or sign in with this one.`)
    }
    return ctx
  }

  private invalidate(invoiceId?: InvoiceId) {
    if (invoiceId) this.bundles.delete(invoiceId)
    else this.bundles.clear()
    this.emit()
  }

  private async tx(
    ctx: WriteContext & { account: Address },
    spec: { label: string; action: TxLogEntry["action"]; invoiceId?: string; submit: () => ReturnType<Parameters<typeof runTransaction>[0]["submit"]>; onProgress?: ProgressListener; meta?: Record<string, unknown> }
  ) {
    try {
      return await runTransaction({ ...spec, from: ctx.account, ctx, log: this.txLog, timeoutMs: this.txTimeoutMs })
    } finally {
      this.emit() // pending / confirmed / failed: let open screens re-read
    }
  }

  private async approveIfNeeded(ctx: WriteContext & { account: Address }, amount: bigint, sufficient: boolean, symbol: string, invoiceId: string | undefined, onProgress?: ProgressListener) {
    if (sufficient) return
    // Exactly the amount needed, never an unlimited approval.
    await this.tx(ctx, { label: `Approve ${symbol} allowance`, action: "approve", invoiceId, submit: () => approveEscrowAllowance(amount, ctx), onProgress })
  }

  async createInvoice(input: CreateInvoiceInput, onProgress?: ProgressListener): Promise<InvoiceDetail> {
    const ctx = await this.sdkContext(undefined)
    if (!/^[1-9][0-9]*$/.test(input.amount)) throw new DomainError("INVALID_INPUT", "The amount must be a positive whole number of base units.")
    if (input.freelancer.toLowerCase() === ctx.account) throw new DomainError("INVALID_INPUT", "The freelancer wallet must differ from yours.")
    // Ids are positional and the encoding is the shared one the server verifies, so the on-chain commitment always matches.
    const criteria = input.criteria.map((c, i) => ({ id: `c${i + 1}`, text: c.text.trim(), mandatory: c.mandatory }))
    const metadataHash = computeMetadataHash(criteria)
    const registration = { title: input.title, description: input.description, dueDate: input.dueDate ?? null, criteria }
    const confirmed = await this.tx(ctx, {
      label: "Create invoice",
      action: "createInvoice",
      meta: { registration },
      onProgress,
      submit: () => sdkCreateInvoice({ freelancer: input.freelancer, amount: BigInt(input.amount), metadataHash }, ctx),
    })
    if (!confirmed.invoiceId) throw new DomainError("TX_FAILED", "The transaction confirmed but carried no invoice id; check it on the explorer.")
    // Remember the id so a reload can finish registration even if the next step fails.
    this.txLog.update(confirmed.hash, { invoiceId: confirmed.invoiceId, meta: { registration, onchainInvoiceId: confirmed.invoiceId } })
    const detail = await this.registerCreated(confirmed.invoiceId, confirmed.hash, registration, onProgress)
    this.invalidate()
    return detail
  }

  /** Registers a CONFIRMED on-chain invoice with the backend, which re-verifies the transaction, creator and criteria hash itself. */
  private async registerCreated(
    invoiceId: string,
    txHash: string,
    reg: { title: string; description: string; dueDate: string | null; criteria: Array<{ id: string; text: string; mandatory: boolean }> },
    onProgress?: ProgressListener
  ): Promise<InvoiceDetail> {
    const id = `register#${invoiceId}`
    const label = "Register invoice with Duely"
    const emit = (status: TxProgress["status"], error?: string) => onProgress?.({ id, label, status, error })
    emit("pending")
    let message = "The server couldn't verify the transaction yet."
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await this.api("/api/invoices", {
          method: "POST",
          body: { invoiceId, txHash, title: reg.title, description: reg.description, ...(reg.dueDate ? { dueDate: reg.dueDate } : {}), criteria: reg.criteria },
        })
        this.txLog.update(txHash, { meta: { registered: true, onchainInvoiceId: invoiceId } })
        emit("confirmed")
        return (await this.getInvoice(invoiceId)).invoice
      } catch (e) {
        message = e instanceof Error ? e.message : message
        if (e instanceof DomainError && e.apiCode === "CHAIN_TX_PENDING") {
          await this.sleep(2000)
          continue
        }
        break
      }
    }
    emit("failed", message)
    throw new DomainError(
      "REGISTRATION_PENDING",
      `Your invoice #${invoiceId} exists on-chain (transaction ${txHash}) but Duely couldn't register it yet: ${message} Nothing is lost. Reload this page and registration is retried automatically.`
    )
  }

  /**
   * Finishes registration for invoices this browser created on-chain but never managed to register (closed tab, outage). Only
   * transactions whose receipt is verified confirmed are registered, and the backend verifies them again.
   */
  private async completePendingRegistrations(account: Address): Promise<void> {
    await this.refreshLog(account).catch(() => undefined) // a tab closed mid-transaction: learn its verified outcome first
    for (const entry of this.txLog.list(account)) {
      const meta = entry.meta as { registration?: Parameters<ApiDuelyRepository["registerCreated"]>[2]; registered?: boolean; onchainInvoiceId?: string } | undefined
      if (entry.action !== "createInvoice" || !meta?.registration || meta.registered) continue
      const invoiceId = meta.onchainInvoiceId ?? entry.invoiceId
      if (!invoiceId || entry.status !== "confirmed") continue
      await this.registerCreated(invoiceId, entry.hash, meta.registration).catch(() => undefined)
    }
  }

  /** Re-checks this wallet's pending / unconfirmed transactions against the chain (non-blocking, verified receipts only). */
  private async refreshLog(account: Address): Promise<void> {
    const { getTransactionStatus, parseSubmittedTransaction } = await import("@/lib/chain")
    for (const entry of this.txLog.list(account)) {
      if (entry.status !== "pending" && entry.status !== "unknown") continue
      try {
        const status = await getTransactionStatus(parseSubmittedTransaction(entry.serialized), { publicClient: this.reader() as never })
        if (status.state === "confirmed") {
          const meta = { ...(entry.meta ?? {}), ...(status.invoiceId && entry.action === "createInvoice" ? { onchainInvoiceId: status.invoiceId } : {}) }
          this.txLog.update(entry.hash, { status: "confirmed", blockNumber: status.blockNumber.toString(10), meta })
        } else if (status.state === "reverted" || status.state === "replaced" || status.state === "unverified") {
          this.txLog.update(entry.hash, { status: "failed", error: status.error.message })
        }
      } catch {
        /* leave it as it was: unknown is not failure */
      }
    }
  }

  async fundInvoice(invoiceId: InvoiceId, onProgress?: ProgressListener): Promise<void> {
    const inv = (await this.getInvoice(invoiceId)).invoice
    const ctx = await this.sdkContext(inv.client)
    const ready = await prepareFundInvoice(BigInt(invoiceId), ctx.account, { client: this.reader() })
    const token = tokenDisplay("api")
    if (ready.invoice.status !== 0) throw new DomainError("INVALID_STATUS", `This invoice is ${ready.invoice.statusName} on-chain; only a Created invoice can be funded.`)
    if (ready.tokenPaused) throw new DomainError("TOKEN_PAUSED", `${token.symbol} is paused by its issuer, so nothing can be approved or funded right now. Try again later.`)
    if (ready.balance < ready.invoice.amount) {
      throw new DomainError("INSUFFICIENT_BALANCE", `You hold ${formatToken(ready.balance.toString(), { token, maxFraction: 6 })} but funding needs ${formatToken(ready.invoice.amount.toString(), { token, maxFraction: 6 })}.`)
    }
    await this.approveIfNeeded(ctx, ready.invoice.amount, ready.allowance.sufficient, token.symbol, invoiceId, onProgress)
    await this.tx(ctx, { label: "Fund escrow", action: "fundInvoice", invoiceId, onProgress, submit: () => sdkFundInvoice(BigInt(invoiceId), ctx) })
    this.invalidate(invoiceId)
  }

  private async clientAction(invoiceId: InvoiceId, allowed: number[], what: string) {
    const inv = (await this.getInvoice(invoiceId)).invoice
    const ctx = await this.sdkContext(inv.client)
    const onchain = await readChainInvoice(BigInt(invoiceId), { client: this.reader() })
    if (!allowed.includes(onchain.status)) throw new DomainError("INVALID_STATUS", `This invoice is ${onchain.statusName} on-chain, so it can't be ${what}.`)
    return ctx
  }

  async approveInvoice(invoiceId: InvoiceId, onProgress?: ProgressListener): Promise<void> {
    const ctx = await this.clientAction(invoiceId, [1, 2], "approved")
    await this.tx(ctx, { label: "Approve work and settle", action: "approveCompletion", invoiceId, onProgress, submit: () => approveCompletion(BigInt(invoiceId), ctx) })
    this.invalidate(invoiceId)
  }

  async disputeInvoice(invoiceId: InvoiceId, onProgress?: ProgressListener): Promise<void> {
    const ctx = await this.clientAction(invoiceId, [1, 2], "disputed")
    await this.tx(ctx, { label: "Open dispute", action: "raiseDispute", invoiceId, onProgress, submit: () => raiseDispute(BigInt(invoiceId), ctx) })
    this.invalidate(invoiceId)
  }

  private async operatorContext() {
    const ctx = await this.sdkContext(undefined)
    if (!(await hasRole("operator", ctx.account, { client: this.reader() }))) {
      throw new DomainError("FORBIDDEN", `${ctx.account} doesn't hold OPERATOR_ROLE on this deployment. Select the operator account in MetaMask.`)
    }
    return ctx
  }

  async depositReserve(amount: TokenAmount, onProgress?: ProgressListener): Promise<void> {
    if (!/^[1-9][0-9]*$/.test(amount)) throw new DomainError("INVALID_INPUT", "Enter an amount greater than zero.")
    const ctx = await this.operatorContext()
    const value = BigInt(amount)
    const token = tokenDisplay("api")
    const ready = await prepareDepositReserve(value, ctx.account, { client: this.reader() })
    if (ready.tokenPaused) throw new DomainError("TOKEN_PAUSED", `${token.symbol} is paused by its issuer, so nothing can be approved or deposited right now.`)
    if (ready.balance < value) {
      throw new DomainError("INSUFFICIENT_BALANCE", `This wallet holds ${formatToken(ready.balance.toString(), { token, maxFraction: 6 })} but the deposit needs ${formatToken(amount, { token, maxFraction: 6 })}.`)
    }
    await this.approveIfNeeded(ctx, value, ready.allowance.sufficient, token.symbol, undefined, onProgress)
    await this.tx(ctx, { label: "Deposit to reserve", action: "depositReserve", onProgress, submit: () => sdkDepositReserve(value, ctx) })
    this.invalidate()
  }

  async resolveDispute(invoiceId: InvoiceId, releaseToFreelancer: boolean, onProgress?: ProgressListener): Promise<void> {
    const ctx = await this.operatorContext()
    const onchain = await readChainInvoice(BigInt(invoiceId), { client: this.reader() })
    if (onchain.status !== 4) throw new DomainError("INVALID_STATUS", `This invoice is ${onchain.statusName} on-chain; only a Disputed invoice can be resolved.`)
    await this.tx(ctx, {
      label: releaseToFreelancer ? "Resolve dispute: pay the freelancer" : "Resolve dispute: refund the client",
      action: "resolveDispute",
      invoiceId,
      onProgress,
      submit: () => sdkResolveDispute(BigInt(invoiceId), releaseToFreelancer, ctx),
    })
    this.invalidate(invoiceId)
  }
}

const txStatusOf = (s: TxLogEntry["status"]): TransactionRecord["status"] => (s === "confirmed" ? "confirmed" : s === "failed" ? "failed" : "pending")

/** A log entry as a UI transaction. `unknown` (sent, outcome not known) stays PENDING with its warning: it is never shown as done. */
export function toTransactionRecord(e: TxLogEntry): TransactionRecord {
  return {
    id: e.hash,
    action: e.action,
    status: txStatusOf(e.status),
    invoiceId: e.invoiceId,
    from: e.from,
    txHash: e.hash,
    simulated: false,
    createdAt: new Date(e.createdAt).toISOString(),
    settledAt: e.status === "confirmed" ? new Date(e.createdAt).toISOString() : undefined,
    error: e.status === "failed" || e.status === "unknown" ? e.error : undefined,
  }
}
