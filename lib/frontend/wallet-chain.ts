"use client"

/**
 * The browser's MetaMask (EIP-1193) connection, as far as TRANSACTIONS are concerned. Sign-in (proving wallet
 * ownership to the server) lives in lib/auth/wallet-client.ts and is separate: signing a message is not a transaction.
 *
 * Everything here is deployment-aware through the chain SDK (`activeDeployment()`): the expected chain is XRPL EVM
 * Testnet (1449000) and the explorer/token come from the configured deployment, never from the wallet. No key is ever
 * held here: the wallet signs, and `walletContext` just wraps its provider for the SDK's write helpers.
 */
import type { EIP1193Provider } from "viem"
import { CHAIN_ID, activeDeployment, createWalletClientFromProvider, getPublicClient, publicRpcUrl, type WriteContext } from "@/lib/chain"
import type { Address } from "./domain"
import { DomainError } from "./errors"

export interface WalletState {
  /** A browser wallet (window.ethereum) exists. */
  available: boolean
  /** The account MetaMask has selected for this site, or null if not connected. Lower-case. */
  account: Address | null
  /** The chain id the wallet is on, or null if unknown. */
  chainId: number | null
  expectedChainId: number
  /** True only when connected AND on the expected chain. */
  ready: boolean
  /** The configured deployment the app will transact with. */
  deployment: { key: string; symbol: string; decimals: number; isDemoToken: boolean }
}

export const hex = (n: number) => `0x${n.toString(16)}`

export function injectedProvider(): EIP1193Provider | null {
  const eth = (globalThis as { ethereum?: EIP1193Provider }).ethereum
  return eth ?? null
}

function deploymentInfo() {
  const d = activeDeployment()
  return { key: d.key, symbol: d.token.symbol, decimals: d.token.decimals, isDemoToken: d.token.isDemoToken }
}

const toChainId = (raw: unknown): number | null => {
  if (typeof raw === "string" && /^0x[0-9a-fA-F]+$/.test(raw)) return Number.parseInt(raw, 16)
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw
  return null
}

/** Reads the wallet WITHOUT prompting (eth_accounts and eth_chainId only). */
export async function readWalletState(provider: EIP1193Provider | null = injectedProvider()): Promise<WalletState> {
  const base = { expectedChainId: CHAIN_ID, deployment: deploymentInfo() }
  if (!provider) return { ...base, available: false, account: null, chainId: null, ready: false }
  const [accounts, chain] = await Promise.all([
    provider.request({ method: "eth_accounts" }) as Promise<string[]>,
    provider.request({ method: "eth_chainId" }),
  ])
  const account = (accounts?.[0]?.toLowerCase() as Address | undefined) ?? null
  const chainId = toChainId(chain)
  return { ...base, available: true, account, chainId, ready: account !== null && chainId === CHAIN_ID }
}

/** Asks MetaMask to connect (prompts). */
export async function connectWallet(provider: EIP1193Provider | null = injectedProvider()): Promise<WalletState> {
  if (!provider) throw new DomainError("NO_WALLET", "No browser wallet found. Install MetaMask to continue.")
  try {
    await provider.request({ method: "eth_requestAccounts" })
  } catch (e) {
    throw rejected(e, "The wallet connection was cancelled.")
  }
  return readWalletState(provider)
}

/** Switches MetaMask to XRPL EVM Testnet, adding the network first if the wallet does not know it. */
export async function switchToExpectedChain(provider: EIP1193Provider | null = injectedProvider()): Promise<WalletState> {
  if (!provider) throw new DomainError("NO_WALLET", "No browser wallet found. Install MetaMask to continue.")
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex(CHAIN_ID) }] })
  } catch (e) {
    const code = (e as { code?: number }).code
    if (code === 4902 || code === -32603) {
      // Unknown to this wallet: add it (the user confirms in MetaMask), which also switches to it.
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hex(CHAIN_ID),
              chainName: "XRPL EVM Testnet",
              nativeCurrency: { name: "XRP", symbol: "XRP", decimals: 18 },
              rpcUrls: [publicRpcUrl],
              blockExplorerUrls: [activeDeployment().explorer],
            },
          ],
        })
      } catch (addError) {
        throw rejected(addError, "Adding XRPL EVM Testnet to the wallet was cancelled.")
      }
    } else {
      throw rejected(e, "Switching network was cancelled.")
    }
  }
  return readWalletState(provider)
}

function rejected(e: unknown, message: string): DomainError {
  const code = (e as { code?: number }).code
  return code === 4001 ? new DomainError("USER_REJECTED", message) : new DomainError("WRONG_NETWORK", `The wallet couldn't complete that request${e instanceof Error ? `: ${e.message.slice(0, 160)}` : "."}`)
}

/**
 * The gate every transaction goes through. Throws a specific DomainError unless the wallet is connected, on the expected
 * chain, and (when given) on exactly the account that is allowed to perform the action. Returns the SDK write context.
 */
export async function requireWallet(opts: { expectedAccount?: string; provider?: EIP1193Provider | null; publicClient?: WriteContext["publicClient"] } = {}): Promise<WriteContext & { account: Address }> {
  const provider = opts.provider === undefined ? injectedProvider() : opts.provider
  const state = await readWalletState(provider)
  if (!state.available || !provider) throw new DomainError("NO_WALLET", "No browser wallet found. Install MetaMask to continue.")
  if (!state.account) throw new DomainError("WALLET_NOT_CONNECTED", "Connect MetaMask to this site first.")
  if (state.chainId !== state.expectedChainId) {
    throw new DomainError("WRONG_NETWORK", `MetaMask is on chain ${state.chainId ?? "unknown"}. Switch to XRPL EVM Testnet (${state.expectedChainId}) to continue.`)
  }
  if (opts.expectedAccount && state.account !== opts.expectedAccount.toLowerCase()) {
    throw new DomainError("WRONG_ACCOUNT", `This action must be signed by ${opts.expectedAccount}. MetaMask has ${state.account} selected; switch accounts in MetaMask.`)
  }
  return {
    wallet: createWalletClientFromProvider(provider, state.account),
    publicClient: opts.publicClient ?? (getPublicClient() as unknown as WriteContext["publicClient"]),
    account: state.account,
  }
}

/** Calls `listener` whenever the wallet's account or network changes. Returns an unsubscribe function. */
export function watchWallet(listener: () => void, provider: EIP1193Provider | null = injectedProvider()): () => void {
  if (!provider || typeof provider.on !== "function") return () => undefined
  provider.on("accountsChanged", listener)
  provider.on("chainChanged", listener)
  return () => {
    provider.removeListener?.("accountsChanged", listener)
    provider.removeListener?.("chainChanged", listener)
  }
}
