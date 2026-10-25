"use client"

/**
 * Hybrid WalletPort for the Duely frontend repository.
 *
 * - When a Privy embedded wallet is active (user logged in by email, embedded wallet
 *   provisioned), route state / chain-switch / transaction-signing through its EIP-1193
 *   provider.
 * - Otherwise, fall back to the existing MetaMask / injected-provider path in
 *   lib/frontend/wallet-chain.ts.
 *
 * The active Privy wallet is read lazily from `getActivePrivyWallet()` on every call so the
 * same WalletPort instance stays correct across Privy state changes (login/logout, chain
 * switch) without the Duely repository ever being rebuilt.
 *
 * Server-side auth is unchanged: both paths ultimately `personal_sign` the same challenge
 * from /api/auth/wallet/challenge and verify it against /api/auth/wallet/verify.
 */
import type { EIP1193Provider } from "viem"
import {
  readWalletState,
  requireWallet,
  switchToExpectedChain,
  connectWallet,
  watchWallet,
  injectedProvider,
} from "@/lib/frontend/wallet-chain"
import { CHAIN_ID } from "@/lib/chain"
import type { WalletPort } from "@/lib/frontend/api-repository"
import { DomainError } from "@/lib/frontend/errors"
import { signOut as serverSignOut } from "@/lib/auth/wallet-client"
import { getActivePrivyWallet, privyLogoutIfActive } from "./active-wallet"

type ChangeListener = () => void
const privyChangeListeners = new Set<ChangeListener>()

/** Called by the Privy bridge whenever the embedded wallet state changes. */
export function notifyPrivyWalletChange(): void {
  privyChangeListeners.forEach((l) => {
    try {
      l()
    } catch {
      // listener failures must not break the notification fan-out
    }
  })
}

/**
 * Signs the standard /api/auth/wallet/challenge → /api/auth/wallet/verify flow using any
 * EIP-1193 provider. Mirrors lib/auth/wallet-client.ts:44-58 — the server never sees
 * Privy, it sees a signed EVM address like any other wallet sign-in.
 */
async function signInWith(provider: EIP1193Provider, address: `0x${string}`): Promise<{ userId: string; wallets: string[] }> {
  const toHex = (text: string) =>
    "0x" + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("")

  const challengeRes = await fetch("/api/auth/wallet/challenge", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  })
  const challengeJson = (await challengeRes.json().catch(() => null)) as
    | { nonce?: string; message?: string; error?: { code?: string; message?: string } }
    | null
  if (!challengeRes.ok || !challengeJson?.nonce || !challengeJson.message) {
    throw new DomainError(
      "UNAUTHENTICATED",
      challengeJson?.error?.message ?? "Couldn't start wallet sign-in.",
      challengeJson?.error?.code
    )
  }

  let signature: string
  try {
    signature = (await provider.request({
      method: "personal_sign",
      params: [toHex(challengeJson.message), address],
    } as never)) as string
  } catch {
    throw new DomainError("USER_REJECTED", "The signature request was rejected.")
  }

  const verifyRes = await fetch("/api/auth/wallet/verify", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, nonce: challengeJson.nonce, signature }),
  })
  const verifyJson = (await verifyRes.json().catch(() => null)) as
    | { userId?: string; wallets?: string[]; error?: { code?: string; message?: string } }
    | null
  if (!verifyRes.ok || !verifyJson?.userId) {
    throw new DomainError(
      "UNAUTHENTICATED",
      verifyJson?.error?.message ?? "Couldn't verify the wallet signature.",
      verifyJson?.error?.code
    )
  }
  return { userId: verifyJson.userId, wallets: verifyJson.wallets ?? [] }
}

/**
 * Hybrid sign-out: drop the Privy session first (if there is one) so the embedded wallet
 * stops reporting an address, then clear the Supabase Auth cookie through the existing
 * /api/auth/signout endpoint.
 */
export async function signOutHybrid(): Promise<void> {
  await privyLogoutIfActive()
  await serverSignOut()
}

/**
 * Browser sign-in used by the Duely repository. Prefers an active Privy embedded wallet;
 * falls back to the injected provider (MetaMask) so the existing wallet-only flow still
 * works unchanged.
 */
export async function signInHybrid(): Promise<{ userId: string; wallets: string[] }> {
  const privy = getActivePrivyWallet()
  if (privy) {
    const provider = await privy.getProvider()
    return signInWith(provider, privy.address)
  }
  const injected = injectedProvider()
  if (!injected) {
    throw new DomainError("NO_WALLET", "No wallet found. Continue with email or install MetaMask.")
  }
  const accounts = (await injected.request({ method: "eth_requestAccounts" } as never)) as string[]
  const address = accounts?.[0]?.toLowerCase() as `0x${string}` | undefined
  if (!address) throw new DomainError("WALLET_NOT_CONNECTED", "The wallet did not share an account.")
  return signInWith(injected, address)
}

/**
 * The hybrid WalletPort. Satisfies the WalletPort interface from api-repository.ts (lines
 * 145-159) so no business logic needs to know whether Privy or MetaMask is active.
 */
export const hybridWalletPort: WalletPort = {
  async state() {
    const privy = getActivePrivyWallet()
    if (privy) {
      const provider = await privy.getProvider()
      return readWalletState(provider)
    }
    return readWalletState()
  },
  async connect() {
    const privy = getActivePrivyWallet()
    if (privy) {
      // Privy's "connect" is driven by its own login modal; nothing to do here beyond
      // reporting the current state.
      const provider = await privy.getProvider()
      return readWalletState(provider)
    }
    return connectWallet()
  },
  async switchNetwork() {
    const privy = getActivePrivyWallet()
    if (privy) {
      await privy.switchChain(CHAIN_ID)
      const provider = await privy.getProvider()
      return readWalletState(provider)
    }
    return switchToExpectedChain()
  },
  async require(opts: { expectedAccount?: string } = {}) {
    const privy = getActivePrivyWallet()
    if (privy) {
      const provider = await privy.getProvider()
      // Re-use the central transaction guard — same WRONG_NETWORK / WALLET_NOT_CONNECTED
      // errors regardless of which provider is in use.
      return requireWallet({ provider, expectedAccount: opts.expectedAccount })
    }
    return requireWallet(opts)
  },
  watch(listener) {
    privyChangeListeners.add(listener)
    const unInjected = watchWallet(listener)
    return () => {
      privyChangeListeners.delete(listener)
      unInjected()
    }
  },
}
