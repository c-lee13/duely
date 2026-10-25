"use client"

import * as React from "react"
import Link from "next/link"
import {
  ArrowRight,
  Banknote,
  CheckCircle2,
  Circle,
  Landmark,
  Lock,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import type {
  EvaluationRecord,
  InvoiceDetail,
  TimelineEvent,
  TransactionRecord,
} from "@/lib/frontend/domain"
import { shortHash } from "@/lib/frontend/criteria-digest"
import { advanceFor, formatToken, isZero, sub, tokenDisplay, tokenNotice } from "@/lib/frontend/token"
import { tryExplorerTxUrl } from "@/lib/chain/config"
import { useSession } from "@/hooks/use-duely"
import { AddressChip, Amount, formatDate, OnchainStatusBadge, Pill, SimulatedTag, TxStatusBadge } from "./primitives"

const TX_LABEL: Record<TransactionRecord["action"], string> = {
  approve: "Approve token allowance",
  createInvoice: "Create invoice",
  fundInvoice: "Fund escrow",
  depositReserve: "Deposit to reserve",
  approveAdvance: "Pay 90% advance",
  approveCompletion: "Approve & settle",
  raiseDispute: "Open dispute",
  cancelInvoice: "Cancel invoice",
  withdrawReserve: "Withdraw from reserve",
  resolveDispute: "Resolve dispute",
}

export function CriteriaList({ invoice }: { invoice: InvoiceDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="size-4 text-muted-foreground" aria-hidden /> Agreed acceptance criteria
        </CardTitle>
        <CardDescription>
          Locked when the invoice was created (v{invoice.criteriaVersion}). Changes require a new invoice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ol className="space-y-2">
          {invoice.criteria.map((c, i) => (
            <li key={c.id} className="flex gap-3 rounded-lg border p-3 text-sm">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">{c.text}</span>
              <Pill tone={c.mandatory ? "info" : "neutral"}>{c.mandatory ? "Mandatory" : "Optional"}</Pill>
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">
          Criteria digest <code className="rounded bg-muted px-1 py-0.5 font-mono">{shortHash(invoice.criteriaHash)}</code>{" "}
          — placeholder value; the real on-chain Keccak-256 hash arrives with chain integration.
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * Step-by-step money flow for one invoice. Driven only by ledger state (confirmed) and
 * any pending transaction; an unconfirmed advance or settlement is never shown as done.
 */
export function PaymentFlow({ invoice, transactions }: { invoice: InvoiceDetail; transactions: TransactionRecord[] }) {
  if (invoice.financialStatusVerified === false) return <UnverifiedMoneyNotice title="Payment breakdown" invoice={invoice} />
  const status = invoice.onchainStatus
  const hasAdvance = !isZero(invoice.advanceAmount)
  const advance = hasAdvance ? invoice.advanceAmount : advanceFor(invoice.amount)
  const remainder = sub(invoice.amount, advance)
  const pendingOf = (a: TransactionRecord["action"]) => transactions.some((t) => t.action === a && t.status === "pending")

  type Tone = "done" | "pending" | "todo" | "skipped" | "bad"
  const steps: Array<{ title: string; detail: React.ReactNode; tone: Tone; badge: string }> = []

  steps.push({
    title: "Client escrow",
    detail: <><Amount value={invoice.amount} /> locked by the client. Escrow can&apos;t fund an advance.</>,
    tone: status === "Created" ? (pendingOf("fundInvoice") ? "pending" : "todo") : "done",
    badge: status === "Created" ? (pendingOf("fundInvoice") ? "Pending" : "Not funded") : status === "Settled" ? "Released" : "Locked",
  })

  steps.push({
    title: "Advance from platform reserve",
    detail: hasAdvance ? (
      <><Amount value={invoice.advanceAmount} /> (90%) paid to the freelancer from the reserve.</>
    ) : status === "Settled" || status === "Disputed" ? (
      <>No advance was taken on this invoice.</>
    ) : (
      <><Amount value={advance} /> (90%) is paid from the reserve only after a passing AI evaluation and the freelancer&apos;s explicit request.</>
    ),
    tone: hasAdvance ? "done" : pendingOf("approveAdvance") ? "pending" : status === "Settled" || status === "Disputed" ? "skipped" : "todo",
    badge: hasAdvance ? "Paid" : pendingOf("approveAdvance") ? "Pending" : status === "Settled" || status === "Disputed" ? "Not taken" : "On request",
  })

  steps.push({
    title: "Client approval",
    detail: hasAdvance ? (
      <><Amount value={invoice.advanceAmount} /> of escrow is reallocated to replenish the reserve and the remaining <Amount value={remainder} /> goes to the freelancer.</>
    ) : (
      <>With no advance, escrow pays the full <Amount value={invoice.amount} /> to the freelancer.</>
    ),
    tone: status === "Settled" ? "done" : pendingOf("approveCompletion") ? "pending" : status === "Disputed" ? "bad" : "todo",
    badge: status === "Settled" ? "Settled" : pendingOf("approveCompletion") ? "Pending" : status === "Disputed" ? "Frozen" : "Awaiting client",
  })

  const TONE = { done: "success", pending: "warning", todo: "neutral", skipped: "neutral", bad: "danger" } as const
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment breakdown</CardTitle>
        <CardDescription>{tokenDisplay().simulated ? "Simulated demo tokens. " : ""}Steps show as done only after a confirmed transaction.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="space-y-3">
          {steps.map((st, i) => (
            <li key={st.title} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">{i + 1}</span>
              <div className="min-w-0 flex-1 space-y-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{st.title}</span>
                  <Pill tone={TONE[st.tone]}>{st.badge}</Pill>
                </div>
                <p className="text-muted-foreground">{st.detail}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
          {status === "Disputed" ? (
            <>
              A dispute freezes ordinary settlement and escrow stays locked.{" "}
              {hasAdvance ? "The advance already paid is never clawed back; the platform carries that risk. " : ""}
              {tokenDisplay().simulated
                ? "No automatic refund or arbitration exists in this demo."
                : "The platform operator resolves it on-chain: the freelancer is paid as normal, or the client is refunded the whole escrow."}
            </>
          ) : status === "Settled" ? (
            "This invoice is settled and final."
          ) : (
            "If the client disputes before approving, ordinary settlement freezes. An advance already paid is not automatically reversed."
          )}
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * Live mode, chain not read: escrow, advance and payout figures are unknown, so none is shown. The invoice's own terms
 * (amount, and the 90% advance it would allow) are facts from the frozen invoice record and are shown as such.
 */
function UnverifiedMoneyNotice({ title, invoice }: { title: string; invoice: InvoiceDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>The blockchain couldn&apos;t be read just now.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="rounded-lg bg-muted/60 p-3 text-muted-foreground">
          Escrow, advances and payouts are read from the contract, and that read failed or this record was never on-chain. No payment is
          shown because none can be verified. The status badge above comes from a saved record, not the chain.
        </p>
        <dl className="grid grid-cols-2 gap-3">
          <div>
            <dt className="text-xs text-muted-foreground">Invoice amount (agreed terms)</dt>
            <dd className="mt-0.5"><Amount value={invoice.amount} /></dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Advance this would allow (90%)</dt>
            <dd className="mt-0.5"><Amount value={advanceFor(invoice.amount)} /></dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  )
}

/** Escrow and reserve are separate balances; this makes the money flow explicit. */
export function FundsBreakdown({ invoice, reserveAvailable }: { invoice: InvoiceDetail; reserveAvailable: string }) {
  if (invoice.financialStatusVerified === false) return <UnverifiedMoneyNotice title="Where the money is" invoice={invoice} />
  const status = invoice.onchainStatus
  const advance = advanceFor(invoice.amount)
  const hasAdvance = !isZero(invoice.advanceAmount)
  const remainder = sub(invoice.amount, invoice.advanceAmount)

  let explanation: string
  switch (status) {
    case "Created":
      explanation = "Nothing is locked yet. Once funded, the full invoice amount sits in escrow."
      break
    case "Funded":
      explanation = `If the freelancer requests an advance, ${formatToken(advance)} is paid from the platform reserve — escrow isn't touched. On approval without an advance, escrow pays the full ${formatToken(invoice.amount)}.`
      break
    case "Advanced":
      explanation = `${formatToken(invoice.advanceAmount)} was paid from the reserve. On approval, escrow credits ${formatToken(invoice.advanceAmount)} back to the reserve and pays the remaining ${formatToken(remainder)} to the freelancer.`
      break
    case "Disputed":
      explanation = hasAdvance
        ? `Settlement is frozen. The ${formatToken(invoice.advanceAmount)} advance is not clawed back and escrow stays locked; the platform carries that risk until manual resolution.`
        : "Settlement is frozen and escrow stays locked until manual resolution. Nothing is refunded automatically."
      break
    case "Cancelled":
      explanation = "The client cancelled this invoice before funding it. Nothing was locked and nothing was paid."
      break
    case "Settled":
      explanation = hasAdvance
        ? `Escrow credited ${formatToken(invoice.reserveCredited)} to the reserve and paid ${formatToken(remainder)} to the freelancer.`
        : `Escrow paid the full ${formatToken(invoice.amount)} to the freelancer.`
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where the money is</CardTitle>
        <CardDescription>Escrow and the platform reserve are separate balances. {tokenDisplay().simulated ? "Simulated demo tokens." : tokenNotice()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
          <Bucket icon={Lock} label="Client escrow" value={invoice.escrowBalance} note="This invoice" />
          <Bucket icon={Landmark} label="Platform reserve" value={reserveAvailable} note="Shared, all invoices" />
          <Bucket icon={Banknote} label="Freelancer received" value={invoice.freelancerReceived} note="Advance + settlement" />
        </div>
        <p className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">{explanation}</p>
      </CardContent>
    </Card>
  )
}

function Bucket({ icon: Icon, label, value, note }: { icon: typeof Lock; label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" aria-hidden /> {label}
      </div>
      <div className="mt-1 text-lg">
        <Amount value={value} />
      </div>
      <div className="text-xs text-muted-foreground">{note}</div>
    </div>
  )
}

export function EvaluationPanel({
  evaluation,
  loading,
  nextStep,
}: {
  evaluation: EvaluationRecord | undefined
  loading?: boolean
  /** Contextual next step shown under the results (freelancer view). */
  nextStep?: React.ReactNode
}) {
  if (loading) return <Skeleton className="h-64 rounded-xl" />
  if (!evaluation) return null

  if (evaluation.state === "running") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 animate-pulse" aria-hidden /> Evaluating submission…
          </CardTitle>
          <CardDescription>Simulated AI evaluation in progress. This takes a few seconds.</CardDescription>
        </CardHeader>
        <CardContent aria-busy="true">
          <Skeleton className="h-24" />
        </CardContent>
      </Card>
    )
  }

  if (evaluation.state === "error") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Evaluation failed</CardTitle>
          <CardDescription>{evaluation.errorMessage ?? "The evaluation didn't complete."} It can be run again.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const passedCount = evaluation.criteriaResults.filter((r) => r.passed).length
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4" aria-hidden /> AI evaluation
          </CardTitle>
          {evaluation.simulated && <SimulatedTag>Simulated AI evaluation</SimulatedTag>}
        </div>
        <CardDescription>
          The AI only recommends whether the work satisfies the agreed criteria. It is not the final arbiter, never
          signs or moves money, and the client still approves.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center gap-4">
          <div
            className={cn(
              "flex size-24 shrink-0 flex-col items-center justify-center rounded-full ring-4 ring-inset",
              evaluation.passed ? "bg-success/10 ring-success/30" : "bg-destructive/10 ring-destructive/30"
            )}
            role="img"
            aria-label={`Score ${evaluation.score} out of 100`}
          >
            <span className="text-3xl font-semibold tabular-nums">{evaluation.score}</span>
            <span className="text-[10px] text-muted-foreground">/ 100</span>
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <Pill tone={evaluation.passed ? "success" : "danger"} icon={evaluation.passed ? CheckCircle2 : XCircle}>
              {evaluation.passed ? "Recommended: pass" : "Recommended: don't pass"}
            </Pill>
            <p className="text-sm">{evaluation.summary}</p>
            <p className="text-xs text-muted-foreground">
              {passedCount} of {evaluation.criteriaResults.length} criteria met
            </p>
            <p className="text-xs text-muted-foreground">
              Status: <span className="font-medium text-foreground">Evaluated</span> · {formatDate(evaluation.evaluatedAt, true)}
            </p>
          </div>
        </div>

        <Progress value={evaluation.score} aria-label="Evaluation score" />

        <ul className="space-y-2">
          {evaluation.criteriaResults.map((r, i) => (
            <li key={i} className="flex gap-3 rounded-lg border p-3 text-sm">
              {r.passed ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              ) : (
                <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.criterion}</span>
                  <Pill tone={r.passed ? "success" : "danger"}>{r.passed ? "Met" : "Not met"}</Pill>
                  {evaluation.mandatory[i] && <Pill tone="neutral">Mandatory</Pill>}
                </div>
                <p className="mt-1 text-muted-foreground">{r.reason}</p>
              </div>
            </li>
          ))}
        </ul>

        {nextStep}

        <dl className="grid gap-x-6 gap-y-1 border-t pt-3 text-xs text-muted-foreground sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="inline font-medium">Pass rule: </dt>
            <dd className="inline">{evaluation.passRule}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Evaluator: </dt>
            <dd className="inline">
              {evaluation.model} · prompt {evaluation.promptVersion}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium">Evaluated: </dt>
            <dd className="inline">{formatDate(evaluation.evaluatedAt, true)}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  )
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) return <p className="text-sm text-muted-foreground">No activity yet.</p>
  return (
    <ol className="relative space-y-5 border-l pl-6">
      {events.map((e) => {
        const onchain = e.layer === "onchain"
        const bad = e.kind === "disputed" || e.kind === "tx_failed" || e.kind === "advance_denied"
        return (
          <li key={e.id} className="relative">
            <span
              className={cn(
                "absolute top-1 -left-[31px] flex size-4 items-center justify-center rounded-full ring-4 ring-background",
                bad ? "bg-destructive" : onchain ? "bg-primary" : "bg-muted-foreground/50"
              )}
              aria-hidden
            >
              <Circle className="size-1.5 fill-background text-background" />
            </span>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-sm font-medium">{e.title}</p>
              <Pill tone={onchain ? "info" : "neutral"}>{onchain ? "Financial state" : "Off-chain"}</Pill>
              {e.simulated && <SimulatedTag />}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{e.description}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatDate(e.at, true)}
              {e.amount && (
                <>
                  {" · "}
                  <Amount value={e.amount} className="text-xs" />
                </>
              )}
            </p>
          </li>
        )
      })}
    </ol>
  )
}

export function TransactionList({
  transactions,
  showInvoice,
}: {
  transactions: TransactionRecord[]
  showInvoice?: boolean
}) {
  return (
    <ul className="divide-y rounded-xl border">
      {transactions.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {TX_LABEL[t.action]}
              {showInvoice && t.invoiceId && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">Invoice #{t.invoiceId}</span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatDate(t.createdAt, true)} ·{" "}
              {t.txHash && !t.simulated && tryExplorerTxUrl(t.txHash) ? (
                <a className="font-mono text-primary underline" href={tryExplorerTxUrl(t.txHash)!} target="_blank" rel="noreferrer" title={t.txHash}>
                  {shortHash(t.txHash)}
                </a>
              ) : (
                <span className="font-mono">{t.id}</span>
              )}
            </p>
            {t.status === "pending" && !t.simulated && <p className="mt-1 text-xs text-muted-foreground">Sent, not final yet. Nothing is paid or settled until it is confirmed.</p>}
            {t.error && <p className="mt-1 text-xs text-destructive">{t.error}</p>}
          </div>
          {t.amount && <Amount value={t.amount} />}
          {(t.simulated || !t.txHash) && <SimulatedTag>Simulated · no on-chain hash</SimulatedTag>}
          <TxStatusBadge status={t.status} />
        </li>
      ))}
    </ul>
  )
}

/** Live mode: marks a status that was not read from the chain, and dev fixtures that are not on any chain. */
export function LiveStatusPills({ invoice }: { invoice: InvoiceDetail }) {
  return (
    <>
      {invoice.isTestFixture && (
        <Pill tone="warning" title="A development test fixture. It does not exist on any blockchain.">
          Test fixture · no blockchain
        </Pill>
      )}
      {invoice.financialStatusVerified === false && (
        <Pill tone="neutral" title="This status is a saved record, not read from the blockchain.">
          Status not verified on-chain
        </Pill>
      )}
    </>
  )
}

export function InvoiceRow({ invoice, href, right }: { invoice: InvoiceDetail; href: string; right: React.ReactNode }) {
  const session = useSession()
  const role = session.data?.role
  const counterparty =
    role === "freelancer" ? `From ${invoice.clientName}` : role === "client" ? `To ${invoice.freelancerName}` : `${invoice.clientName} → ${invoice.freelancerName}`
  return (
    <li>
      <Link
        href={href}
        className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <p className="min-w-0 truncate font-medium">
              <span className="mr-1.5 text-xs font-normal text-muted-foreground">#{invoice.invoiceId}</span>
              {invoice.title}
            </p>
            <Amount value={invoice.amount} className="shrink-0 font-semibold" />
          </div>
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">
              {counterparty} · {formatDate(invoice.createdAt)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {right}
            <LiveStatusPills invoice={invoice} />
          </div>
        </div>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  )
}

/** Compact invoice summary used at the top of both detail pages. */
export function InvoiceHeaderCard({
  invoice,
  perspective,
  badges,
}: {
  invoice: InvoiceDetail
  perspective: "client" | "freelancer"
  badges?: React.ReactNode
}) {
  const other =
    perspective === "client"
      ? { label: "Freelancer", name: invoice.freelancerName, address: invoice.freelancer }
      : { label: "Client", name: invoice.clientName, address: invoice.client }
  const hasAdvance = !isZero(invoice.advanceAmount)
  return (
    <section aria-label="Invoice summary" className="overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10">
      <div className="h-1 bg-gradient-to-r from-navy via-[#0b3a8f] to-primary" aria-hidden />
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Invoice #{invoice.invoiceId}</span>
          <OnchainStatusBadge status={invoice.onchainStatus} />
          <LiveStatusPills invoice={invoice} />
          {badges}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">{invoice.title}</h1>
            {invoice.description && <p className="max-w-2xl text-sm text-muted-foreground">{invoice.description}</p>}
          </div>
          <div className="sm:text-right">
            <p className="text-xs text-muted-foreground">Total amount</p>
            <p className="text-3xl font-semibold tracking-tight tabular-nums">
              <Amount value={invoice.amount} className="font-semibold [&>span]:text-base" />
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-4 text-sm sm:grid-cols-4">
          <div className="col-span-2 min-w-0 sm:col-span-1">
            <dt className="text-xs text-muted-foreground">{other.label}</dt>
            <dd className="mt-0.5 min-w-0">
              <AddressChip address={other.address} label={other.name} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Created</dt>
            <dd className="mt-0.5">{formatDate(invoice.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Due</dt>
            <dd className="mt-0.5">{invoice.dueDate ? formatDate(invoice.dueDate) : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{hasAdvance ? "Advanced (90%)" : "Possible advance (90%)"}</dt>
            <dd className="mt-0.5">
              <Amount value={hasAdvance ? invoice.advanceAmount : advanceFor(invoice.amount)} />
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">{tokenNotice()}</p>
      </div>
    </section>
  )
}

export function ReserveNote() {
  return (
    <p className="flex items-start gap-2 text-xs text-muted-foreground">
      <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      Advances are paid only from the platform-funded reserve, never from client escrow.
    </p>
  )
}
