"use client"

import * as React from "react"
import { AlertOctagon, Landmark, Lock, Rocket } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { RoleGate } from "@/components/duely/role-gate"
import { useToast } from "@/components/duely/toast"
import { ReserveNote } from "@/components/duely/invoice-parts"
import { Amount, EmptyState, ErrorState, MetricCard, OnchainStatusBadge, PageHeader, SimulatedTag } from "@/components/duely/primitives"
import { useAction, useBalances, useInvoices } from "@/hooks/use-duely"
import type { Session } from "@/lib/frontend/domain"
import { formatToken, parseTokenInput } from "@/lib/frontend/token"

function Reserve({ session }: { session: Session }) {
  const toast = useToast()
  const balances = useBalances(session.role)
  const invoices = useInvoices("platform", session.wallet)
  const [amountText, setAmountText] = React.useState("1000")
  const [inputError, setInputError] = React.useState<string | null>(null)
  const deposit = useAction((repo, amount: string) => repo.depositReserve(amount))

  async function onDeposit(e: React.FormEvent) {
    e.preventDefault()
    const amount = parseTokenInput(amountText)
    if (!amount || BigInt(amount) <= BigInt(0)) return setInputError("Enter an amount greater than zero.")
    setInputError(null)
    const r = await deposit.run(amount)
    if (r.ok) toast({ tone: "success", title: "Reserve topped up (simulated)", description: `${formatToken(amount)} added.` })
  }

  const b = balances.data
  const live = (invoices.data ?? []).filter((i) => i.onchainStatus === "Advanced" || i.onchainStatus === "Disputed")

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Platform" title="Reserve" description="The reserve is funded by the platform and pays 90% advances. It is separate from client escrow." />
      {balances.error ? (
        <ErrorState message={balances.error} onRetry={balances.reload} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {!b ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
          ) : (
            <>
              <MetricCard label="Reserve available" value={<Amount value={b.reserveAvailable} />} hint="Can fund new advances" icon={Landmark} tone="info" />
              <MetricCard label="Client escrow locked" value={<Amount value={b.escrowLocked} />} hint="Can't fund advances" icon={Lock} tone="neutral" />
              <MetricCard label="Advances outstanding" value={<Amount value={b.advancesOutstanding} />} hint="Repaid from escrow on approval" icon={Rocket} tone="advance" />
              <MetricCard label="At risk (disputed)" value={<Amount value={b.advancesAtRisk} />} hint="Not clawed back; manual resolution" icon={AlertOctagon} tone={b.advancesAtRisk === "0" ? "neutral" : "danger"} />
            </>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Top up reserve <SimulatedTag />
          </CardTitle>
          <CardDescription>
            Moves DEMO tokens from the platform wallet{b ? <> (<Amount value={b.walletBalance} />)</> : null} into the reserve.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onDeposit} className="flex max-w-md flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="deposit">Amount (DEMO)</Label>
              <Input id="deposit" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-invalid={!!inputError || !!deposit.error} aria-describedby="deposit-err" />
            </div>
            <Button type="submit" disabled={deposit.pending}>
              {deposit.pending ? "Confirming…" : "Deposit"}
            </Button>
          </form>
          <p id="deposit-err" role="alert" className="mt-2 text-sm text-destructive">
            {inputError ?? deposit.error}
          </p>
          <div className="mt-3">
            <ReserveNote />
          </div>
        </CardContent>
      </Card>

      <Card id="invoices" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Invoices carrying an advance</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {live.length === 0 ? (
            <div className="px-4">
              <EmptyState title="No advances outstanding" />
            </div>
          ) : (
            <ul className="divide-y border-t">
              {live.map((i) => (
                <li key={i.invoiceId} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      <span className="mr-2 text-xs text-muted-foreground">#{i.invoiceId}</span>
                      {i.title}
                    </p>
                    <p className="text-xs text-muted-foreground">{i.clientName} → {i.freelancerName}</p>
                  </div>
                  <Amount value={i.advanceAmount} />
                  <OnchainStatusBadge status={i.onchainStatus} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default function PlatformPage() {
  return <RoleGate role="platform">{(session) => <Reserve session={session} />}</RoleGate>
}
