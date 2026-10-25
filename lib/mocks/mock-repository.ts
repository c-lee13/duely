/**
 * MockDuelyRepository — in-browser simulated backend for demo mode.
 * State lives in memory and localStorage. Identity comes from the demo role
 * switcher, which is a convenience for demos and is NOT authentication.
 */
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
  TxAction,
} from "@/lib/frontend/domain"
import { DomainError } from "@/lib/frontend/errors"
import { getAdvanceEligibility } from "@/lib/frontend/eligibility"
import type { DemoControls, DemoSettings, DuelyRepository } from "@/lib/frontend/repository"
import { isZero, sum } from "@/lib/frontend/token"
import { ACTORS, ROLE_ACTOR } from "./actors"
import { simulateEvaluation } from "./evaluator"
import { buildSeedState } from "./fixtures"
import * as ledger from "./ledger"
import type { MockState, TxContext } from "./ledger"

const STORAGE_KEY = "duely.mock-state.v2"
const READ_DELAY_MS = 250
const WRITE_DELAY_MS = 600
const TX_DELAY_MS = 1600
const EVAL_DELAY_MS = 2200

export const EVIDENCE_MAX_BYTES = 25 * 1024 * 1024
export const EVIDENCE_ACCEPT = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/zip",
  "application/x-zip-compressed",
  "text/markdown",
  "text/plain",
]

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()
const clone = <T,>(v: T): T => structuredClone(v)
const byNewest = <T,>(key: (x: T) => string) => (a: T, b: T) => key(b).localeCompare(key(a))

export class MockDuelyRepository implements DuelyRepository {
  readonly mode = "mock" as const
  readonly demo: DemoControls
  private state: MockState | null = null
  private listeners = new Set<() => void>()
  private inflight = new Set<string>()

