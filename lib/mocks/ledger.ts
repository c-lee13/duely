/**
 * Simulated contract + off-chain store for mock mode.
 *
 * Transitions mirror the InvoiceAdvance.sol rules in CLAUDE.md §5/§7:
 * escrow and reserve are separate balances; advances come only from the
 * reserve; settlement credits the reserve by the actual advance and pays the
 * rest of escrow to the freelancer; disputes freeze settlement with no refund
 * or clawback. Nothing here touches a real chain.
 */
import type {
  AcceptanceCriterion,
  Address,
  AdvanceRequest,
  Bytes32,
  CreateInvoiceInput,
  DemoRole,
  EvaluationRecord,
  InvoiceDetail,
  InvoiceId,
  Submission,
  TimelineEvent,
  TimelineKind,
  TimelineLayer,
  TokenAmount,
  TransactionRecord,
  TxAction,
} from "@/lib/frontend/domain"
import { DomainError } from "@/lib/frontend/errors"
import { deriveSubmissionStatus } from "@/lib/frontend/eligibility"
import { mockCriteriaDigest } from "@/lib/frontend/criteria-digest"
import { advanceFor, DEFAULT_ADVANCE_SHARE_BPS, MAX_ADVANCE_SHARE_BPS, MIN_ADVANCE_SHARE_BPS, formatToken as formatTokenOf, gte, isZero, MOCK_TOKEN, sub, sum, toBig } from "@/lib/frontend/token"

/** Mock messages always speak in the simulated DEMO token. */
const formatToken = (amount: string) => formatTokenOf(amount, { token: MOCK_TOKEN })
import type { DemoSettings } from "@/lib/frontend/repository"
import { nameForWallet } from "./actors"

export const MOCK_SCHEMA_VERSION = 1

export interface MockState {
  schemaVersion: number
  role: DemoRole
  settings: DemoSettings
  invoices: InvoiceDetail[]
  submissions: Submission[]
  /** Mock-only: requested simulated evaluator outcome per submission. */
  simulatedOutcomes: Record<string, "pass" | "fail">
  evaluations: EvaluationRecord[]
  advanceRequests: AdvanceRequest[]
  transactions: TransactionRecord[]
  timeline: TimelineEvent[]
  wallets: Record<string, TokenAmount>
  reserve: TokenAmount
  /** Total demo tokens minted at genesis; used for the conservation invariant. */
  totalSupply: TokenAmount
  counters: Record<"invoice" | "submission" | "evaluation" | "tx" | "event" | "request", number>
}

export interface TxContext {
  at: string
  /** Existing pending transaction to confirm; when absent a confirmed record is appended. */
  txId?: string
}

export function nextId(s: MockState, key: keyof MockState["counters"]): number {
  s.counters[key] += 1
  return s.counters[key]
}

export function findInvoice(s: MockState, invoiceId: InvoiceId): InvoiceDetail {
  const invoice = s.invoices.find((i) => i.invoiceId === invoiceId)
  if (!invoice) throw new DomainError("NOT_FOUND", `Invoice #${invoiceId} was not found.`)
  return invoice
}

function balanceOf(s: MockState, wallet: Address): TokenAmount {
  return s.wallets[wallet.toLowerCase()] ?? "0"
}

function credit(s: MockState, wallet: Address, amount: TokenAmount) {
  s.wallets[wallet.toLowerCase()] = sum([balanceOf(s, wallet), amount])
}

function debit(s: MockState, wallet: Address, amount: TokenAmount) {
  const balance = balanceOf(s, wallet)
  if (!gte(balance, amount)) {
    throw new DomainError(
      "INSUFFICIENT_BALANCE",
      `Wallet balance ${formatToken(balance)} is less than ${formatToken(amount)}.`
    )
  }
  s.wallets[wallet.toLowerCase()] = sub(balance, amount)
}

export function walletBalance(s: MockState, wallet: Address): TokenAmount {
  return balanceOf(s, wallet)
}

export function addTimeline(
  s: MockState,
  e: {
    invoiceId: InvoiceId
    at: string
    kind: TimelineKind
    layer: TimelineLayer
    title: string
    description: string
    amount?: TokenAmount
  }
) {
  s.timeline.push({ id: `evt-${nextId(s, "event")}`, simulated: true, ...e })
}

