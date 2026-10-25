import type { Abi } from "viem"

import { getActiveDeployment, type DeploymentInfo } from "./deployments"
import { ChainWriteError } from "./errors"
import { invoiceAdvanceAbi } from "./generated"
import { duelyVaultAbi } from "./generated/duelyVaultAbi"
import { invoiceAdvanceV2Abi } from "./generated/invoiceAdvanceV2Abi"

/**
 * Protocol selection helpers. The deployment key decides the protocol (see ./deployments): "dusd" and
 * "rlusd" are v1 (operator reserve), "v2" is the DuelyVault-funded InvoiceAdvanceV2. Browser-safe.
 */

export type HexAddress = `0x${string}`

export function activeProtocol(): DeploymentInfo["protocol"] {
  return getActiveDeployment().protocol
}

export function isV2(): boolean {
  return activeProtocol() === "v2"
}

/** ABI of the escrow contract (`contractAddresses.invoiceAdvance`) under the active protocol. */
export function escrowAbi(): Abi {
  return (isV2() ? invoiceAdvanceV2Abi : invoiceAdvanceAbi) as Abi
}

/** The DuelyVault address, or a clear error when the active deployment has no vault (v1). */
export function vaultAddress(): HexAddress {
  const vault = getActiveDeployment().vault
  if (!vault) {
    throw new ChainWriteError(
      "INVALID_INPUT",
      "the active deployment has no DuelyVault; select the v2 deployment (DUELY_DEPLOYMENT=v2)"
    )
  }
  return vault.address as HexAddress
}

export function vaultInfo(): NonNullable<DeploymentInfo["vault"]> | null {
  return getActiveDeployment().vault ?? null
}

export { duelyVaultAbi, invoiceAdvanceV2Abi }
