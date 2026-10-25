/**
 * Privy configuration for the XRPL EVM Sidechain Testnet.
 *
 * The chain description below is a plain, materialized viem `Chain` object — Privy's
 * `defaultChain` / `supportedChains` props expect a static chain, not a getter-based proxy
 * like the one in `lib/chain/config.ts` (which flips contract addresses by deployment).
 * The chain id, RPC URL, and explorer are read from `lib/chain` so there is still a single
 * source of truth for the chain itself; only the token/contract bits vary by deployment.
 */
import { defineChain } from "viem"
import { CHAIN_ID, publicRpcUrl, activeDeployment } from "@/lib/chain"

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? ""

export function isPrivyConfigured(): boolean {
  return PRIVY_APP_ID.length > 0
}

/**
 * Materialized viem chain for Privy. Rebuilt on first access so the explorer URL reflects
 * the currently active deployment (dUSD vs RLUSD both run on 1449000 but point to the same
 * public explorer; this still re-reads at import to be safe).
 */
export const privyXrplEvmTestnet = defineChain({
  id: CHAIN_ID,
  name: "XRPL EVM Sidechain Testnet",
  nativeCurrency: { name: "XRP", symbol: "XRP", decimals: 18 },
  rpcUrls: {
    default: { http: [publicRpcUrl] },
  },
  blockExplorers: {
    default: { name: "XRPL EVM Explorer", url: activeDeployment().explorer },
  },
  testnet: true,
})
