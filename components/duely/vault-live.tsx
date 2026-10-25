"use client"

import * as React from "react"
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Coins, Gauge, Layers, PiggyBank, Rocket, TrendingDown, Vault, Wallet } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { LiveAuthGate } from "@/components/duely/live-auth"
import { Amount, ErrorState, MetricCard, PageHeader } from "@/components/duely/primitives"
import { useToast } from "@/components/duely/toast"
import { TxProgressPanel, useTxProgress } from "@/components/duely/tx-progress"
import { WalletStatusBar } from "@/components/duely/wallet-status"
import { useAction, useRepoQuery, useRepository } from "@/hooks/use-duely"
import type { VaultOverview } from "@/lib/frontend/domain"
import { formatToken, parseTokenInput, tokenDisplay, tokens } from "@/lib/frontend/token"

/**
 * The live DuelyVault page (v2 deployment, API mode). Every figure is read from the chain at one block; nothing is
 * invented, and a failed read is shown as an error rather than as zeros. Wallet transactions go through the repository,
 * which only reports success after a verified receipt. Authorization is on-chain: the page grants nothing.
 */

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`

const RISKS = (symbol: string) =>
  [
    "Your principal and any returns are not guaranteed. You can lose some or all of what you deposit.",
    "If a dispute is decided for the client, the advance is not recovered: the vault records a loss and the share price falls for everyone holding shares. No fee is earned on that advance.",
    "Withdrawals depend on available liquidity. While advances are outstanding you may only be able to withdraw part of your balance, or have to wait until invoices settle.",
    `${symbol} is controlled by its issuer, who can pause transfers or claw back tokens.`,
    "These are unaudited XRPL EVM testnet contracts holding test funds.",
  ] as const

export function VaultLive() {
  const repo = useRepository()
  const token = tokenDisplay()
  const overview = useRepoQuery("vault-overview", (r) => r.vault!.getOverview())
  const v = overview.data

  return (
    <div className="space-y-8">
      <WalletStatusBar />
      <PageHeader
        eyebrow="Vault / Earn"
        title="Liquidity Vault"
        description={`Supply ${token.symbol} to fund freelancer advances and receive ${v?.shareSymbol ?? "dvRLUSD"} shares. The vault earns a fixed financing fee only when an advanced invoice is paid.`}
      />

      {overview.error ? (
        <ErrorState message={overview.error} onRetry={overview.reload} />
      ) : !v ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <VaultStatus v={v} />
          <Overview v={v} />
        </>
      )}

      <LiveAuthGate>
        <PositionAndActions overview={v} reload={overview.reload} />
      </LiveAuthGate>

      <section aria-labelledby="vault-risk">
        <Alert variant="destructive" role="note">
          <AlertTriangle />
          <AlertTitle id="vault-risk" className="flex items-center gap-2">
            <Vault className="size-4" aria-hidden /> Risk disclosure
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {RISKS(token.symbol).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      </section>
      {repo.mode !== "api" && <p className="text-xs text-muted-foreground">Not connected to a chain.</p>}
    </div>
  )
}

function VaultStatus({ v }: { v: VaultOverview }) {
  const empty = BigInt(v.totalAssets) === BigInt(0)
  const example = BigInt(900)
  return (
    <div className="space-y-3">
      {v.paused && (
        <Alert variant="destructive" role="alert">
          <AlertTriangle />
          <AlertTitle>The vault is paused</AlertTitle>
          <AlertDescription>Deposits, withdrawals and new advances are stopped until it is unpaused.</AlertDescription>
        </Alert>
      )}
      {!v.paused && v.advancesPaused && (
        <Alert role="alert">
          <AlertTriangle />
          <AlertTitle>New advances are paused</AlertTitle>
          <AlertDescription>Deposits and withdrawals still work. Freelancers can&apos;t draw advances until this is lifted.</AlertDescription>
        </Alert>
      )}
      {empty && (
        <Alert role="note">
          <Coins />
          <AlertTitle>The vault is empty</AlertTitle>
          <AlertDescription>No advances can be funded until someone deposits. Freelancers who request an advance will be told the vault can&apos;t fund it.</AlertDescription>
        </Alert>
      )}
      {!empty && (
        <p className="text-xs text-muted-foreground">
          Limits: one advance can use at most {pct(v.maxInvoiceExposureBps)} of the vault&apos;s NAV, and outstanding advances can&apos;t exceed {pct(v.maxUtilizationBps)} of it. For example, a {formatToken(tokens(example))} advance needs at least {formatToken(tokens(example * BigInt(4)))} of NAV.
        </p>
      )}
    </div>
  )
}

function Overview({ v }: { v: VaultOverview }) {
  return (
    <section aria-labelledby="vault-overview" className="space-y-3">
      <h2 id="vault-overview" className="text-lg font-semibold">Vault overview</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard label="Total Vault Assets (NAV)" icon={Layers} tone="neutral" value={<Amount value={v.totalAssets} />} hint="Cash in the vault plus advances still outstanding, at face value." />
        <MetricCard label="Available Liquidity" icon={Wallet} tone="neutral" value={<Amount value={v.availableLiquidity} />} hint="Cash in the vault right now." />
        <MetricCard label="Outstanding Principal" icon={Coins} tone="neutral" value={<Amount value={v.outstandingPrincipal} />} hint="Advances paid to freelancers that aren't repaid or written off yet." />
        <MetricCard label="Utilization" icon={Gauge} tone="neutral" value={<span className="font-medium tabular-nums">{pct(v.utilizationBps)}</span>} hint={`Outstanding principal as a share of NAV. New advances stop at ${pct(v.maxUtilizationBps)}.`} />
        <MetricCard label="Share price" icon={PiggyBank} tone="neutral" value={<Amount value={v.sharePrice} maxFraction={6} />} hint={`${tokenDisplay().symbol} per whole ${v.shareSymbol} share. Rises with fees, falls with losses.`} />
        <MetricCard label="Can fund an advance now" icon={Rocket} tone="info" value={<Amount value={v.maxAdvanceNow} />} hint="Largest single advance the vault could fund this block, all limits applied." />
        <MetricCard label="Withdrawable now" icon={ArrowUpFromLine} tone="neutral" value={<Amount value={v.withdrawableLiquidity} />} hint="What depositors can take out right now. Less than cash when advances are out." />
        <MetricCard label="Total Fees Earned" icon={ArrowDownToLine} tone="success" value={<Amount value={v.totalFeesEarned} />} hint="Counted only after the client's payment arrives." />
        <MetricCard label="Realized Losses" icon={TrendingDown} tone={BigInt(v.totalRealizedLosses) === BigInt(0) ? "neutral" : "danger"} value={<Amount value={v.totalRealizedLosses} />} hint="Principal written off after a dispute went the client's way." />
      </div>
      <p className="text-xs text-muted-foreground">Read at block {v.blockNumber}.</p>
    </section>
  )
}

function PositionAndActions({ overview: v, reload }: { overview: VaultOverview | undefined; reload: () => void }) {
  const toast = useToast()
  const token = tokenDisplay()
  const progress = useTxProgress()
  const [depositText, setDepositText] = React.useState("")
  const [withdrawText, setWithdrawText] = React.useState("")
  const [inputError, setInputError] = React.useState<string | null>(null)
  const deposit = useAction((r, amount: string) => r.vault!.deposit(amount, progress.onProgress))
  const withdraw = useAction((r, amount: string) => r.vault!.withdraw(amount, progress.onProgress))
  const redeem = useAction((r, shares: string) => r.vault!.redeem(shares, progress.onProgress))
  const busy = deposit.pending || withdraw.pending || redeem.pending
  const p = v?.position ?? null

  async function done(label: string, r: { ok: true } | { ok: false; error: string }) {
    if (r.ok) toast({ tone: "success", title: `${label} confirmed`, description: "Confirmed on-chain." })
    else toast({ tone: "error", title: `${label} not completed`, description: r.error })
    reload()
  }

  async function onDeposit(e: React.FormEvent) {
    e.preventDefault()
    const amount = parseTokenInput(depositText)
    if (!amount || BigInt(amount) <= BigInt(0)) return setInputError("Enter a deposit amount greater than zero.")
    setInputError(null)
    progress.reset()
    await done("Deposit", await deposit.run(amount))
  }

  async function onWithdraw(e: React.FormEvent) {
    e.preventDefault()
    const amount = parseTokenInput(withdrawText)
    if (!amount || BigInt(amount) <= BigInt(0)) return setInputError("Enter a withdrawal amount greater than zero.")
    if (p && BigInt(amount) > BigInt(p.maxWithdraw)) {
      return setInputError(`Only ${formatToken(p.maxWithdraw, { maxFraction: 6 })} can be withdrawn right now. Funds out on advances and the utilization limit hold the rest until invoices settle.`)
    }
    setInputError(null)
    progress.reset()
    await done("Withdrawal", await withdraw.run(amount))
  }

  async function onWithdrawAll() {
    if (!p || BigInt(p.maxRedeem) === BigInt(0)) return
    setInputError(null)
    progress.reset()
    await done("Withdrawal", await redeem.run(p.maxRedeem))
  }

  const restricted = p && BigInt(p.assetValue) > BigInt(p.maxWithdraw)

  return (
    <>
      <section aria-labelledby="your-position" className="space-y-3">
        <h2 id="your-position" className="text-lg font-semibold">Your position</h2>
        <Card>
          <CardContent>
            {!p ? (
              <p className="text-sm text-muted-foreground">Connect your wallet (in the bar above) to see your position.</p>
            ) : (
              <dl className="grid gap-4 sm:grid-cols-4">
                <div>
                  <dt className="text-sm text-muted-foreground">{v?.shareSymbol} shares</dt>
                  <dd className="mt-1 text-2xl font-semibold tracking-tight"><Amount value={p.shares} hideSymbol maxFraction={6} /></dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">Estimated {token.symbol} value</dt>
                  <dd className="mt-1 text-2xl font-semibold tracking-tight"><Amount value={p.assetValue} maxFraction={6} /></dd>
                  <p className="mt-1 text-xs text-muted-foreground">Shares at the current share price: an estimate, not a guaranteed redemption.</p>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">Withdrawable now</dt>
                  <dd className="mt-1 text-2xl font-semibold tracking-tight"><Amount value={p.maxWithdraw} maxFraction={6} /></dd>
                  {restricted && <p className="mt-1 text-xs text-muted-foreground">Below your estimated value: liquidity is out on advances.</p>}
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">Wallet balance</dt>
                  <dd className="mt-1 text-2xl font-semibold tracking-tight"><Amount value={p.walletBalance} maxFraction={6} /></dd>
                  <p className="mt-1 text-xs text-muted-foreground">Not part of your vault position.</p>
                </div>
              </dl>
            )}
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="deposit-withdraw" className="space-y-3">
        <h2 id="deposit-withdraw" className="text-lg font-semibold">Deposit and withdraw</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ArrowDownToLine className="size-4" aria-hidden /> Deposit</CardTitle>
              <CardDescription>Supply {token.symbol} and receive {v?.shareSymbol ?? "dvRLUSD"} shares. The first time you may be asked to approve exactly this amount first.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onDeposit} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vault-deposit-amount">Amount ({token.symbol})</Label>
                  <Input id="vault-deposit-amount" inputMode="decimal" placeholder="0.00" value={depositText} onChange={(e) => setDepositText(e.target.value)} disabled={busy || v?.paused} />
                </div>
                <Button type="submit" disabled={busy || !p || v?.paused} className="w-full sm:w-auto">
                  {deposit.pending ? "Waiting for confirmation…" : "Deposit"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ArrowUpFromLine className="size-4" aria-hidden /> Withdraw</CardTitle>
              <CardDescription>Take {token.symbol} out, up to what vault liquidity allows right now.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onWithdraw} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vault-withdraw-amount">Amount ({token.symbol})</Label>
                  <Input id="vault-withdraw-amount" inputMode="decimal" placeholder="0.00" value={withdrawText} onChange={(e) => setWithdrawText(e.target.value)} disabled={busy || v?.paused} />
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button type="submit" variant="outline" disabled={busy || !p || v?.paused} className="w-full sm:w-auto">
                    {withdraw.pending ? "Waiting for confirmation…" : "Withdraw"}
                  </Button>
                  <Button type="button" variant="ghost" onClick={onWithdrawAll} disabled={busy || !p || BigInt(p.maxRedeem) === BigInt(0) || v?.paused} className="w-full sm:w-auto">
                    {redeem.pending ? "Waiting for confirmation…" : "Withdraw the most I can"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
        <p role="alert" className="text-sm text-destructive">{inputError ?? deposit.error ?? withdraw.error ?? redeem.error}</p>
      </section>

      <TxProgressPanel steps={progress.steps} title="Wallet steps" />
    </>
  )
}
