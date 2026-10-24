"use client"

import * as React from "react"
import { Settings2, Wallet } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { DemoControlsDialog, RoleSwitcher } from "@/components/duely/app-shell"
import { AddressChip, Amount, ErrorState, PageHeader, SimulatedTag } from "@/components/duely/primitives"
import { useBalances, useRepository, useSession } from "@/hooks/use-duely"

export default function ProfilePage() {
  const repo = useRepository()
  const session = useSession()
  const balances = useBalances(session.data?.role)
  const [controlsOpen, setControlsOpen] = React.useState(false)

  if (session.error) return <ErrorState message={session.error} onRetry={session.reload} />

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader eyebrow="Profile" title="Account & demo" description="Who you are in this demo, and the controls to reset it." />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="size-4" aria-hidden /> Simulated wallet <SimulatedTag />
          </CardTitle>
          <CardDescription>No real wallet is connected. This identity comes from the demo role switcher, not sign-in.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!session.data ? (
            <Skeleton className="h-16" />
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Name</span>
                <span className="font-medium">{session.data.displayName}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Role</span>
                <span className="font-medium capitalize">{session.data.role}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Wallet</span>
                <AddressChip address={session.data.wallet} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Balance</span>
                {balances.data ? <Amount value={balances.data.walletBalance} /> : <Skeleton className="h-5 w-24" />}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {repo.demo && session.data && (
        <Card>
          <CardHeader>
            <CardTitle>Demo role</CardTitle>
            <CardDescription>Switch who you are. Switching takes you to that role&apos;s dashboard.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <RoleSwitcher current={session.data.role} />
            <Button variant="outline" size="lg" onClick={() => setControlsOpen(true)}>
              <Settings2 /> Demo controls &amp; reset
            </Button>
          </CardContent>
        </Card>
      )}
      <DemoControlsDialog open={controlsOpen} onOpenChange={setControlsOpen} />
    </div>
  )
}
