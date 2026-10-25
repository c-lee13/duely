import { deployments as generatedV1 } from "./generated/deployments"
import { deploymentV2 } from "./generated/deploymentV2"

/**
 * Deployment selection. One SDK, several payment-token deployments (InvoiceAdvance has an
 * immutable payment token, so each token needs its own contract). Selection is by configuration:
 *
 *   DUELY_DEPLOYMENT              server / scripts   "dusd" (default) | "rlusd" | "v2"
 *   NEXT_PUBLIC_DUELY_DEPLOYMENT  browser bundle     same values; must agree with the server value
 *
 * "v2" is the vault-funded protocol (DuelyVault + InvoiceAdvanceV2, RLUSD). Its escrow lives in
 * `invoiceAdvance.address` so scoping, explorer links and token display work unchanged; the
 * `protocol` field tells the SDK which ABI and event set to use, and `vault` holds DuelyVault.
 *
 * Unknown keys, a server/browser disagreement and selecting a deployment that has no InvoiceAdvance
 * yet all throw `DeploymentConfigError`. Nothing ever falls back silently to another token.
 */

export type DeploymentKey = "dusd" | "rlusd" | "v2"
export const DEPLOYMENT_KEYS: readonly DeploymentKey[] = ["dusd", "rlusd", "v2"]

/** v1: operator-reserve InvoiceAdvance. v2: DuelyVault-funded InvoiceAdvanceV2 with pull payments. */
export type DeploymentProtocol = "v1" | "v2"
export const DEFAULT_DEPLOYMENT_KEY: DeploymentKey = "dusd"

type Hex = `0x${string}`

export type PaymentTokenKind = "mock" | "external"

export interface DeploymentToken {
  address: Hex
  name: string
  symbol: string
  decimals: number
  /** True only for mock tokens. Never present a demo token as USDC or RLUSD. */
  isDemoToken: boolean
  kind: PaymentTokenKind
}

export interface DeploymentRoles {
  admin: Hex
  operator: Hex
  evaluator: Hex
}

export interface DeploymentInfo {
  key: DeploymentKey
  protocol: DeploymentProtocol
  /** DuelyVault (ERC-4626 LP vault). Present only for the v2 protocol. */
  vault?: {
    address: Hex
    deployTxHash: Hex
    deployBlock: number
    shareSymbol: string
    shareDecimals: number
  }
  chainId: number
  network: string
  explorer: string
  sourceCommit: string
  invoiceAdvance: {
    address: Hex
    deployTxHash: Hex
    deployBlock: number
  }
  token: DeploymentToken
  roles: DeploymentRoles
}

export type DeploymentConfigErrorCode =
  "UNKNOWN_DEPLOYMENT" | "DEPLOYMENT_MISMATCH" | "DEPLOYMENT_NOT_DEPLOYED"

export class DeploymentConfigError extends Error {
  readonly code: DeploymentConfigErrorCode
  constructor(code: DeploymentConfigErrorCode, message: string) {
    super(message)
    this.name = "DeploymentConfigError"
    this.code = code
  }
}

interface GeneratedEntry {
  key: string
  status: string
  token: DeploymentToken
}

/** The v2 manifest reshaped into the registry-entry form every other deployment uses. */
const v2Entry = {
  key: "v2",
  status: "deployed",
  chainId: deploymentV2.chainId,
  network: deploymentV2.network,
  explorer: deploymentV2.explorer,
  sourceCommit: deploymentV2.sourceCommit,
  protocol: "v2" as const,
  invoiceAdvance: {
    address: deploymentV2.contracts.invoiceAdvanceV2.address,
    deployTxHash: deploymentV2.contracts.invoiceAdvanceV2.deployTxHash,
    deployBlock: deploymentV2.contracts.invoiceAdvanceV2.deployBlock,
  },
  vault: {
    address: deploymentV2.contracts.duelyVault.address,
    deployTxHash: deploymentV2.contracts.duelyVault.deployTxHash,
    deployBlock: deploymentV2.contracts.duelyVault.deployBlock,
    shareSymbol: deploymentV2.contracts.duelyVault.shareToken.symbol,
    shareDecimals: deploymentV2.contracts.duelyVault.shareToken.decimals,
  },
  token: {
    address: deploymentV2.contracts.paymentToken.address,
    name: deploymentV2.contracts.paymentToken.name,
    symbol: deploymentV2.contracts.paymentToken.symbol,
    decimals: deploymentV2.contracts.paymentToken.decimals,
    isDemoToken: deploymentV2.contracts.paymentToken.isDemoToken,
    kind: "external" as const,
  },
  roles: {
    admin: deploymentV2.roles.admin,
    operator: deploymentV2.roles.operator,
    evaluator: deploymentV2.roles.evaluator,
  },
}

function registryEntry(key: DeploymentKey): unknown {
  return key === "v2" ? v2Entry : generatedV1[key]
}

