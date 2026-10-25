"use client"

import * as React from "react"
import Link from "next/link"
import { AlertOctagon, Gauge, Landmark, Lock, Rocket, Vault } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { RoleGate } from "@/components/duely/role-gate"
import { useToast } from "@/components/duely/toast"
import { ReserveNote } from "@/components/duely/invoice-parts"
import { TxProgressPanel, useTxProgress } from "@/components/duely/tx-progress"
import { Amount, EmptyState, ErrorState, MetricCard, OnchainStatusBadge, PageHeader, SimulatedTag } from "@/components/duely/primitives"
import { useAction, useBalances, useInvoices, useRepository } from "@/hooks/use-duely"
import type { InvoiceDetail, Session } from "@/lib/frontend/domain"
import { formatToken, parseTokenInput, tokenDisplay } from "@/lib/frontend/token"

function Reserve({ session }: { session: Session }) {
  const toast = useToast()
  const repo = useRepository()
  const live = repo.mode === "api"
  const isVault = repo.vault !== undefined // v2: advances are funded by the LP vault; there is no operator reserve to top up
  const token = tokenDisplay()
  const balances = useBalances(session.role)
  const invoices = useInvoices("platform", session.wallet)
  const progress = useTxProgress()
  const [amountText, setAmountText] = React.useState(live ? "5" : "1000")
  const [inputError, setInputError] = React.useState<string | null>(null)
  const [resolving, setResolving] = React.useState<null | { invoice: InvoiceDetail; release: boolean }>(null)
  const deposit = useAction((repo, amount: string) => repo.depositReserve(amount, progress.onProgress))
  const resolve = useAction((repo, invoiceId: string, release: boolean) => repo.resolveDispute(invoiceId, release, progress.onProgress))

  async function onDeposit(e: React.FormEvent) {
    e.preventDefault()
    const amount = parseTokenInput(amountText)
    if (!amount || BigInt(amount) <= BigInt(0)) return setInputError("Enter an amount greater than zero.")
    setInputError(null)
    progress.reset()
    const r = await deposit.run(amount)
    if (r.ok) toast({ tone: "success", title: live ? "Reserve topped up" : "Reserve topped up (simulated)", description: `${formatToken(amount)} added.` })
    else toast({ tone: "error", title: "Deposit not completed", description: r.error })
    balances.reload()
    invoices.reload()
  }

  async function onResolve() {
    if (!resolving) return
    const { invoice, release } = resolving
    progress.reset()
    const r = await resolve.run(invoice.invoiceId, release)
    setResolving(null)
    if (r.ok)
      toast({
        tone: "success",
        title: release ? "Dispute resolved: freelancer paid" : "Dispute resolved: client refunded",
        description: release ? "Settled as normal: the advance was repaid from escrow." : `${formatToken(invoice.amount)} returned to the client. The advance was not clawed back.`,
      })
    else toast({ tone: "error", title: "Resolution not completed", description: r.error })
    balances.reload()
    invoices.reload()
  }

  const b = balances.data
  const carrying = (invoices.data ?? []).filter((i) => i.onchainStatus === "Advanced" || i.onchainStatus === "Disputed")
  const busy = deposit.pending || resolve.pending

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Platform"
        title={isVault ? "Liquidity vault" : "Reserve"}
        description={
          isVault
            ? "Advances are funded by the liquidity vault (supplied by depositors, not the platform) and are separate from client escrow. The operator resolves disputes here."
            : "The reserve is funded by the platform and pays 90% advances. It is separate from client escrow."
        }
      />
      {balances.error ? (
        <ErrorState message={balances.error} onRetry={balances.reload} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {!b ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
          ) : (
            <>
              <MetricCard
                label={isVault ? "Vault can advance now" : "Reserve available"}
                value={<Amount value={b.reserveAvailable} />}
                hint={isVault ? "Largest advance the vault could fund this block (cash, 80% utilization and 25% per-invoice limits applied)" : "Can fund new advances"}
                icon={Landmark}
                tone="info"
              />
              <MetricCard label="Client escrow locked" value={<Amount value={b.escrowLocked} />} hint="Can't fund advances" icon={Lock} tone="neutral" />
              <MetricCard label="Advances outstanding" value={<Amount value={b.advancesOutstanding} />} hint={isVault ? "Repaid with the fee from escrow on approval" : "Repaid from escrow on approval"} icon={Rocket} tone="advance" />
              <MetricCard
                label="At risk (disputed)"
                value={<Amount value={b.advancesAtRisk} />}
                hint={live ? (isVault ? "Becomes a vault loss if the operator refunds the client" : "Lost if the operator refunds the client") : "Not clawed back; manual resolution"}
                icon={AlertOctagon}
                tone={b.advancesAtRisk === "0" ? "neutral" : "danger"}
              />
            </>
          )}
        </div>
      )}

      {isVault && b?.vault && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Vault className="size-4" aria-hidden /> Vault position
            </CardTitle>
            <CardDescription>
              Read at block {b.vault.blockNumber}. Depositors add liquidity on the Vault page; the platform does not top it up.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">NAV</dt>
                <dd className="text-lg"><Amount value={b.vault.totalAssets} /></dd>
              </div>
              <div>
                <dt className="flex items-center gap-1 text-xs text-muted-foreground"><Gauge className="size-3" aria-hidden /> Utilization</dt>
                <dd className="text-lg">{(b.vault.utilizationBps / 100).toFixed(2)}%</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Realized losses</dt>
                <dd className="text-lg"><Amount value={b.vault.totalRealizedLosses} /></dd>
              </div>
            </dl>
            {(b.vault.paused || b.vault.advancesPaused) && (
              <p role="alert" className="text-sm text-destructive">
                {b.vault.paused ? "The vault is paused: deposits, withdrawals and advances are stopped." : "New advances are paused."}
              </p>
            )}
            <Link href="/vault" className="text-sm font-medium text-primary underline-offset-2 hover:underline">Open the Vault page</Link>
          </CardContent>
        </Card>
      )}

      {!isVault && (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Top up reserve {!live && <SimulatedTag />}
          </CardTitle>
          <CardDescription>
            Moves {token.symbol} from the operator wallet{b ? <> (<Amount value={b.walletBalance} />)</> : null} into the reserve.
            {live && " Needs the operator account selected in MetaMask; the contract rejects anyone else."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onDeposit} className="flex max-w-md flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="deposit">Amount ({token.symbol})</Label>
              <Input id="deposit" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-invalid={!!inputError || !!deposit.error} aria-describedby="deposit-err" />
            </div>
            <Button type="submit" disabled={busy}>
              {deposit.pending ? (live ? "Waiting for confirmation…" : "Confirming…") : "Deposit"}
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
      )}

      {live && <TxProgressPanel steps={progress.steps} title="Wallet steps" />}

      <Card id="invoices" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Invoices carrying an advance or in dispute</CardTitle>
          <CardDescription>{live ? "Statuses are read from the chain. You are not a party to these invoices." : "Simulated invoices."}</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {invoices.error ? (
            <div className="px-4">
              <ErrorState message={invoices.error} onRetry={invoices.reload} />
            </div>
          ) : carrying.length === 0 ? (
            <div className="px-4">
              <EmptyState title="No advances outstanding" />
            </div>
          ) : (
            <ul className="divide-y border-t">
              {carrying.map((i) => (
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
                  {live && i.onchainStatus === "Disputed" && (
                    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => setResolving({ invoice: i, release: true })}>
                        Pay the freelancer
                      </Button>
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => setResolving({ invoice: i, release: false })}>
                        Refund the client
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={resolving !== null} onOpenChange={(o) => !o && !resolve.pending && setResolving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{resolving?.release ? "Pay the freelancer?" : "Refund the client?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {resolving?.release
                ? isVault
                  ? "The invoice settles as normal: the vault is repaid the advance plus its fee from escrow and the freelancer is credited the remainder to claim."
                  : "The invoice settles as normal: the advance is repaid into the reserve from escrow and the freelancer receives the remainder."
                : `The client receives the whole ${resolving ? formatToken(resolving.invoice.amount) : ""} escrow back and the invoice is cancelled. ${isVault ? "The whole escrow is credited to the client to claim. " : ""}The ${resolving ? formatToken(resolving.invoice.advanceAmount) : ""} advance already paid to the freelancer is NOT clawed back: ${isVault ? "the vault (its depositors) absorbs that loss and earns no fee" : "the reserve absorbs that loss"}. This can't be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resolve.pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onResolve} disabled={resolve.pending}>
              {resolve.pending ? "Waiting for confirmation…" : "Confirm in MetaMask"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default function PlatformPage() {
  return <RoleGate role="platform">{(session) => <Reserve session={session} />}</RoleGate>
}
