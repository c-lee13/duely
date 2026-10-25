"use client"

import Link from "next/link"
import { ArrowDownRight, ArrowUpRight, Clock, FilePlus2, Lock } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { RoleGate } from "@/components/duely/role-gate"
import { InvoiceRow } from "@/components/duely/invoice-parts"
import {
  ButtonLink,
  EmptyState,
  ErrorState,
  OnchainStatusBadge,
  SimulatedTag,
  SubmissionStatusBadge,
  TxStatusBadge,
  formatDate,
} from "@/components/duely/primitives"
import { Amount } from "@/components/duely/primitives"
import { useInvoices, useRepository, useTransactions } from "@/hooks/use-duely"
import type { OnchainInvoiceStatus, Session, TransactionRecord } from "@/lib/frontend/domain"
import { sum, tokenNotice } from "@/lib/frontend/token"

const TX_LABEL: Record<TransactionRecord["action"], string> = {
  approve: "Allowance approved",
  createInvoice: "Invoice created",
  fundInvoice: "Escrow funded",
  depositReserve: "Reserve deposit",
  approveAdvance: "Advance released",
  approveCompletion: "Work approved",
  raiseDispute: "Dispute raised",
  cancelInvoice: "Invoice cancelled",
  withdrawReserve: "Reserve withdrawal",
  resolveDispute: "Dispute resolved",
}

const STATUS_ORDER: OnchainInvoiceStatus[] = ["Created", "Funded", "Advanced", "Disputed", "Settled", "Cancelled"]
const STATUS_HINT: Record<OnchainInvoiceStatus, string> = {
  Created: "Awaiting funding",
  Funded: "In escrow",
  Advanced: "90% advanced",
  Disputed: "Frozen",
  Settled: "Complete",
  Cancelled: "Cancelled before funding",
}

function ActivityRow({ tx, simulated }: { tx: TransactionRecord; simulated: boolean }) {
  // Only a confirmed escrow funding moves the client's own tokens; other rows are state changes.
  const outflow = tx.action === "fundInvoice" && tx.status === "confirmed"
  const Icon = outflow ? ArrowUpRight : tx.action === "approveAdvance" ? ArrowDownRight : Clock
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-primary">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {TX_LABEL[tx.action]}
          {tx.invoiceId && <span className="font-normal text-muted-foreground"> · #{tx.invoiceId}</span>}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatDate(tx.createdAt, true)}
          {(simulated || tx.simulated) && " · simulated"}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {tx.amount && (
          <span className={tx.status === "failed" ? "text-sm text-muted-foreground line-through" : "text-sm font-semibold"}>
            {outflow && "−"}
            <Amount value={tx.amount} hideSymbol />
          </span>
        )}
        <TxStatusBadge status={tx.status} />
      </div>
    </li>
  )
}

