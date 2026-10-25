"use client"

import * as React from "react"
import { ShieldCheck, Wallet } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useRepoQuery, useRepository } from "@/hooks/use-duely"
import { signInErrorMessage } from "@/lib/frontend/errors"
import { ErrorState, PageSkeleton } from "./primitives"

/**
 * Live (API) mode only: nothing is shown until the SERVER confirms a signed-in user with a verified wallet.
 * The answer comes from /api/auth/session, never from browser storage. Mock mode never renders this.
 */
export function LiveAuthGate({ children }: { children: React.ReactNode }) {
  const repo = useRepository()
  const auth = useRepoQuery("live-auth", (r) => (r.live ? r.live.getAuth() : Promise.resolve({ authenticated: true, wallets: [] })))
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  if (auth.error) return <ErrorState message={auth.error} onRetry={auth.reload} />
  if (!auth.data) return <PageSkeleton />
  if (auth.data.authenticated && auth.data.wallets.length > 0) return <>{children}</>

  async function connect() {
    setPending(true)
    setError(null)
    try {
      await repo.live?.signIn()
    } catch (e) {
      setError(signInErrorMessage(e, typeof window === "undefined" ? undefined : window.location.origin))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mx-auto max-w-lg py-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="size-5" aria-hidden /> Connect your wallet
          </CardTitle>
          <CardDescription>
            Sign in by proving you own your wallet. You&apos;ll be asked to sign a short message. It&apos;s free, sends no
            blockchain transaction, and can&apos;t move funds.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {auth.data.authenticated && (
            <Alert>
              <ShieldCheck />
              <AlertTitle>Signed in, but no verified wallet yet</AlertTitle>
              <AlertDescription>Connect a wallet to link it to this account.</AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Couldn&apos;t sign in</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button size="lg" className="w-full sm:w-auto" onClick={connect} disabled={pending}>
            <Wallet /> {pending ? "Waiting for your wallet…" : "Connect wallet"}
          </Button>
          <p className="text-xs text-muted-foreground">Needs a browser wallet such as MetaMask.</p>
        </CardContent>
      </Card>
    </div>
  )
}