  constructor() {
    this.demo = {
      switchRole: (role: DemoRole) => {
        this.load().role = role
        this.commit()
      },
      reset: () => {
        this.state = buildSeedState()
        this.inflight.clear()
        this.commit()
      },
      getSettings: (): DemoSettings => clone(this.load().settings),
      setFailNextTransaction: (value: boolean) => {
        this.load().settings.failNextTransaction = value
        this.commit()
      },
    }
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (e) => {
        if (e.key !== STORAGE_KEY) return
        this.state = null
        this.emit()
      })
    }
  }

  // ---- state plumbing --------------------------------------------------------

  private load(): MockState {
    if (this.state) return this.state
    let loaded: MockState | null = null
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw) as MockState
          if (parsed?.schemaVersion === ledger.MOCK_SCHEMA_VERSION) loaded = parsed
        }
      } catch {
        loaded = null
      }
    }
    this.state = loaded ? this.recoverInterrupted(loaded) : buildSeedState()
    return this.state
  }

  /** Anything left pending by a page reload is marked failed — never assumed successful. */
  private recoverInterrupted(s: MockState): MockState {
    if (this.inflight.size > 0) return s
    const at = now()
    for (const tx of s.transactions) {
      if (tx.status === "pending") {
        tx.status = "failed"
        tx.error = "Interrupted by a page reload before confirmation. No balances changed."
        tx.settledAt = at
      }
    }
    for (const ev of s.evaluations) {
      if (ev.state === "running") {
        ev.state = "error"
        ev.errorMessage = "Evaluation was interrupted by a page reload. Run it again."
      }
    }
    for (const r of s.advanceRequests) {
      if (r.status === "pending") {
        r.status = "failed"
        r.reason = "Interrupted by a page reload before confirmation. No advance was paid."
      }
    }
    return s
  }

  private commit() {
    const s = this.load()
    if (process.env.NODE_ENV !== "production") {
      const problems = ledger.checkInvariants(s)
      if (problems.length) console.error("[mock ledger] invariant violation", problems)
    }
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
      } catch {
        // Storage full or blocked: demo keeps working in memory.
      }
    }
    this.emit()
  }

  private emit() {
    this.listeners.forEach((l) => l())
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private sessionFrom(s: MockState): Session {
    const actor = ROLE_ACTOR[s.role]
    return { role: s.role, wallet: actor.wallet, displayName: actor.name, isDemo: true }
  }

  private requireRole(role: DemoRole): Session {
    const session = this.sessionFrom(this.load())
    if (session.role !== role) {
      throw new DomainError("FORBIDDEN", `Switch to the ${role} role to do this.`)
    }
    return session
  }

  private canView(session: Session, invoice: InvoiceDetail) {
    if (session.role === "platform") return true
    const w = session.wallet.toLowerCase()
    return invoice.client.toLowerCase() === w || invoice.freelancer.toLowerCase() === w
  }

  /**
   * Simulated wallet transaction: dry-run (like gas estimation) → pending →
   * confirmed or failed. State only changes on confirmation.
   */
  private async runTx<T>(
    meta: { action: TxAction; from: Address; invoiceId?: InvoiceId; amount?: TokenAmount },
    apply: (s: MockState, ctx: TxContext) => T
  ): Promise<T> {
    const key = `${meta.action}:${meta.invoiceId ?? ""}`
    if (this.inflight.has(key)) {
      throw new DomainError("DUPLICATE_REQUEST", "This transaction is already pending.")
    }
    this.inflight.add(key)
    try {
      apply(clone(this.load()), { at: now() }) // pre-flight; throws like a revert
      const pending = ledger.addPendingTx(this.load(), { ...meta, at: now() })
      this.commit()

      await delay(TX_DELAY_MS)

      const s = this.load()
      const tx = s.transactions.find((t) => t.id === pending.id)
      if (!tx) throw new DomainError("TX_FAILED", "The demo was reset while this transaction was pending.")

      if (s.settings.failNextTransaction) {
        s.settings.failNextTransaction = false
        tx.status = "failed"
        tx.error = "Simulated transaction failure (demo control). No balances changed."
        tx.settledAt = now()
        if (meta.invoiceId) {
          ledger.addTimeline(s, {
            invoiceId: meta.invoiceId,
            at: tx.settledAt,
            kind: "tx_failed",
            layer: "onchain",
            title: "Simulated transaction failed",
            description: `${meta.action} did not confirm. Nothing moved; you can retry.`,
          })
        }
        this.commit()
        throw new DomainError("TX_FAILED", tx.error)
      }

      const draft = clone(s)
      try {
        const result = apply(draft, { at: now(), txId: pending.id })
        this.state = draft
        this.commit()
        return result
      } catch (e) {
        tx.status = "failed"
        tx.error = e instanceof Error ? e.message : "Transaction reverted."
        tx.settledAt = now()
        this.commit()
        throw e
      }
    } finally {
      this.inflight.delete(key)
    }
  }

  // ---- reads -----------------------------------------------------------------

  async getSession(): Promise<Session> {
    return this.sessionFrom(this.load())
  }

  async listInvoices(role: DemoRole, wallet: string): Promise<InvoiceDetail[]> {
    await delay(READ_DELAY_MS)
    const w = wallet.toLowerCase()
    const list = this.load().invoices.filter((i) =>
      role === "platform"
        ? true
        : role === "client"
          ? i.client.toLowerCase() === w
          : i.freelancer.toLowerCase() === w
    )
    return clone(list).sort(byNewest((i) => i.createdAt))
  }

  async getInvoice(invoiceId: InvoiceId): Promise<InvoiceBundle> {
    await delay(READ_DELAY_MS)
    const s = this.load()
    const invoice = ledger.findInvoice(s, invoiceId)
    if (!this.canView(this.sessionFrom(s), invoice)) {
      throw new DomainError("FORBIDDEN", "This invoice belongs to a different client or freelancer.")
    }
    const of = <T extends { invoiceId?: InvoiceId }>(xs: T[]) => xs.filter((x) => x.invoiceId === invoiceId)
    return clone({
      invoice,
      submissions: of(s.submissions).sort(byNewest((x) => x.createdAt)),
      evaluations: of(s.evaluations).sort(byNewest((x) => x.evaluatedAt)),
      advanceRequests: of(s.advanceRequests).sort(byNewest((x) => x.createdAt)),
      timeline: of(s.timeline).sort((a, b) => a.at.localeCompare(b.at)),
      transactions: of(s.transactions).sort(byNewest((x) => x.createdAt)),
      reserveAvailable: s.reserve,
    })
  }

  async getEvaluation(submissionId: string): Promise<EvaluationRecord | null> {
    await delay(READ_DELAY_MS)
    const found = this.load().evaluations.find((e) => e.submissionId === submissionId)
    return found ? clone(found) : null
  }

  async getTimeline(invoiceId: InvoiceId): Promise<TimelineEvent[]> {
    return (await this.getInvoice(invoiceId)).timeline
  }

  async listTransactions(): Promise<TransactionRecord[]> {
    await delay(READ_DELAY_MS)
    const s = this.load()
    const session = this.sessionFrom(s)
    const visible = new Set(s.invoices.filter((i) => this.canView(session, i)).map((i) => i.invoiceId))
    const list = s.transactions.filter((t) =>
      session.role === "platform"
        ? true
        : t.from.toLowerCase() === session.wallet.toLowerCase() || (t.invoiceId && visible.has(t.invoiceId))
    )
    return clone(list).sort(byNewest((t) => t.createdAt))
  }

  async getBalances(): Promise<PlatformBalances> {
    await delay(READ_DELAY_MS)
    const s = this.load()
    const session = this.sessionFrom(s)
    const unsettled = s.invoices.filter((i) => i.onchainStatus !== "Settled")
    return {
      reserveAvailable: s.reserve,
      escrowLocked: sum(s.invoices.map((i) => i.escrowBalance)),
      advancesOutstanding: sum(unsettled.map((i) => i.advanceAmount)),
      advancesAtRisk: sum(s.invoices.filter((i) => i.onchainStatus === "Disputed").map((i) => i.advanceAmount)),
      walletBalance: ledger.walletBalance(s, session.wallet),
    }
  }

  // ---- client actions --------------------------------------------------------

  async createInvoice(input: CreateInvoiceInput): Promise<InvoiceDetail> {
    const session = this.requireRole("client")
    const created = await this.runTx({ action: "createInvoice", from: session.wallet, amount: input.amount }, (s, ctx) =>
      ledger.createInvoice(s, session.wallet, input, ctx)
    )
    return clone(created)
  }

  async fundInvoice(invoiceId: InvoiceId): Promise<void> {
    const session = this.requireRole("client")
    const amount = ledger.findInvoice(this.load(), invoiceId).amount
    await this.runTx({ action: "fundInvoice", from: session.wallet, invoiceId, amount }, (s, ctx) =>
      ledger.fundInvoice(s, session.wallet, invoiceId, ctx)
    )
  }

  async approveInvoice(invoiceId: InvoiceId): Promise<void> {
    const session = this.requireRole("client")
    const amount = ledger.findInvoice(this.load(), invoiceId).amount
    await this.runTx({ action: "approveCompletion", from: session.wallet, invoiceId, amount }, (s, ctx) =>
      ledger.approveWork(s, session.wallet, invoiceId, ctx)
    )
  }

  async resolveDispute(): Promise<void> {
    // The simulated demo has no operator role; resolution exists only against the real contract (live mode).
    throw new DomainError("NOT_IMPLEMENTED", "Dispute resolution is an operator action on the real contract; it isn't part of the simulated demo.")
  }

  async disputeInvoice(invoiceId: InvoiceId): Promise<void> {
    const session = this.requireRole("client")
    await this.runTx({ action: "raiseDispute", from: session.wallet, invoiceId }, (s, ctx) =>
      ledger.disputeInvoice(s, session.wallet, invoiceId, ctx)
    )
  }

  // ---- freelancer actions ----------------------------------------------------

  async submitEvidence(input: SubmitEvidenceInput): Promise<Submission> {
    const session = this.requireRole("freelancer")
    if (input.fileSize > EVIDENCE_MAX_BYTES) {
      throw new DomainError("INVALID_INPUT", "Files must be 25 MB or smaller.")
    }
    if (input.mimeType && !EVIDENCE_ACCEPT.includes(input.mimeType)) {
      throw new DomainError("INVALID_INPUT", "Upload a PDF, PNG, JPG, ZIP, Markdown or text file.")
    }
    // Validate before the simulated upload delay.
    ledger.addSubmission(clone(this.load()), session.wallet, input, now())
    await delay(WRITE_DELAY_MS)
    const s = this.load()
    const submission = ledger.addSubmission(s, session.wallet, input, now())
    s.simulatedOutcomes[submission.submissionId] = input.simulatedOutcome ?? "pass"
    this.commit()
    return clone(submission)
  }

  async requestEvaluation(submissionId: string): Promise<EvaluationRecord> {
    const s0 = this.load()
    const submission = s0.submissions.find((x) => x.submissionId === submissionId)
    if (!submission) throw new DomainError("NOT_FOUND", "Submission not found.")
    const invoice = ledger.findInvoice(s0, submission.invoiceId)
    if (!this.canView(this.sessionFrom(s0), invoice)) {
      throw new DomainError("FORBIDDEN", "You can't evaluate this submission.")
    }
    const existing = s0.evaluations.find((e) => e.submissionId === submissionId)
    if (existing?.state === "completed") return clone(existing) // idempotent
    if (existing?.state === "running" || this.inflight.has(`eval:${submissionId}`)) {
      throw new DomainError("DUPLICATE_REQUEST", "This submission is already being evaluated.")
    }

    this.inflight.add(`eval:${submissionId}`)
    try {
      const evaluationId = existing?.evaluationId ?? `eval-${ledger.nextId(s0, "evaluation")}`
      const running: EvaluationRecord = {
        evaluationId,
        invoiceId: invoice.invoiceId,
        submissionId,
        score: 0,
        passed: false,
        criteriaResults: [],
        summary: "",
        state: "running",
        criteriaHash: invoice.criteriaHash,
        criteriaVersion: invoice.criteriaVersion,
        model: "simulated-evaluator",
        promptVersion: "mock-v1",
        evaluatedAt: now(),
        passRule: "",
        mandatory: [],
        simulated: true,
      }
      ledger.storeEvaluation(s0, running)
      this.commit()

      await delay(EVAL_DELAY_MS)

      const s = this.load()
      const currentInvoice = ledger.findInvoice(s, invoice.invoiceId)
      const sub = s.submissions.find((x) => x.submissionId === submissionId)
      if (!sub) throw new DomainError("EVALUATION_FAILED", "The demo was reset during evaluation.")
      const result = simulateEvaluation({
        evaluationId,
        invoice: currentInvoice,
        submission: sub,
        outcome: s.simulatedOutcomes[submissionId] ?? "pass",
        at: now(),
      })
      ledger.storeEvaluation(s, result)
      this.commit()
      return clone(result)
    } finally {
      this.inflight.delete(`eval:${submissionId}`)
    }
  }

  async requestAdvance(invoiceId: InvoiceId): Promise<AdvanceRequestResult> {
    const session = this.requireRole("freelancer")
    const s = this.load()
    const invoice = ledger.findInvoice(s, invoiceId)
    if (invoice.freelancer.toLowerCase() !== session.wallet.toLowerCase()) {
      throw new DomainError("FORBIDDEN", "Only the assigned freelancer can request this advance.")
    }
    const lockKey = `advance:${invoiceId}`
    const requestId = `adv-${ledger.nextId(s, "request")}`
    const at = now()

    const bundleish = {
      invoice,
      submissions: s.submissions.filter((x) => x.invoiceId === invoiceId).sort(byNewest((x) => x.createdAt)),
      evaluations: s.evaluations.filter((x) => x.invoiceId === invoiceId).sort(byNewest((x) => x.evaluatedAt)),
      advanceRequests: s.advanceRequests.filter((x) => x.invoiceId === invoiceId),
      reserveAvailable: s.reserve,
    }
    const eligibility = getAdvanceEligibility(bundleish)
    const duplicate = this.inflight.has(lockKey)

    if (duplicate || !eligibility.eligible) {
      const reason = duplicate
        ? "An advance request for this invoice is already being processed."
        : eligibility.blockers[0].message
      s.advanceRequests.push({ requestId, invoiceId, status: "denied", amount: eligibility.amount, createdAt: at, reason })
      ledger.addTimeline(s, {
        invoiceId,
        at,
        kind: "advance_denied",
        layer: "offchain",
        title: "Advance request denied",
        description: reason,
      })
      this.commit()
      return { requestId, status: "denied", reason }
    }

    this.inflight.add(lockKey)
    s.advanceRequests.push({ requestId, invoiceId, status: "pending", amount: eligibility.amount, createdAt: at })
    ledger.addTimeline(s, {
      invoiceId,
      at,
      kind: "advance_requested",
      layer: "offchain",
      title: "Freelancer requested a 90% advance",
      description: "Eligibility checks passed. The platform signer is submitting the advance.",
      amount: eligibility.amount,
    })
    this.commit()

    const setRequest = (patch: Partial<{ status: "paid" | "failed"; reason: string; transactionId: string }>) => {
      const req = this.load().advanceRequests.find((r) => r.requestId === requestId)
      if (req) Object.assign(req, patch)
      this.commit()
    }

    try {
      await this.runTx(
        { action: "approveAdvance", from: ACTORS.platform.wallet, invoiceId, amount: eligibility.amount },
        (draft, ctx) => ledger.approveAdvance(draft, ACTORS.platform.wallet, invoiceId, ctx)
      )
      const tx = [...this.load().transactions].reverse().find((t) => t.action === "approveAdvance" && t.invoiceId === invoiceId)
      setRequest({ status: "paid", transactionId: tx?.id })
      return { requestId, status: "paid" }
    } catch (e) {
      const reason = e instanceof Error ? e.message : "The advance transaction failed."
      setRequest({ status: "failed", reason })
      return { requestId, status: "failed", reason }
    } finally {
      this.inflight.delete(lockKey)
    }
  }

  // ---- platform actions ------------------------------------------------------

  async depositReserve(amount: TokenAmount): Promise<void> {
    const session = this.requireRole("platform")
    if (isZero(amount)) throw new DomainError("INVALID_INPUT", "Enter an amount greater than zero.")
    await this.runTx({ action: "depositReserve", from: session.wallet, amount }, (s, ctx) =>
      ledger.depositReserve(s, session.wallet, amount, ctx)
    )
  }
}
