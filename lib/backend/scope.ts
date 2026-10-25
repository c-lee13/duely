import { activeDeployment } from "@/lib/chain/config"
import type { DeploymentScope } from "@/lib/shared/deployment-scope"

/**
 * The deployment this server process serves, resolved from DUELY_DEPLOYMENT on every call. Throws the SDK's
 * DeploymentConfigError (unknown key, server/browser mismatch, undeployed key) rather than falling back to another token.
 */
export function activeDeploymentScope(): DeploymentScope {
  const d = activeDeployment()
  return {
    chainId: d.chainId,
    contractAddress: d.invoiceAdvance.address.toLowerCase(),
    tokenAddress: d.token.address.toLowerCase(),
    key: d.key,
    symbol: d.token.symbol,
    decimals: d.token.decimals,
  }
}
