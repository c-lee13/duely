"use client"

import * as React from "react"
import { Mail, ShieldCheck, Wallet } from "lucide-react"
import { useLogin, usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth"
import type { EIP1193Provider } from "viem"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { useRepository } from "@/hooks/use-duely"
import { errorMessage } from "@/lib/frontend/errors"
import { isPrivyConfigured } from "@/lib/privy/config"
import { setPrivyWalletAccessor } from "@/lib/privy/active-wallet"

type Pending = "email" | "wallet" | null

interface EmailProps {
  disabled: boolean
  onPendingChange: (next: Pending) => void
  onError: (message: string | null) => void
}

function toSnapshot(embedded: ConnectedWallet) {
  return {
    address: embedded.address as `0x${string}`,
    getProvider: () => embedded.getEthereumProvider() as unknown as Promise<EIP1193Provider>,
    switchChain: (chainId: number) => embedded.switchChain(chainId),
  }
}

/**
 * The one place that calls Privy's React hooks. Only rendered when Privy is configured, so
 * the hooks are guaranteed to resolve against a <PrivyProvider>.
 *
 * Flow:
 *   1. User clicks "Continue with Email" → `wantsSignIn` ref is set and `login()` is invoked.
 *   2. Privy opens its modal (or, if the user is already authenticated, no-ops).
 *   3. Either way, Privy's state updates: `authenticated` flips to true, `useWallets()` publishes
 *      the embedded wallet.
 *   4. The effect below picks that up, publishes the wallet to the hybrid WalletPort's module
 *      accessor (defensive against a render-order race with <PrivyWalletBridge>), and triggers
 *      the standard /api/auth/wallet/challenge → /verify flow via the Duely repository.
 */
function EmailLoginButton({ disabled, onPendingChange, onError }: EmailProps) {
  const repo = useRepository()
  const { authenticated, ready, user } = usePrivy()
  const { wallets } = useWallets()

  const wantsSignIn = React.useRef(false)
  const signedInForUser = React.useRef<string | null>(null)

  const { login } = useLogin({
    onError: (code) => {
      wantsSignIn.current = false
      onError(`Login failed (${code}).`)
      onPendingChange(null)
    },
    // onComplete fires once the user is authenticated AND (if configured) the embedded wallet
    // is created. We don't call signIn from here directly because we also need `useWallets()`
    // to have published the wallet, which happens on the next render.
  })

  const embedded = React.useMemo(() => {
    if (!ready || !authenticated) return null
    return wallets.find((w) => w.walletClientType === "privy") ?? null
  }, [ready, authenticated, wallets])

  React.useEffect(() => {
    if (!wantsSignIn.current) return
    if (!embedded || !user?.id) return
    if (signedInForUser.current === user.id) return
    signedInForUser.current = user.id

    ;(async () => {
      try {
        // Publish the wallet to the module accessor so signInHybrid picks it up this tick,
        // regardless of effect ordering vs <PrivyWalletBridge>.
        setPrivyWalletAccessor(() => toSnapshot(embedded))
        await repo.live?.signIn()
        wantsSignIn.current = false
        // Successful signIn causes LiveAuthGate to unmount this card; no need to reset pending.
      } catch (e) {
        signedInForUser.current = null
        wantsSignIn.current = false
        onError(errorMessage(e))
        onPendingChange(null)
      }
    })()
  }, [embedded, user?.id, repo, onError, onPendingChange])

  function onClick() {
    onError(null)
    onPendingChange("email")
    wantsSignIn.current = true
    // login() is void. Opens the Privy modal; if the user is already authenticated it no-ops
    // ("Attempted to log in, but user is already logged in"), and the effect above still fires
    // once `embedded` and `user.id` are available.
    login()
  }

  return (
    <Button size="lg" className="w-full" onClick={onClick} disabled={disabled || !ready}>
      <Mail />
      {disabled ? "Waiting for email login…" : "Continue with Email"}
    </Button>
  )
}

/**
 * Login card with two options: email (Privy) and existing wallet (MetaMask). The email
 * branch is only rendered when NEXT_PUBLIC_PRIVY_APP_ID is set.
 */
export function LoginChoice({ needsWalletOnly }: { needsWalletOnly?: boolean }) {
  const repo = useRepository()
  const [pending, setPending] = React.useState<Pending>(null)
  const [error, setError] = React.useState<string | null>(null)
  const privyConfigured = isPrivyConfigured()

  const onPendingChange = React.useCallback((next: Pending) => setPending(next), [])
  const onError = React.useCallback((message: string | null) => setError(message), [])

  async function onWallet() {
    onError(null)
    setPending("wallet")
    try {
      await repo.live?.signIn()
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="mx-auto max-w-lg py-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="size-5" aria-hidden /> Sign in to Duely
          </CardTitle>
          <CardDescription>
            Continue with your email and we&apos;ll provision a wallet for you, or connect an existing wallet. Either
            way you&apos;ll be asked to sign a short message to prove ownership. It&apos;s free and sends no transaction.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {needsWalletOnly && (
            <Alert>
              <ShieldCheck />
              <AlertTitle>Signed in, but no verified wallet yet</AlertTitle>
              <AlertDescription>Connect or create a wallet to link it to this account.</AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Couldn&apos;t sign in</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-3">
            {privyConfigured && (
              <EmailLoginButton
                disabled={pending === "email"}
                onPendingChange={onPendingChange}
                onError={onError}
              />
            )}
            <Button
              size="lg"
              variant={privyConfigured ? "outline" : "default"}
              className="w-full"
              onClick={onWallet}
              disabled={pending !== null}
            >
              <Wallet />
              {pending === "wallet" ? "Waiting for your wallet…" : "Connect wallet"}
            </Button>
          </div>
        </CardContent>
        <CardFooter className="text-xs text-muted-foreground">
          {privyConfigured
            ? "Email users receive a Duely-managed wallet; wallet users keep using their own key."
            : "Needs a browser wallet such as MetaMask."}
        </CardFooter>
      </Card>
    </div>
  )
}
