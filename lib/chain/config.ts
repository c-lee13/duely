import { deployment } from "./generated/deployment"

/**
 * XRPL EVM Testnet configuration. Browser-safe: it only references public values.
 * Deployed addresses come from contracts/deployments/xrpl-evm-testnet.json via
 * ./generated/deployment (regenerate with `node contracts/script/export-abi.mjs`).
 * The authenticated QuickNode URL (XRPL_EVM_RPC_URL) lives only in ./server.
 */

// TODO(integration owner): replace with `Address` from lib/shared/types.ts once published.
export type HexAddress = `0x${string}`

/** Public, unauthenticated testnet RPC (docs.xrplevm.org). Safe for the browser. */
export const DEFAULT_PUBLIC_RPC_URL = "https://rpc.testnet.xrplevm.org"

/** NEXT_PUBLIC_XRPL_EVM_RPC_URL overrides the default; must never be an authenticated URL. */
export const publicRpcUrl: string =
  process.env.NEXT_PUBLIC_XRPL_EVM_RPC_URL || DEFAULT_PUBLIC_RPC_URL

/** Shape-compatible with viem's `Chain` and wagmi's chain config. */
export const xrplEvmTestnet = {
  id: deployment.chainId,
  name: "XRPL EVM Testnet",
  nativeCurrency: { name: "XRP", symbol: "XRP", decimals: 18 },
  rpcUrls: { default: { http: [publicRpcUrl] } },
  blockExplorers: {
    default: { name: "XRPL EVM Explorer", url: deployment.explorer },
  },
  testnet: true,
} as const

export const CHAIN_ID = deployment.chainId

export const contractAddresses = {
  invoiceAdvance: deployment.contracts.invoiceAdvance.address as HexAddress,
  paymentToken: deployment.contracts.paymentToken.address as HexAddress,
} as const

/** Demo token metadata. It is a mock: never present it as USDC or RLUSD. */
export const paymentTokenInfo = {
  name: deployment.contracts.paymentToken.name,
  symbol: deployment.contracts.paymentToken.symbol,
  decimals: deployment.contracts.paymentToken.decimals,
  isDemoToken: deployment.contracts.paymentToken.isDemoToken,
} as const

const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * Explorer links. Inputs are validated so a malformed value (user-supplied or from storage)
 * cannot alter the link path or query. The strict variants throw TypeError on bad input; the
 * `try*` variants return null, which is what a render path should use.
 */
export function explorerTxUrl(txHash: string): string {
  if (typeof txHash !== "string" || !TX_HASH.test(txHash)) {
    throw new TypeError(
      "explorerTxUrl: expected a 32-byte hex transaction hash"
    )
  }
  return `${deployment.explorer}/tx/${txHash}`
}

export function explorerAddressUrl(address: string): string {
  if (typeof address !== "string" || !ADDRESS.test(address)) {
    throw new TypeError("explorerAddressUrl: expected a 20-byte hex address")
  }
  return `${deployment.explorer}/address/${address}`
}

export function explorerBlockUrl(blockNumber: bigint | number): string {
  if (
    typeof blockNumber === "number" &&
    (!Number.isSafeInteger(blockNumber) || blockNumber < 0)
  ) {
    throw new TypeError("explorerBlockUrl: expected a non-negative integer")
  }
  const n = BigInt(blockNumber)
  if (n < BigInt(0)) {
    throw new TypeError("explorerBlockUrl: expected a non-negative integer")
  }
  return `${deployment.explorer}/block/${n.toString(10)}`
}

export function tryExplorerTxUrl(txHash: string): string | null {
  return typeof txHash === "string" && TX_HASH.test(txHash)
    ? explorerTxUrl(txHash)
    : null
}

export function tryExplorerAddressUrl(address: string): string | null {
  return typeof address === "string" && ADDRESS.test(address)
    ? explorerAddressUrl(address)
    : null
}

/**
 * Diagnostic only: lists NEXT_PUBLIC_* values that disagree with the deployment manifest.
 * The manifest always wins; these env vars never override addresses.
 */
export function getChainEnvIssues(): string[] {
  const issues: string[] = []
  const chainId = process.env.NEXT_PUBLIC_XRPL_EVM_CHAIN_ID
  if (chainId && Number(chainId) !== CHAIN_ID) {
    issues.push(`NEXT_PUBLIC_XRPL_EVM_CHAIN_ID=${chainId} != ${CHAIN_ID}`)
  }
  const contract = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS
  if (
    contract &&
    contract.toLowerCase() !== contractAddresses.invoiceAdvance.toLowerCase()
  ) {
    issues.push(
      "NEXT_PUBLIC_CONTRACT_ADDRESS does not match the deployment manifest"
    )
  }
  const token = process.env.NEXT_PUBLIC_TOKEN_ADDRESS
  if (
    token &&
    token.toLowerCase() !== contractAddresses.paymentToken.toLowerCase()
  ) {
    issues.push(
      "NEXT_PUBLIC_TOKEN_ADDRESS does not match the deployment manifest"
    )
  }
  return issues
}
