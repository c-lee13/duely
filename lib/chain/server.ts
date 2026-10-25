import "server-only"

import { createWalletClient, http, type Account } from "viem"

import { createChainPublicClient, type ChainPublicClient } from "./client"
import { publicRpcUrl, xrplEvmTestnet } from "./config"

/**
 * RPC URL for server-side reads and the privileged signer (A7). Prefers the authenticated
 * provider URL (QuickNode) in XRPL_EVM_RPC_URL, falling back to the public RPC. Importing this
 * module from a client component fails the build. Never log or return this value to the browser.
 */
export function getServerRpcUrl(): string {
  return process.env.XRPL_EVM_RPC_URL || publicRpcUrl
}

let sharedServerClient: ChainPublicClient | undefined

/** Read-only client on the server RPC. Pass it as `{ client }` to the helpers in ./reads. */
export function getServerPublicClient(): ChainPublicClient {
  if (!sharedServerClient) {
    sharedServerClient = createChainPublicClient(getServerRpcUrl())
  }
  return sharedServerClient
}

/**
 * Wallet client for a privileged server-side signer (A7: the evaluator for `approveAdvance`, or
 * the operator). The caller supplies the viem `Account` (from an env-held key, KMS, etc.); this
 * module never reads or stores private keys. Retries are disabled so a non-idempotent write is
 * never resent. Use only inside protected server code.
 */
export function createServerWalletClient(account: Account) {
  return createWalletClient({
    account,
    chain: xrplEvmTestnet,
    transport: http(getServerRpcUrl(), { retryCount: 0 }),
  })
}