function isDeployed(entry: GeneratedEntry): boolean {
  return entry.status === "deployed"
}

/** Parses a configured key. Empty/undefined -> default. Anything else must match exactly. */
export function parseDeploymentKey(raw: string | undefined): DeploymentKey {
  if (raw === undefined || raw === "") return DEFAULT_DEPLOYMENT_KEY
  if ((DEPLOYMENT_KEYS as readonly string[]).includes(raw)) {
    return raw as DeploymentKey
  }
  throw new DeploymentConfigError(
    "UNKNOWN_DEPLOYMENT",
    `unknown deployment "${raw}": expected one of ${DEPLOYMENT_KEYS.join(", ")}`
  )
}

/**
 * The configured key. `process.env.NEXT_PUBLIC_*` must be a static member access for Next.js to
 * inline it into the browser bundle, so both variables are read literally.
 */
export function configuredDeploymentKey(): DeploymentKey {
  const server = process.env.DUELY_DEPLOYMENT
  const browser = process.env.NEXT_PUBLIC_DUELY_DEPLOYMENT
  const serverKey = server ? parseDeploymentKey(server) : undefined
  const browserKey = browser ? parseDeploymentKey(browser) : undefined
  if (serverKey && browserKey && serverKey !== browserKey) {
    throw new DeploymentConfigError(
      "DEPLOYMENT_MISMATCH",
      `DUELY_DEPLOYMENT=${serverKey} disagrees with NEXT_PUBLIC_DUELY_DEPLOYMENT=${browserKey}; set them to the same value`
    )
  }
  return serverKey ?? browserKey ?? DEFAULT_DEPLOYMENT_KEY
}

/** Turns a registry entry into a usable deployment, or explains why it cannot be used yet. */
export function deploymentFromEntry(
  key: DeploymentKey,
  entry: unknown
): DeploymentInfo {
  const e = entry as GeneratedEntry &
    Omit<DeploymentInfo, "key" | "token" | "protocol"> & {
      protocol?: DeploymentProtocol
    }
  if (!isDeployed(e)) {
    throw new DeploymentConfigError(
      "DEPLOYMENT_NOT_DEPLOYED",
      `deployment "${key}" has no InvoiceAdvance contract yet (token ${e.token.symbol} is registered, but nothing is deployed). ` +
        `Deploy it and add its manifest, or select another deployment`
    )
  }
  return { ...e, key, protocol: e.protocol ?? "v1", token: e.token }
}

function toInfo(key: DeploymentKey): DeploymentInfo {
  return deploymentFromEntry(key, registryEntry(key))
}

/** Whether a deployment has an InvoiceAdvance contract (selectable) or is only registered. */
export function isDeploymentAvailable(key: DeploymentKey): boolean {
  return isDeployed(registryEntry(key) as GeneratedEntry)
}

/** Registered token metadata, available even before an InvoiceAdvance exists. */
export function getRegisteredToken(key: DeploymentKey): DeploymentToken {
  return (registryEntry(key) as GeneratedEntry).token
}

/** A specific deployment, regardless of configuration. Throws if it is not deployed. */
export function getDeployment(key: DeploymentKey): DeploymentInfo {
  return toInfo(parseDeploymentKey(key))
}

let override: DeploymentInfo | null = null

/** Test seam: pin the active deployment (e.g. to a fixture). Pass null to clear. */
export function setDeploymentOverrideForTests(
  info: DeploymentInfo | null
): void {
  override = info
}

/** The deployment selected by configuration, resolved on every call. */
export function getActiveDeployment(): DeploymentInfo {
  return override ?? toInfo(configuredDeploymentKey())
}

/**
 * Which deployment a transaction belongs to. Stored with serialized transactions so one that was
 * submitted under dUSD can never be tracked, or reported as confirmed, under RLUSD (and vice versa).
 */
export interface DeploymentIdentity {
  key: DeploymentKey
  invoiceAdvance: Hex
  paymentToken: Hex
}

export function activeDeploymentIdentity(): DeploymentIdentity {
  const d = getActiveDeployment()
  return {
    key: d.key,
    invoiceAdvance: d.invoiceAdvance.address,
    paymentToken: d.token.address,
  }
}

/** Describes how `identity` differs from the active deployment, or null if it matches. */
export function deploymentIdentityMismatch(
  identity: DeploymentIdentity
): string | null {
  const active = activeDeploymentIdentity()
  if (identity.key !== active.key) {
    return `it belongs to deployment "${identity.key}" but the active deployment is "${active.key}"`
  }
  if (
    identity.invoiceAdvance.toLowerCase() !==
      active.invoiceAdvance.toLowerCase() ||
    identity.paymentToken.toLowerCase() !== active.paymentToken.toLowerCase()
  ) {
    return `its contract addresses differ from the active "${active.key}" deployment`
  }
  return null
}
