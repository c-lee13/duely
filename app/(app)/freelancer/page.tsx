"use client"

import Link from "next/link"
import { ArrowDownLeft, ArrowRight, Hourglass, Rocket, Upload } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { RoleGate } from "@/components/duely/role-gate"
import { InvoiceRow } from "@/components/duely/invoice-parts"
import {
  Amount,
  ButtonLink,
  EmptyState,
  ErrorState,
  OnchainStatusBadge,
  Pill,
  SimulatedTag,
  SubmissionStatusBadge,
  TxStatusBadge,
  formatDate,
} from "@/components/duely/primitives"
import { useInvoices, useRepoQuery, useRepository, useTransactions } from "@/hooks/use-duely"
import type { InvoiceDetail, OnchainInvoiceStatus, Session, TransactionRecord } from "@/lib/frontend/domain"
import { evaluationFor, freelancerNextStep, getAdvanceEligibility, type FreelancerNextStep } from "@/lib/frontend/eligibility"
import { advanceFor, isZero, sub, sum, tokenNotice } from "@/lib/frontend/token"
import { fundingCopy } from "@/lib/frontend/protocol-copy"
import { ClaimCard } from "@/components/duely/claim-card"
import { settlementProjection } from "@/lib/frontend/eligibility"

const NEXT: Record<FreelancerNextStep, { label: string; tone: "neutral" | "info" | "advance" | "success" | "warning" | "danger" }> = {
  await_funding: { label: "Waiting for client to fund", tone: "neutral" },
  submit_evidence: { label: "Submit evidence", tone: "info" },
  await_evaluation: { label: "Evaluation pending", tone: "warning" },
  resubmit: { label: "Resubmit evidence", tone: "danger" },
  request_advance: { label: "Advance available", tone: "advance" },
  await_client: { label: "Awaiting client approval", tone: "info" },
  disputed: { label: "Disputed", tone: "danger" },
  paid: { label: "Paid", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
}

const STATUS_ORDER: OnchainInvoiceStatus[] = ["Created", "Funded", "Advanced", "Disputed", "Settled", "Cancelled"]
const STATUS_HINT: Record<OnchainInvoiceStatus, string> = {
  Created: "Not funded yet",
  Funded: "Work in progress",
  Advanced: "Awaiting approval",
  Disputed: "Frozen",
  Settled: "Paid out",
  Cancelled: "Cancelled by client",
}

/** Latest-evaluation pass + full advance eligibility, read from existing invoice bundles. */
function useAdvanceOffers(list: InvoiceDetail[], sessionKey: string) {
  const candidates = list.filter((i) => i.onchainStatus === "Funded" && i.submissionStatus === "Evaluated")
  const key = `offers:${sessionKey}:${candidates.map((i) => `${i.invoiceId}-${i.onchainStatus}-${i.submissionStatus}`).join(",")}`
  return useRepoQuery(key, async (repo) => {
    const eligible = new Set<string>()
    const failed = new Set<string>()
    await Promise.all(
      candidates.map(async (c) => {
        const b = await repo.getInvoice(c.invoiceId)
        const ev = evaluationFor(b.submissions[0], b.evaluations)
        if (ev?.state === "completed" && !ev.passed) failed.add(c.invoiceId)
        if (getAdvanceEligibility(b).eligible) eligible.add(c.invoiceId)
      })
    )
    return { eligible, failed }
  })
}

function PaymentRow({ tx, invoice, simulated }: { tx: TransactionRecord; invoice?: InvoiceDetail; simulated: boolean }) {
  const isAdvance = tx.action === "approveAdvance"
  // Settlement payout to the freelancer is the escrow remainder after the advance.
  const amount = isAdvance ? tx.amount : invoice ? settlementProjection(invoice).toFreelancer : undefined
  const confirmed = tx.status === "confirmed"
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-primary">
        {isAdvance ? <Rocket className="size-4" aria-hidden /> : <ArrowDownLeft className="size-4" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {isAdvance ? `90% advance from ${fundingCopy().short}` : "Settlement payout"}
          {tx.invoiceId && <span className="font-normal text-muted-foreground"> · #{tx.invoiceId}</span>}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatDate(tx.createdAt, true)}
          {(simulated || tx.simulated) && " · simulated"}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {amount && (
          <span className={tx.status === "failed" ? "text-sm text-muted-foreground line-through" : confirmed ? "text-sm font-semibold" : "text-sm text-muted-foreground"}>
            {confirmed && "+"}
            <Amount value={amount} hideSymbol />
          </span>
        )}
        <TxStatusBadge status={tx.status} />
      </div>
    </li>
  )
}

function ActionCard({ invoice, offer }: { invoice: InvoiceDetail; offer: "eligible" | "failed" | "none" }) {
  const step = freelancerNextStep(invoice, offer === "eligible" ? true : offer === "failed" ? false : undefined)
  const meta = NEXT[step]
  const href = `/freelancer/invoices/${invoice.invoiceId}`
  const cta =
    step === "request_advance" ? (
      <ButtonLink href={href} size="sm">
        <Rocket /> Request advance · <Amount value={advanceFor(invoice.amount)} hideSymbol className="text-inherit" />
      </ButtonLink>
    ) : step === "submit_evidence" || step === "resubmit" ? (
      <ButtonLink href={href} size="sm">
        <Upload /> {step === "resubmit" ? "Resubmit evidence" : "Submit evidence"}
      </ButtonLink>
    ) : (
      <ButtonLink href={href} size="sm" variant="outline">
        View <ArrowRight />
      </ButtonLink>
    )
  return (
    <li className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">#{invoice.invoiceId} · {invoice.clientName}</p>
          <p className="truncate font-medium">{invoice.title}</p>
        </div>
        <Amount value={invoice.amount} className="shrink-0 text-base font-semibold" />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Pill tone={meta.tone}>{meta.label}</Pill>
        {cta}
      </div>
    </li>
  )
}

function Dashboard({ session }: { session: Session }) {
  const invoices = useInvoices("freelancer", session.wallet)
  const txs = useTransactions(`${session.role}`)
  const repo = useRepository()
  const simulated = repo.mode === "mock"
  const list = invoices.data ?? []
  const offers = useAdvanceOffers(list, session.wallet)

  // Confirmed ledger values only: advanceAmount / freelancerReceived are written on confirmed transactions.
  const invoiced = sum(list.map((i) => i.amount))
  const received = sum(list.map((i) => i.freelancerReceived))
  // Live mode, chain not read: received/advance/pending figures are unknown, so none is shown.
  const unverified = list.some((i) => i.financialStatusVerified === false)
  const NotConnected = <span className="text-base">Unavailable</span>
  const advances = sum(list.map((i) => i.advanceAmount))
  const settlements = sub(received, advances)
  const open = list.filter((i) => i.onchainStatus === "Funded" || i.onchainStatus === "Advanced")
  const pending = sum(open.map((i) => settlementProjection(i).toFreelancer))
  const frozen = sum(list.filter((i) => i.onchainStatus === "Disputed").map((i) => settlementProjection(i).toFreelancer))
  const count = (st: OnchainInvoiceStatus) => list.filter((i) => i.onchainStatus === st).length

  const byId = new Map(list.map((i) => [i.invoiceId, i]))
  const recent = (txs.data ?? [])
    .filter((t) => t.action === "approveAdvance" || t.action === "approveCompletion")
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
    .slice(0, 5)

  const offerFor = (i: InvoiceDetail) =>
    offers.data?.eligible.has(i.invoiceId) ? "eligible" : offers.data?.failed.has(i.invoiceId) ? "failed" : "none"
  const needsAction = list.filter((i) => {
    const step = freelancerNextStep(i, offerFor(i) === "eligible" ? true : offerFor(i) === "failed" ? false : undefined)
    return step === "submit_evidence" || step === "resubmit" || step === "request_advance"
  })

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="min-w-0">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Freelancer</p>
        <h1 className="truncate text-2xl font-semibold tracking-tight">Hi, {session.displayName}</h1>
      </div>

      <ClaimCard sessionKey={`${session.role}:${session.wallet}`} />

      {invoices.error ? (
        <ErrorState message={invoices.error} onRetry={invoices.reload} />
      ) : (
        <>
          {invoices.loading ? (
            <Skeleton className="h-64 rounded-2xl" />
          ) : (
            <section
              aria-label="Earnings summary"
              className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-[#0b3a8f] to-primary p-5 text-navy-foreground shadow-lg sm:p-6"
            >
              <div className="pointer-events-none absolute -top-16 -right-16 size-56 rounded-full bg-cyan-300/10 blur-2xl" aria-hidden />
              <div className="relative">
                <p className="flex items-center gap-1.5 text-sm text-navy-foreground/75">
                  <ArrowDownLeft className="size-3.5" aria-hidden /> Received so far (confirmed)
                  {simulated && <SimulatedTag className="ml-1" />}
                </p>
                <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
                  {unverified ? <span className="text-3xl">Unavailable</span> : <Amount value={received} className="font-semibold [&>span]:text-base [&>span]:text-navy-foreground/70" />}
                </p>
                <p className="mt-1 max-w-md text-xs text-navy-foreground/70">
                  {fundingCopy().pull
                    ? "Advances come from the liquidity vault; the rest is credited to you from escrow after the client approves, and you claim it below."
                    : "Advances come from the separate platform reserve; the rest is paid from escrow after the client approves."}{" "}
                  {tokenNotice()}
                </p>
              </div>
              <dl className="relative mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-white/10 p-3 ring-1 ring-white/15">
                  <dt className="text-xs text-navy-foreground/70">Advances received</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{unverified ? NotConnected : <Amount value={advances} hideSymbol />}</dd>
                  <p className="text-[11px] text-navy-foreground/60">Confirmed · from {fundingCopy().short}</p>
                </div>
                <div className="rounded-xl bg-white/10 p-3 ring-1 ring-white/15">
                  <dt className="text-xs text-navy-foreground/70">Pending earnings</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{unverified ? NotConnected : <Amount value={pending} hideSymbol />}</dd>
                  <p className="text-[11px] text-navy-foreground/60">
                    Awaiting client approval
                    {!isZero(frozen) && <> · {" "}<Amount value={frozen} hideSymbol className="text-inherit font-normal" /> frozen</>}
                  </p>
                </div>
                <div className="rounded-xl bg-white/10 p-3 ring-1 ring-white/15">
                  <dt className="text-xs text-navy-foreground/70">Total invoiced</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums"><Amount value={invoiced} hideSymbol /></dd>
                  <p className="text-[11px] text-navy-foreground/60">
                    {list.length} invoice{list.length === 1 ? "" : "s"} · {open.length} active
                  </p>
                </div>
              </dl>
              {!isZero(settlements) && (
                <p className="relative mt-3 text-[11px] text-navy-foreground/60">
                  Includes <Amount value={settlements} hideSymbol className="text-inherit font-normal" /> from settled escrow.
                </p>
              )}
            </section>
          )}

          {!invoices.loading && needsAction.length > 0 && (
            <section aria-label="Needs your action" className="space-y-2">
              <h2 className="text-sm font-semibold">Needs your action</h2>
              <ul className="grid gap-3 md:grid-cols-2">
                {needsAction.map((i) => (
                  <ActionCard key={i.invoiceId} invoice={i} offer={offerFor(i)} />
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                An advance (90% of the invoice, from {fundingCopy().source}) needs a passing AI evaluation and your
                explicit request. It shows as paid only after it is confirmed.
              </p>
            </section>
          )}

          <section aria-label="Invoice status summary">
            <h2 className="mb-2 text-sm font-semibold">Invoice status</h2>
            <ul className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-5 sm:overflow-visible sm:px-0">
              {STATUS_ORDER.map((st) => (
                <li key={st} className="min-w-28 flex-1 snap-start">
                  <Link
                    href="#invoices"
                    className="block rounded-xl bg-card p-3 ring-1 ring-foreground/10 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <span className="text-2xl font-semibold tabular-nums">{invoices.loading ? "–" : count(st)}</span>
                    <span className="mt-1 block">
                      <OnchainStatusBadge status={st} />
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">{STATUS_HINT[st]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Recent payment activity</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {txs.loading ? (
                <div className="space-y-3 px-4">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-12" />
                  ))}
                </div>
              ) : recent.length === 0 ? (
                <p className="flex items-center gap-2 px-4 text-sm text-muted-foreground">
                  <Hourglass className="size-4 shrink-0" aria-hidden /> No payments yet. Advances and settlement payouts appear here.
                </p>
              ) : (
                <ul className="divide-y border-t">
                  {recent.map((tx) => (
                    <PaymentRow key={tx.id} tx={tx} invoice={tx.invoiceId ? byId.get(tx.invoiceId) : undefined} simulated={simulated} />
                  ))}
                </ul>
              )}
              <div className="border-t px-4 pt-3 text-sm">
                <Link href="/activity" className="font-medium text-primary hover:underline">
                  View all activity
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card id="invoices" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>Assigned invoices</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {invoices.loading ? (
                <div className="space-y-3 px-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-14" />
                  ))}
                </div>
              ) : list.length === 0 ? (
                <div className="px-4">
                  <EmptyState title="No assigned work yet" description="Invoices created for your wallet appear here." />
                </div>
              ) : (
                <ul className="divide-y border-t">
                  {list.map((i) => (
                    <InvoiceRow key={i.invoiceId} invoice={i} href={`/freelancer/invoices/${i.invoiceId}`} right={<Right invoice={i} />} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function Right({ invoice }: { invoice: InvoiceDetail }) {
  const step = NEXT[freelancerNextStep(invoice, undefined)]
  return (
    <>
      {invoice.onchainStatus === "Funded" && <SubmissionStatusBadge status={invoice.submissionStatus} />}
      <OnchainStatusBadge status={invoice.onchainStatus} />
      <Pill tone={step.tone} className="hidden lg:inline-flex">
        {step.label}
      </Pill>
    </>
  )
}

export default function FreelancerDashboardPage() {
  return <RoleGate role="freelancer">{(session) => <Dashboard session={session} />}</RoleGate>
}