function Dashboard({ session }: { session: Session }) {
  const invoices = useInvoices("client", session.wallet)
  const txs = useTransactions(`${session.role}`)
  const repo = useRepository()
  const simulated = repo.mode === "mock"
  const list = invoices.data ?? []
  const count = (st: OnchainInvoiceStatus) => list.filter((i) => i.onchainStatus === st).length
  const locked = sum(list.map((i) => i.escrowBalance))
  // Live mode, chain not read: escrow figures are unknown, so none is shown (never a 0 that reads as fact).
  const unverified = list.some((i) => i.financialStatusVerified === false)
  const active = list.filter((i) => i.onchainStatus !== "Settled")
  // Evidence is in and the invoice is still open for approve/dispute.
  const pending = list.filter(
    (i) => (i.onchainStatus === "Funded" || i.onchainStatus === "Advanced") && i.submissionStatus !== "NotSubmitted"
  )
  const recent = (txs.data ?? [])
    .slice()
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
    .slice(0, 5)

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Client</p>
          <h1 className="truncate text-2xl font-semibold tracking-tight">Hi, {session.displayName}</h1>
        </div>
        <ButtonLink href="/client/invoices/new" size="lg" className="hidden md:inline-flex">
          <FilePlus2 /> New invoice
        </ButtonLink>
      </div>

      {invoices.error ? (
        <ErrorState message={invoices.error} onRetry={invoices.reload} />
      ) : (
        <>
          {invoices.loading ? (
            <Skeleton className="h-52 rounded-2xl" />
          ) : (
            <section
              aria-label="Financial summary"
              className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-[#0b3a8f] to-primary p-5 text-navy-foreground shadow-lg sm:p-6"
            >
              <div className="pointer-events-none absolute -top-16 -right-16 size-56 rounded-full bg-cyan-300/10 blur-2xl" aria-hidden />
              <div className="relative flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
                <div>
                  <p className="flex items-center gap-1.5 text-sm text-navy-foreground/75">
                    <Lock className="size-3.5" aria-hidden /> Locked in escrow
                    {simulated && <SimulatedTag className="ml-1" />}
                  </p>
                  <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
                    {unverified ? (
                      <span className="text-3xl">Unavailable</span>
                    ) : (
                      <Amount value={locked} className="font-semibold [&>span]:text-base [&>span]:text-navy-foreground/70" />
                    )}
                  </p>
                  <p className="mt-1 max-w-sm text-xs text-navy-foreground/70">
                    {unverified
                      ? "Escrow is read from the blockchain and that read isn't available right now, so no escrow balance is shown."
                      : "Held by the contract for open invoices. Not available to spend until you approve or the invoice settles."}{" "}
                    {tokenNotice()}
                  </p>
                </div>
                <ButtonLink
                  href="/client/invoices/new"
                  size="lg"
                  className="w-full bg-white text-navy hover:bg-white/90 md:hidden"
                >
                  <FilePlus2 /> Create invoice
                </ButtonLink>
              </div>
              <dl className="relative mt-5 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-white/10 p-3 ring-1 ring-white/15">
                  <dt className="text-xs text-navy-foreground/70">Active invoices</dt>
                  <dd className="mt-0.5 text-2xl font-semibold tabular-nums">{active.length}</dd>
                </div>
                <div className="rounded-xl bg-white/10 p-3 ring-1 ring-white/15">
                  <dt className="text-xs text-navy-foreground/70">Pending approvals</dt>
                  <dd className="mt-0.5 text-2xl font-semibold tabular-nums">{pending.length}</dd>
                </div>
              </dl>
            </section>
          )}

          <section aria-label="Invoice status summary">
            <h2 className="mb-2 text-sm font-semibold">Invoice status</h2>
            {unverified && <p className="mb-2 text-xs text-muted-foreground">Counts use saved invoice records, not on-chain state.</p>}
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
              <CardTitle>Recent activity</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {txs.loading ? (
                <div className="space-y-3 px-4">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-12" />
                  ))}
                </div>
              ) : recent.length === 0 ? (
                <p className="px-4 text-sm text-muted-foreground">
                  No transactions yet. Funding an invoice will appear here
                  {simulated ? " as a simulated transaction" : ""}.
                </p>
              ) : (
                <ul className="divide-y border-t">
                  {recent.map((tx) => (
                    <ActivityRow key={tx.id} tx={tx} simulated={simulated} />
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
              <CardTitle>All invoices</CardTitle>
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
                  <EmptyState
                    title="No invoices yet"
                    description="Create your first invoice to lock payment and set acceptance criteria."
                    action={
                      <ButtonLink href="/client/invoices/new">
                        <FilePlus2 /> Create invoice
                      </ButtonLink>
                    }
                  />
                </div>
              ) : (
                <ul className="divide-y border-t">
                  {list.map((i) => (
                    <InvoiceRow
                      key={i.invoiceId}
                      invoice={i}
                      href={`/client/invoices/${i.invoiceId}`}
                      right={
                        <>
                          {i.onchainStatus !== "Created" && i.onchainStatus !== "Settled" && (
                            <SubmissionStatusBadge status={i.submissionStatus} />
                          )}
                          <OnchainStatusBadge status={i.onchainStatus} />
                        </>
                      }
                    />
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

export default function ClientDashboardPage() {
  return <RoleGate role="client">{(session) => <Dashboard session={session} />}</RoleGate>
}
