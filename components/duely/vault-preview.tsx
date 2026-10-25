"use client"

import * as React from "react"
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Coins, FlaskConical, Gauge, Layers, TrendingDown, Vault, Wallet } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MetricCard, PageHeader, Pill } from "@/components/duely/primitives"

/**
 * Duely V2 Liquidity Provider Vault dashboard: PREVIEW ONLY, and independent of the client and freelancer pages (own route group
 * and layout, no shared navigation, no repository, no wallet, no API).
 *
 * Nothing here reads a contract, calls an API, or sends a transaction. Every figure is a placeholder ("—"); there is no sample data
 * to mistake for live numbers. The V2 contracts (docs/VAULT_IMPLEMENTATION_SPEC.md) do not exist yet, so there is no ABI either.
 * When real reads exist, replace `PLACEHOLDER` with values read from the chain and drop the preview banner.
 *
 * Names follow the V2 spec: asset RLUSD, share token "Duely Vault Share" (dvRLUSD).
 */
export const VAULT_ASSET = "RLUSD"
export const VAULT_SHARE = "dvRLUSD"
export const PLACEHOLDER = "—"

const METRICS = [
  { label: "Total Vault Assets (NAV)", hint: "Cash in the vault plus advances still outstanding, counted at face value.", icon: Layers },
  { label: "Available Liquidity", hint: `${VAULT_ASSET} in the vault right now. This is what can actually be withdrawn.`, icon: Wallet },
  { label: "Outstanding Principal", hint: "Advances paid to freelancers that are not yet repaid or written off.", icon: Coins },
  { label: "Utilization", hint: "Outstanding principal as a share of NAV. The spec proposes an 80% cap on new advances.", icon: Gauge },
  { label: "Total Fees Earned", hint: "Financing fees count only after the client's payment arrives.", icon: ArrowDownToLine },
  { label: "Realized Losses", hint: "Principal written off when a dispute is decided for the client. Lowers the share price.", icon: TrendingDown },
] as const

const POSITION = [
  { label: `${VAULT_SHARE} shares`, hint: "Your share of the vault, as a token." },
  { label: `Estimated ${VAULT_ASSET} value`, hint: "Shares at the current share price. An estimate, not a guaranteed redemption amount." },
  { label: `Currently withdrawable ${VAULT_ASSET}`, hint: "Never more than the vault's available liquidity, so it can be less than your estimated value." },
] as const

const RISKS = [
  "Your principal and any returns are not guaranteed. You can lose some or all of what you deposit.",
  "If a dispute is decided for the client, the advance is not recovered and the loss is shared by everyone holding shares, through a lower share price.",
  "Withdrawals depend on available liquidity. While advances are outstanding, you may only be able to withdraw part of your balance, or have to wait.",
  `${VAULT_ASSET} is controlled by its issuer, who can pause transfers or claw back tokens.`,
  "The V2 contracts are not deployed and have not been audited. This page is a design preview.",
] as const

function Placeholder({ what }: { what: string }) {
  return (
    <span className="text-muted-foreground" aria-label={`${what}: placeholder, no data yet`}>
      {PLACEHOLDER}
    </span>
  )
}

const Soon = () => <span className="text-xs text-muted-foreground">Placeholder · no data connected</span>

export function VaultPreview() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-2">
            Vault / Earn{" "}
            <Pill tone="warning" icon={FlaskConical}>
              V2 preview
            </Pill>
          </span>
        }
        title="Liquidity Vault"
        description={`Supply ${VAULT_ASSET} to fund freelancer advances and receive ${VAULT_SHARE} shares. This is a preview of the V2 design.`}
      />

      <Alert role="note">
        <FlaskConical />
        <AlertTitle>V2 preview. Not connected to the blockchain.</AlertTitle>
        <AlertDescription>
          The vault contracts have not been built or deployed yet. This page reads no contracts and sends no transactions, and every figure is a placeholder ({PLACEHOLDER}), not live data. Nothing here affects invoices, escrow or the existing reserve.
        </AlertDescription>
      </Alert>

      <section aria-labelledby="vault-overview" className="space-y-3">
        <h2 id="vault-overview" className="text-lg font-semibold">
          Vault overview
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {METRICS.map(({ label, hint, icon }) => (
            <MetricCard key={label} label={label} icon={icon} tone="neutral" value={<Placeholder what={label} />} hint={<>{hint} <Soon /></>} />
          ))}
        </div>
      </section>

      <section aria-labelledby="your-position" className="space-y-3">
        <h2 id="your-position" className="text-lg font-semibold">
          Your position
        </h2>
        <Card>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-3">
              {POSITION.map(({ label, hint }) => (
                <div key={label}>
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="mt-1 text-2xl font-semibold tracking-tight">
                    <Placeholder what={label} />
                  </dd>
                  <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-xs text-muted-foreground">Placeholder · your wallet&apos;s position will appear here once the vault contract can be read.</p>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="deposit-withdraw" className="space-y-3">
        <h2 id="deposit-withdraw" className="text-lg font-semibold">
          Deposit and withdraw
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ArrowDownToLine className="size-4" aria-hidden /> Deposit
              </CardTitle>
              <CardDescription>Supply {VAULT_ASSET} and receive {VAULT_SHARE} shares.</CardDescription>
            </CardHeader>
            <CardContent>
              <div role="group" aria-label="Deposit (preview, disabled)" aria-describedby="deposit-note" className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vault-deposit-amount">Amount ({VAULT_ASSET})</Label>
                  <Input id="vault-deposit-amount" disabled placeholder="0.00" inputMode="decimal" />
                </div>
                <p className="text-sm text-muted-foreground">You would receive: <Placeholder what="Shares received" /> {VAULT_SHARE}</p>
                <Button type="button" disabled className="w-full sm:w-auto">
                  Deposit (coming with V2)
                </Button>
                <p id="deposit-note" className="text-xs text-muted-foreground">
                  Preview only. This is disabled and sends no transaction.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ArrowUpFromLine className="size-4" aria-hidden /> Withdraw
              </CardTitle>
              <CardDescription>Redeem {VAULT_SHARE} shares for {VAULT_ASSET}, up to the vault&apos;s available liquidity.</CardDescription>
            </CardHeader>
            <CardContent>
              <div role="group" aria-label="Withdraw (preview, disabled)" aria-describedby="withdraw-note" className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vault-withdraw-amount">Shares ({VAULT_SHARE})</Label>
                  <Input id="vault-withdraw-amount" disabled placeholder="0.00" inputMode="decimal" />
                </div>
                <p className="text-sm text-muted-foreground">You would receive: <Placeholder what="RLUSD received" /> {VAULT_ASSET}</p>
                <Button type="button" variant="outline" disabled className="w-full sm:w-auto">
                  Withdraw (coming with V2)
                </Button>
                <p id="withdraw-note" className="text-xs text-muted-foreground">
                  Preview only. This is disabled and sends no transaction. Real withdrawals will depend on available liquidity.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <section aria-labelledby="vault-risk">
        <Alert variant="destructive" role="note">
          <AlertTriangle />
          <AlertTitle id="vault-risk" className="flex items-center gap-2">
            <Vault className="size-4" aria-hidden /> Risk disclosure
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {RISKS.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      </section>
    </div>
  )
}
