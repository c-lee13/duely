"use client"

import * as React from "react"
import { HandCoins } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/components/duely/toast"
import { TxProgressPanel, useTxProgress } from "@/components/duely/tx-progress"
import { Amount } from "@/components/duely/primitives"
import { useAction, useRepoQuery, useRepository } from "@/hooks/use-duely"
import { isZero } from "@/lib/frontend/token"

/**
 * v2 pull payments: the freelancer's settlement remainder and a client's dispute refund are CREDITED inside the escrow
 * contract and only reach the wallet when claimed. This card shows what is waiting (read from the chain, never invented)
 * next to the wallet balance, which is a different number, and lets the connected wallet claim it. It renders nothing
 * unless the repository offers claims (live mode on the v2 deployment) and something is waiting or a claim is in flight.
 */
export function ClaimCard({ sessionKey }: { sessionKey: string }) {
  const repo = useRepository()
  const toast = useToast()
  const progress = useTxProgress()
  const balance = useRepoQuery(repo.claims ? `claimable:${sessionKey}` : null, (r) => r.claims!.getClaimable())
  const claim = useAction((r) => r.claims!.claim(progress.onProgress))

  if (!repo.claims) return null
  // A wallet that isn't connected yet is not an error here: the wallet bar already asks for it.
  if (balance.error || !balance.data) return null
  const { claimable, walletBalance } = balance.data
  if (isZero(claimable) && progress.steps.length === 0) return null

  async function onClaim() {
    progress.reset()
    const r = await claim.run()
    if (r.ok) toast({ tone: "success", title: "Proceeds claimed", description: "The funds are now in your wallet." })
    else toast({ tone: "error", title: "Claim not completed", description: r.error })
    balance.reload()
  }

  return (
    <>
      <Card className="ring-2 ring-advance/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HandCoins className="size-4" aria-hidden /> Ready to claim
          </CardTitle>
          <CardDescription>
            These funds are credited to you in the escrow contract but are not in your wallet until you claim them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Claimable now</dt>
              <dd className="text-2xl font-semibold"><Amount value={claimable} /></dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Wallet balance (separate)</dt>
              <dd className="text-lg"><Amount value={walletBalance} /></dd>
            </div>
          </dl>
          <Button onClick={onClaim} disabled={claim.pending || isZero(claimable)}>
            {claim.pending ? "Waiting for confirmation…" : "Claim to my wallet"}
          </Button>
          {claim.error && <p role="alert" className="text-sm text-destructive">{claim.error}</p>}
        </CardContent>
      </Card>
      <TxProgressPanel steps={progress.steps} title="Claim" />
    </>
  )
}
