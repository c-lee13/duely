/**
 * Pure mapping from the backend API's JSON (lib/backend/*) to the UI's existing domain types, so the pages keep
 * working unchanged. Nothing here invents financial facts: when the chain wasn't read, escrow/received are 0
 * placeholders flagged `financialStatusVerified: false`, and no transaction or payment is ever fabricated.
 */
import type {
  AcceptanceCriterion,
  Address,
  AdvanceRequest,
  EvaluationRecord,
  InvoiceBundle,
  InvoiceDetail,
  OnchainInvoiceStatus,
  SubmissionStatus,
  Submission,
  TimelineEvent,
} from "./domain"

export interface ApiInvoiceRecord {
  id: string
  chainId: number
  isTestFixture: boolean
  createdAt: string
  invoiceId: string
  client: Address
  freelancer: Address
  amount: string
  advanceAmount: string
  criteriaHash: `0x${string}`
  onchainStatus: OnchainInvoiceStatus
  submissionStatus: SubmissionStatus
  description: string
  title: string
  financialStatusVerified: boolean
}

export interface ApiEvaluation {
  evaluationId: string
  submissionId: string
  state: "running" | "completed" | "error"
  score: number | null
  passed: boolean | null
  criteriaResults: Array<{ criterion: string; passed: boolean; reason: string; mandatory?: boolean }> | null
  summary: string | null
  criteriaHash: `0x${string}`
  criteriaVersion: number
  model: string
  promptVersion: string
  passRule: string
  simulated: boolean
  evaluatedAt: string | null
}

