"use client"

import * as React from "react"
import { usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth"
import type { EIP1193Provider } from "viem"
import { setPrivyLogout, setPrivyWalletAccessor, type PrivyEmbeddedWalletSnapshot } from "@/lib/privy/active-wallet"
import { notifyPrivyWalletChange } from "@/lib/privy/wallet-port"

/**
 * Rendered inside PrivyProvider. Reads Privy's wallet state and writes a snapshot accessor
 * to the module-level singleton that lib/privy/wallet-port.ts consults on every call.
 *
 * This is the one place that depends on Privy's React hooks directly; the rest of the app
 * never imports from @privy-io/react-auth.
 */
export function PrivyWalletBridge({ children }: { children: React.ReactNode }) {
  const { authenticated, ready, user, logout } = usePrivy()
  const { wallets } = useWallets()

  React.useEffect(() => {
    setPrivyLogout(async () => {
      try {
        await logout()
      } catch {
        // ignore — the server-side signout still proceeds via the repository
      }
    })
    return () => setPrivyLogout(null)
  }, [logout])

  const embedded = React.useMemo<ConnectedWallet | null>(() => {
    if (!ready || !authenticated) return null
    // walletClientType === "privy" distinguishes an embedded wallet from any linked external
    // (injected) wallet the same user may also have on their account.
    return wallets.find((w) => w.walletClientType === "privy") ?? null
  }, [ready, authenticated, wallets])

  React.useEffect(() => {
    if (!embedded) {
      setPrivyWalletAccessor(() => null)
      notifyPrivyWalletChange()
      return
    }
    const snapshot: PrivyEmbeddedWalletSnapshot = {
      address: embedded.address as `0x${string}`,
      // Privy's EIP1193Provider has a looser `on()` signature than viem's; the runtime
      // shape is compatible, so cast at the boundary rather than wrapping every call.
      getProvider: () => embedded.getEthereumProvider() as unknown as Promise<EIP1193Provider>,
      switchChain: (chainId: number) => embedded.switchChain(chainId),
    }
    setPrivyWalletAccessor(() => snapshot)
    notifyPrivyWalletChange()
    return () => {
      setPrivyWalletAccessor(() => null)
      notifyPrivyWalletChange()
    }
  }, [embedded, user?.id])

  return <>{children}</>
}
