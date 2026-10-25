"use client"

/**
 * Browser helper for the MetaMask sign-in flow. NOT wired into any page yet (Phase 3A is backend-only).
 * The browser only ever sends the address it controls plus a signature; the server decides what that proves.
 */

export class WalletClientError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "WalletClientError"
  }
}

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

function provider(): Eip1193Provider {
  const eth = (globalThis as { ethereum?: Eip1193Provider }).ethereum
  if (!eth) throw new WalletClientError("NO_WALLET", "No browser wallet found. Install MetaMask to continue.")
  return eth
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null
  if (!res.ok) throw new WalletClientError(json?.error?.code ?? "REQUEST_FAILED", json?.error?.message ?? "Request failed.")
  return json as T
}

const toHex = (text: string) =>
  "0x" + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("")

/** Connects the wallet, asks the server for a challenge, has the wallet sign it, and verifies it. */
export async function signInWithWallet(): Promise<{ userId: string; wallets: string[] }> {
  const eth = provider()
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[]
  const address = accounts[0]
  if (!address) throw new WalletClientError("NO_ACCOUNT", "The wallet did not share an account.")

  const challenge = await postJson<{ nonce: string; message: string }>("/api/auth/wallet/challenge", { address })
  let signature: string
  try {
    signature = (await eth.request({ method: "personal_sign", params: [toHex(challenge.message), address] })) as string
  } catch {
    throw new WalletClientError("SIGNATURE_REJECTED", "The signature request was rejected in the wallet.")
  }
  return postJson("/api/auth/wallet/verify", { address, nonce: challenge.nonce, signature })
}

export async function signOut(): Promise<void> {
  await postJson("/api/auth/signout", {})
}