export function addPendingTx(
  s: MockState,
  t: { action: TxAction; from: Address; invoiceId?: InvoiceId; amount?: TokenAmount; at: string }
): TransactionRecord {
  const tx: TransactionRecord = {
    id: `sim-tx-${String(nextId(s, "tx")).padStart(4, "0")}`,
    action: t.action,
    status: "pending",
    invoiceId: t.invoiceId,
    amount: t.amount,
    from: t.from,
    simulated: true,
    createdAt: t.at,
  }
  s.transactions.push(tx)
  return tx
}

function confirmTx(
  s: MockState,
  ctx: TxContext,
  t: { action: TxAction; from: Address; invoiceId?: InvoiceId; amount?: TokenAmount }
) {
  const existing = ctx.txId ? s.transactions.find((x) => x.id === ctx.txId) : undefined
  if (existing) {
    existing.status = "confirmed"
    existing.invoiceId = t.invoiceId ?? existing.invoiceId
    existing.amount = t.amount ?? existing.amount
    existing.settledAt = ctx.at
    return
  }
  const tx = addPendingTx(s, { ...t, at: ctx.at })
  tx.status = "confirmed"
  tx.settledAt = ctx.at
}

function requireCaller(actual: Address, expected: Address, what: string) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new DomainError("FORBIDDEN", `Only the ${what} can do this.`)
  }
}

