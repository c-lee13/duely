"use client"

/**
 * Module-level accessor that lets the (non-React) wallet port read the currently active
 * Privy embedded wallet without rebuilding the Duely repository on every Privy state change.
 *
 * A client component rendered inside <PrivyProvider> (see components/duely/privy-bridge.tsx)
 * writes the accessor whenever Privy's hooks re-render; the wallet port calls it lazily each
 * time a transaction or signature is attempted. The accessor returns:
 *   - a thin snapshot of the embedded wallet (address + EIP-1193 provider + switchChain), or
 *   - null when there is no authenticated Privy user / no embedded wallet.
 *
 * External (injected) wallets are not routed through here — those keep using window.ethereum
 * via lib/frontend/wallet-chain.ts unchanged.
 */
import type { EIP1193Provider } from "viem"

export interface PrivyEmbeddedWalletSnapshot {
  address: `0x${string}`
  getProvider: () => Promise<EIP1193Provider>
  switchChain: (chainId: number) => Promise<void>
}

type Accessor = () => PrivyEmbeddedWalletSnapshot | null

let current: Accessor = () => null

export function setPrivyWalletAccessor(fn: Accessor): void {
  current = fn
}

export function getActivePrivyWallet(): PrivyEmbeddedWalletSnapshot | null {
  return current()
}

/**
 * Lets non-React code (lib/privy/wallet-port.ts) ask Privy to drop its session when the
 * app signs out. Set by components/duely/privy-bridge.tsx; a no-op if Privy isn't mounted.
 */
let logoutImpl: (() => Promise<void>) | null = null

export function setPrivyLogout(fn: (() => Promise<void>) | null): void {
  logoutImpl = fn
}

export async function privyLogoutIfActive(): Promise<void> {
  if (logoutImpl) await logoutImpl()
}
