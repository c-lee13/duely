import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type EIP1193Provider,
  type PublicClient,
} from "viem"

import { publicRpcUrl, xrplEvmTestnet } from "./config"

/** Creates a read-only viem client for XRPL EVM Testnet. Defaults to the public RPC. */
export function createChainPublicClient(rpcUrl: string = publicRpcUrl) {
  return createPublicClient({ chain: xrplEvmTestnet, transport: http(rpcUrl) })
}

export type ChainPublicClient = ReturnType<typeof createChainPublicClient>

/**
 * The minimal client surface the read helpers need. Any viem public client satisfies it, and
 * tests can inject one built on a mock transport. No wallet is ever required.
 */
export type ChainReader = Pick<PublicClient, "readContract" | "getBlockNumber">

let shared: ChainPublicClient | undefined

/** Shared browser-safe client on the public RPC (NEXT_PUBLIC_XRPL_EVM_RPC_URL or default). */
export function getPublicClient(): ChainPublicClient {
  if (!shared) shared = createChainPublicClient()
  return shared
}

/**
 * Wraps a connected EIP-1193 wallet (e.g. `window.ethereum`) as a viem WalletClient for the write
 * SDK. It does not request accounts, connect, or switch networks: pass the account the user
 * already connected. viem already sends transactions exactly once (it passes `retryCount: 0` for
 * eth_sendTransaction); this factory also sets `retryCount: 0` on the transport as defense in
 * depth against a future viem change. The trade-off is that wallet read requests are not retried.
 */
export function createWalletClientFromProvider(
  provider: EIP1193Provider,
  account: Address
) {
  return createWalletClient({
    account,
    chain: xrplEvmTestnet,
    transport: custom(provider, { retryCount: 0 }),
  })
}