function refreshSubmissionStatus(s: MockState, invoice: InvoiceDetail) {
  const subs = s.submissions
    .filter((x) => x.invoiceId === invoice.invoiceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const evals = s.evaluations.filter((x) => x.invoiceId === invoice.invoiceId)
  invoice.submissionStatus = deriveSubmissionStatus(subs, evals)
}

// ---- Simulated contract functions -----------------------------------------

export function createInvoice(
  s: MockState,
  caller: Address,
  input: CreateInvoiceInput,
  ctx: TxContext
): InvoiceDetail {
  if (toBig(input.amount) <= toBig("0")) {
    throw new DomainError("INVALID_INPUT", "Amount must be greater than zero.")
  }
  if (input.freelancer.toLowerCase() === caller.toLowerCase()) {
    throw new DomainError("INVALID_INPUT", "The freelancer wallet must differ from the client wallet.")
  }
  if (
    input.advanceShareBps !== undefined &&
    (!Number.isInteger(input.advanceShareBps) || input.advanceShareBps < MIN_ADVANCE_SHARE_BPS || input.advanceShareBps > MAX_ADVANCE_SHARE_BPS)
  ) {
    throw new DomainError("INVALID_INPUT", "The advance rate must be between 50% and 100%.")
  }
  if (input.criteria.length === 0) {
    throw new DomainError("INVALID_INPUT", "Add at least one acceptance criterion.")
  }
  const invoiceId = String(nextId(s, "invoice"))
  const criteria: AcceptanceCriterion[] = input.criteria.map((c, i) => ({
    id: `c${i + 1}`,
    text: c.text.trim(),
    mandatory: c.mandatory,
  }))
  const criteriaVersion = 1
  const invoice: InvoiceDetail = {
    invoiceId,
    client: caller,
    freelancer: input.freelancer,
    amount: input.amount,
    advanceAmount: "0",
    advanceShareBps: input.advanceShareBps ?? DEFAULT_ADVANCE_SHARE_BPS,
    criteriaHash: mockCriteriaDigest(criteriaVersion, criteria) as Bytes32,
    onchainStatus: "Created",
    submissionStatus: "NotSubmitted",
    description: input.description.trim(),
    title: input.title.trim(),
    criteria,
    criteriaVersion,
    clientName: nameForWallet(caller),
    freelancerName: nameForWallet(input.freelancer),
    createdAt: ctx.at,
    dueDate: input.dueDate,
    escrowBalance: "0",
    freelancerReceived: "0",
    reserveCredited: "0",
  }
  s.invoices.push(invoice)
  confirmTx(s, ctx, { action: "createInvoice", from: caller, invoiceId })
  addTimeline(s, {
    invoiceId,
    at: ctx.at,
    kind: "created",
    layer: "onchain",
    title: "Invoice created",
    description: `${invoice.clientName} created the invoice and committed ${criteria.length} acceptance criteria. The criteria are now locked.`,
    amount: invoice.amount,
  })
  return invoice
}

export function fundInvoice(s: MockState, caller: Address, invoiceId: InvoiceId, ctx: TxContext) {
  const invoice = findInvoice(s, invoiceId)
  requireCaller(caller, invoice.client, "invoice's client")
  if (invoice.onchainStatus !== "Created") {
    throw new DomainError("INVALID_STATUS", "This invoice is already funded.")
  }
  debit(s, caller, invoice.amount)
  invoice.escrowBalance = invoice.amount
  invoice.onchainStatus = "Funded"
  confirmTx(s, ctx, { action: "fundInvoice", from: caller, invoiceId, amount: invoice.amount })
  addTimeline(s, {
    invoiceId,
    at: ctx.at,
    kind: "funded",
    layer: "onchain",
    title: "Escrow funded",
    description: `The client locked the full invoice amount in escrow.`,
    amount: invoice.amount,
  })
}

export function depositReserve(s: MockState, caller: Address, amount: TokenAmount, ctx: TxContext) {
  if (toBig(amount) <= toBig("0")) {
    throw new DomainError("INVALID_INPUT", "Deposit must be greater than zero.")
  }
  debit(s, caller, amount)
  s.reserve = sum([s.reserve, amount])
  confirmTx(s, ctx, { action: "depositReserve", from: caller, amount })
}

export function approveAdvance(s: MockState, signer: Address, invoiceId: InvoiceId, ctx: TxContext) {
  const invoice = findInvoice(s, invoiceId)
  if (invoice.onchainStatus === "Disputed") {
    throw new DomainError("INVALID_STATUS", "Advances are frozen because this invoice is disputed.")
  }
  if (invoice.onchainStatus === "Advanced" || !isZero(invoice.advanceAmount)) {
    throw new DomainError("ALREADY_ADVANCED", "An advance was already paid for this invoice.")
  }
  if (invoice.onchainStatus !== "Funded") {
    throw new DomainError("INVALID_STATUS", `An advance can't be paid while the invoice is ${invoice.onchainStatus}.`)
  }
  const amount = advanceFor(invoice.amount, invoice.advanceShareBps)
  if (!gte(s.reserve, amount)) {
    throw new DomainError(
      "INSUFFICIENT_RESERVE",
      `The reserve has ${formatToken(s.reserve)} available but the advance needs ${formatToken(amount)}.`
    )
  }
  // Paid from the reserve only. Escrow is untouched.
  s.reserve = sub(s.reserve, amount)
  credit(s, invoice.freelancer, amount)
  invoice.advanceAmount = amount
  invoice.freelancerReceived = sum([invoice.freelancerReceived, amount])
  invoice.onchainStatus = "Advanced"
  confirmTx(s, ctx, { action: "approveAdvance", from: signer, invoiceId, amount })
  addTimeline(s, {
    invoiceId,
    at: ctx.at,
    kind: "advance_paid",
    layer: "onchain",
    title: "Advance paid from reserve",
    description: `The platform signer paid the advance to the freelancer from the prefunded reserve. Client escrow stays locked.`,
    amount,
  })
}

export function approveWork(s: MockState, caller: Address, invoiceId: InvoiceId, ctx: TxContext) {
  const invoice = findInvoice(s, invoiceId)
  requireCaller(caller, invoice.client, "invoice's client")
  if (invoice.onchainStatus === "Disputed") {
    throw new DomainError("INVALID_STATUS", "Settlement is frozen while the invoice is disputed.")
  }
  if (invoice.onchainStatus !== "Funded" && invoice.onchainStatus !== "Advanced") {
    throw new DomainError("INVALID_STATUS", `This invoice can't be approved while it is ${invoice.onchainStatus}.`)
  }
  const reserveCredit = invoice.advanceAmount
  const toFreelancer = sub(invoice.escrowBalance, reserveCredit)
  // Escrow → reserve is an internal accounting credit for the actual advance.
  s.reserve = sum([s.reserve, reserveCredit])
  credit(s, invoice.freelancer, toFreelancer)
  invoice.escrowBalance = "0"
  invoice.reserveCredited = reserveCredit
  invoice.freelancerReceived = sum([invoice.freelancerReceived, toFreelancer])
  invoice.onchainStatus = "Settled"
  confirmTx(s, ctx, { action: "approveCompletion", from: caller, invoiceId, amount: invoice.amount })
  addTimeline(s, {
    invoiceId,
    at: ctx.at,
    kind: "settled",
    layer: "onchain",
    title: "Client approved — invoice settled",
    description: isZero(reserveCredit)
      ? `No advance was taken, so escrow paid the full ${formatToken(toFreelancer)} to the freelancer.`
      : `Escrow credited ${formatToken(reserveCredit)} back to the reserve (internal accounting) and paid the remaining ${formatToken(toFreelancer)} to the freelancer.`,
    amount: invoice.amount,
  })
}

export function disputeInvoice(s: MockState, caller: Address, invoiceId: InvoiceId, ctx: TxContext) {
  const invoice = findInvoice(s, invoiceId)
  requireCaller(caller, invoice.client, "invoice's client")
  if (invoice.onchainStatus !== "Funded" && invoice.onchainStatus !== "Advanced") {
    throw new DomainError("INVALID_STATUS", `This invoice can't be disputed while it is ${invoice.onchainStatus}.`)
  }
  const hadAdvance = !isZero(invoice.advanceAmount)
  invoice.onchainStatus = "Disputed"
  confirmTx(s, ctx, { action: "raiseDispute", from: caller, invoiceId })
  addTimeline(s, {
    invoiceId,
    at: ctx.at,
    kind: "disputed",
    layer: "onchain",
    title: "Client opened a dispute",
    description: hadAdvance
      ? `Settlement is frozen and escrow stays locked. The ${formatToken(invoice.advanceAmount)} advance isn't clawed back; the platform carries that risk until a manual resolution.`
      : "Settlement is frozen and escrow stays locked until a manual resolution. No automatic refund happens.",
  })
}

// ---- Off-chain records ----------------------------------------------------

export function addSubmission(
  s: MockState,
  caller: Address,
  input: { invoiceId: InvoiceId; fileName: string; fileSize: number; mimeType: string; note: string },
  at: string
): Submission {
  const invoice = findInvoice(s, input.invoiceId)
  requireCaller(caller, invoice.freelancer, "assigned freelancer")
  if (invoice.onchainStatus !== "Funded") {
    throw new DomainError(
      "INVALID_STATUS",
      invoice.onchainStatus === "Created"
        ? "Evidence can be submitted once the client funds escrow."
        : `Evidence can't be submitted while the invoice is ${invoice.onchainStatus}.`
    )
  }
  const n = nextId(s, "submission")
  const submission: Submission = {
    submissionId: `sub-${n}`,
    invoiceId: input.invoiceId,
    fileName: input.fileName,
    fileSize: input.fileSize,
    mimeType: input.mimeType,
    note: input.note.trim(),
    storagePath: `mock://evidence/invoice-${input.invoiceId}/sub-${n}/${input.fileName}`,
    createdAt: at,
  }
  s.submissions.push(submission)
  refreshSubmissionStatus(s, invoice)
  addTimeline(s, {
    invoiceId: input.invoiceId,
    at,
    kind: "submitted",
    layer: "offchain",
    title: "Evidence submitted",
    description: `${invoice.freelancerName} uploaded “${input.fileName}” for review.`,
  })
  return submission
}

export function storeEvaluation(s: MockState, record: EvaluationRecord) {
  const invoice = findInvoice(s, record.invoiceId)
  s.evaluations = s.evaluations.filter((e) => e.evaluationId !== record.evaluationId)
  s.evaluations.push(record)
  refreshSubmissionStatus(s, invoice)
  if (record.state === "completed") {
    addTimeline(s, {
      invoiceId: record.invoiceId,
      at: record.evaluatedAt,
      kind: "evaluated",
      layer: "offchain",
      title: record.passed ? `Simulated AI evaluation passed (${record.score}/100)` : `Simulated AI evaluation didn't pass (${record.score}/100)`,
      description: record.summary,
    })
  }
}

export function refreshAllSubmissionStatuses(s: MockState) {
  s.invoices.forEach((i) => refreshSubmissionStatus(s, i))
}

// ---- Invariants -------------------------------------------------------------

/** Total supply is conserved across wallets, reserve and escrow. Returns problems found. */
export function checkInvariants(s: MockState): string[] {
  const problems: string[] = []
  const walletTotal = sum(Object.values(s.wallets))
  const escrowTotal = sum(s.invoices.map((i) => i.escrowBalance))
  const accounted = sum([walletTotal, escrowTotal, s.reserve])
  if (accounted !== s.totalSupply) {
    problems.push(`Token conservation broken: ${accounted} accounted vs ${s.totalSupply} supply`)
  }
  for (const i of s.invoices) {
    if (toBig(i.escrowBalance) < toBig("0")) problems.push(`Invoice #${i.invoiceId} escrow negative`)
    if (i.onchainStatus === "Settled" && !isZero(i.escrowBalance)) {
      problems.push(`Invoice #${i.invoiceId} settled with escrow remaining`)
    }
    if (i.onchainStatus === "Settled" && i.freelancerReceived !== i.amount) {
      problems.push(`Invoice #${i.invoiceId} settled but freelancer received ${i.freelancerReceived}`)
    }
  }
  if (toBig(s.reserve) < toBig("0")) problems.push("Reserve overdrawn")
  return problems
}