export interface ApiInvoiceDetail {
  invoice: ApiInvoiceRecord
  chain: { verified: true } | { verified: false }
  criteria: Array<{ position: number; id: string; text: string; mandatory: boolean }>
  criteriaVersion: number
  dueDate: string | null
  submissions: Array<{ submissionId: string; note: string; fileName: string; fileSize: number; mimeType: string; createdAt: string }>
  evaluations: ApiEvaluation[]
  advanceRequests: Array<{ requestId: string; status: AdvanceRequest["status"]; amount: string; reason: string | null; txHash: string | null; txFrom?: string | null; createdAt: string }>
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** "You" for the user's own wallets, a short address for everyone else. */
export const labelFor = (address: string, mine: readonly string[]) => (mine.includes(address) ? "You" : shortAddr(address))

/**
 * Derived ONLY from a chain-verified status. Unverified invoices get 0 placeholders (and the UI shows a notice
 * instead of the figures), because a cached status is not proof of escrow, advance or payout.
 */
export function figuresFor(status: OnchainInvoiceStatus, amount: string, advance: string, verified: boolean) {
  const zero = { escrowBalance: "0", freelancerReceived: "0", reserveCredited: "0" }
  if (!verified) return zero
  switch (status) {
    case "Created":
    case "Cancelled":
      return zero
    case "Funded":
      return { escrowBalance: amount, freelancerReceived: "0", reserveCredited: "0" }
    case "Advanced":
    case "Disputed":
      return { escrowBalance: amount, freelancerReceived: advance, reserveCredited: "0" }
    case "Settled":
      return { escrowBalance: "0", freelancerReceived: amount, reserveCredited: advance }
  }
}

export function toInvoiceDetail(
  v: ApiInvoiceRecord,
  mine: readonly string[],
  extra: { criteria?: AcceptanceCriterion[]; criteriaVersion?: number; dueDate?: string | null } = {}
): InvoiceDetail {
  return {
    // The UI's invoice id is the ON-CHAIN id (what users recognise); the backend resolves it among the caller's own invoices.
    invoiceId: v.invoiceId,
    client: v.client,
    freelancer: v.freelancer,
    amount: v.amount,
    advanceAmount: v.advanceAmount,
    criteriaHash: v.criteriaHash,
    onchainStatus: v.onchainStatus,
    submissionStatus: v.submissionStatus,
    description: v.description,
    title: v.title,
    criteria: extra.criteria ?? [],
    criteriaVersion: extra.criteriaVersion ?? 1,
    clientName: labelFor(v.client, mine),
    freelancerName: labelFor(v.freelancer, mine),
    createdAt: v.createdAt,
    dueDate: extra.dueDate ?? undefined,
    ...figuresFor(v.onchainStatus, v.amount, v.advanceAmount, v.financialStatusVerified),
    financialStatusVerified: v.financialStatusVerified,
    isTestFixture: v.isTestFixture,
  }
}

export function toEvaluationRecord(e: ApiEvaluation, invoiceId: string): EvaluationRecord {
  const results = e.criteriaResults ?? []
  return {
    invoiceId,
    submissionId: e.submissionId,
    score: e.score ?? 0,
    passed: e.passed === true,
    criteriaResults: results.map(({ criterion, passed, reason }) => ({ criterion, passed, reason })),
    summary: e.summary ?? "",
    evaluationId: e.evaluationId,
    state: e.state,
    criteriaHash: e.criteriaHash,
    criteriaVersion: e.criteriaVersion,
    model: e.model,
    promptVersion: e.promptVersion,
    evaluatedAt: e.evaluatedAt ?? "",
    passRule: e.passRule,
    mandatory: results.map((r) => r.mandatory === true),
    simulated: e.simulated,
  }
}

/** Off-chain events only. The timeline never contains an on-chain event it did not read from the chain. */
export function buildTimeline(detail: ApiInvoiceDetail): TimelineEvent[] {
  const inv = detail.invoice
  const events: TimelineEvent[] = [
    {
      id: `created-${inv.id}`,
      invoiceId: inv.invoiceId,
      at: inv.createdAt,
      kind: "created",
      layer: "offchain",
      title: inv.isTestFixture ? "Test fixture saved" : "Invoice registered",
      description: inv.isTestFixture
        ? "A development test fixture. It does not exist on any blockchain."
        : "The invoice was created on-chain and registered with Duely; its acceptance criteria are frozen.",
      simulated: false,
    },
  ]
  for (const s of detail.submissions) {
    events.push({
      id: `submitted-${s.submissionId}`,
      invoiceId: inv.invoiceId,
      at: s.createdAt,
      kind: "submitted",
      layer: "offchain",
      title: "Evidence uploaded",
      description: `${s.fileName} was stored privately.`,
      simulated: false,
    })
  }
  for (const e of detail.evaluations) {
    if (e.state !== "completed") continue
    events.push({
      id: `evaluated-${e.evaluationId}`,
      invoiceId: inv.invoiceId,
      at: e.evaluatedAt ?? inv.createdAt,
      kind: "evaluated",
      layer: "offchain",
      title: e.simulated ? "Simulated evaluation" : "AI evaluation",
      description: `Score ${e.score ?? 0}/100, ${e.passed ? "recommended pass" : "recommended not to pass"}. A recommendation, not a payment decision.`,
      simulated: e.simulated,
    })
  }
  for (const a of detail.advanceRequests) {
    const failed = a.status === "denied" || a.status === "failed"
    events.push({
      id: `advance-${a.requestId}`,
      invoiceId: inv.invoiceId,
      at: a.createdAt,
      kind: failed ? "advance_denied" : a.status === "paid" ? "advance_paid" : "advance_requested",
      layer: "offchain",
      title: failed ? "Advance not paid" : a.status === "paid" ? "Advance paid" : "Advance requested",
      description:
        a.status === "pending" ? "Submitted and waiting for on-chain confirmation. Nothing is paid until it confirms." : (a.reason ?? ""),
      amount: a.amount,
      simulated: false,
    })
  }
  return events.sort((x, y) => x.at.localeCompare(y.at))
}

export function toBundle(detail: ApiInvoiceDetail, mine: readonly string[]): InvoiceBundle {
  const invoice = toInvoiceDetail(detail.invoice, mine, {
    criteria: detail.criteria.map((c) => ({ id: c.id, text: c.text, mandatory: c.mandatory })),
    criteriaVersion: detail.criteriaVersion,
    dueDate: detail.dueDate,
  })
  const submissions: Submission[] = detail.submissions.map((s) => ({
    submissionId: s.submissionId,
    invoiceId: detail.invoice.invoiceId,
    fileName: s.fileName,
    fileSize: s.fileSize,
    mimeType: s.mimeType,
    note: s.note,
    storagePath: "", // private; files are opened through the authorized download endpoint
    createdAt: s.createdAt,
  }))
  return {
    invoice,
    submissions,
    evaluations: detail.evaluations.map((e) => toEvaluationRecord(e, detail.invoice.invoiceId)),
    advanceRequests: detail.advanceRequests.map((a) => ({
      requestId: a.requestId,
      invoiceId: detail.invoice.invoiceId,
      status: a.status,
      amount: a.amount,
      createdAt: a.createdAt,
      reason: a.reason ?? undefined,
      txHash: (a.txHash as `0x${string}` | null) ?? undefined,
    })),
    timeline: buildTimeline(detail),
    // Server-signed payouts only (client wallet transactions come from this browser's log). `confirmed` here means the backend
    // reconciled a verified receipt; a pending advance is pending.
    transactions: detail.advanceRequests
      .filter((a) => a.txHash && a.txFrom)
      .map((a) => ({
        id: `advance-tx-${a.requestId}`,
        action: "approveAdvance" as const,
        status: a.status === "paid" ? ("confirmed" as const) : a.status === "pending" ? ("pending" as const) : ("failed" as const),
        invoiceId: detail.invoice.invoiceId,
        amount: a.amount,
        from: a.txFrom as Address,
        txHash: a.txHash as `0x${string}`,
        simulated: false,
        createdAt: a.createdAt,
        error: a.status === "failed" || a.status === "denied" ? (a.reason ?? undefined) : undefined,
      })),
    reserveAvailable: "0", // unknown without the chain; see `chainVerified`
    chainVerified: detail.chain.verified,
  }
}
