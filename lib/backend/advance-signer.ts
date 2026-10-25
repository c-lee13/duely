import "server-only"
import { privateKeyToAccount } from "viem/accounts"
import {
  ChainWriteError,
  approveAdvance,
  hasRole,
  type ChainWalletClient,
  type ChainWriteClient,
} from "@/lib/chain"
import { activeDeployment } from "@/lib/chain/config"
import { createServerWalletClient, getServerPublicClient } from "@/lib/chain/server"
import type { Address, Bytes32 } from "@/lib/frontend/domain"
import { invoiceInScope, type DeploymentScope } from "@/lib/shared/deployment-scope"
import { ChainScopeError, ChainUnavailableError, unavailableSigner, type AdvanceSigner } from "./ports"

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/
const lower = (s: string) => s.toLowerCase()

/**
 * The protected platform signer: the EVALUATOR_ROLE account that calls `approveAdvance`. Server-only (importing this from
 * client code fails the build). The private key is read from EVALUATOR_PRIVATE_KEY ONCE, turned into a viem account, and
 * is never stored on an object that is returned, logged, put in an error message or sent to the browser.
 *
 * Safety rules enforced here, in addition to the SDK's own simulation:
 *  - the key must belong to THIS deployment's evaluator address (a wrong or swapped key makes the signer unavailable);
 *  - the invoice reference must belong to THIS deployment (chain + InvoiceAdvance);
 *  - the account must hold EVALUATOR_ROLE on-chain right now;
 *  - the SDK simulates the call first (so a state/role revert never broadcasts) and blocks identical in-process duplicates;
 *  - nothing is retried, and the signer never reports confirmation: it returns the hash only.
 */
export function createSignerFromWallet(opts: {
  wallet: ChainWalletClient
  address: Address
  publicClient: ChainWriteClient
  scope: DeploymentScope
}): AdvanceSigner {
  const { wallet, address, publicClient, scope } = opts
  return {
    available: true,
    address,
    async submitApproveAdvance(ref, evaluationHash: Bytes32) {
      if (ref.chainId === 0 || !invoiceInScope({ chain_id: ref.chainId, contract_address: ref.contractAddress }, scope)) {
        throw new ChainScopeError()
      }
      if (!(await hasRole("evaluator", address, { client: publicClient }))) {
        throw new Error("The configured signer does not hold EVALUATOR_ROLE on this deployment.")
      }
      try {
        const submitted = await approveAdvance(ref.invoiceId, evaluationHash, { wallet, publicClient })
        return { txHash: submitted.hash as Bytes32, from: address.toLowerCase() as Address }
      } catch (e) {
        // ChainWriteError messages are already sanitized (no RPC URLs, no keys); keep the code for diagnosis.
        if (e instanceof ChainWriteError) throw new Error(`approveAdvance not sent (${e.code}): ${e.message}`)
        throw new Error("approveAdvance not sent")
      }
    },
  }
}

/**
 * Builds the signer from EVALUATOR_PRIVATE_KEY. With no key, a malformed key, or a key that is not this deployment's
 * evaluator, the result is the explicit "unavailable" signer, so advances answer 503 INTEGRATION_UNAVAILABLE. It never
 * falls back to another account, to a mock signer, or to the browser.
 */
export function createEvaluatorSignerFromEnv(
  scope: DeploymentScope,
  env: Record<string, string | undefined> = process.env,
  overrides: { publicClient?: ChainWriteClient; walletFor?: (account: ReturnType<typeof privateKeyToAccount>) => ChainWalletClient } = {}
): AdvanceSigner {
  const key = env.EVALUATOR_PRIVATE_KEY?.trim()
  if (!key || !PRIVATE_KEY.test(key)) return unavailableSigner
  let account: ReturnType<typeof privateKeyToAccount>
  try {
    account = privateKeyToAccount(key as `0x${string}`)
  } catch {
    return unavailableSigner
  }
  const expected = activeDeployment().roles.evaluator
  if (lower(account.address) !== lower(expected)) return unavailableSigner
  const publicClient = overrides.publicClient ?? (getServerPublicClient() as unknown as ChainWriteClient)
  const wallet = (overrides.walletFor ? overrides.walletFor(account) : createServerWalletClient(account)) as unknown as ChainWalletClient
  return createSignerFromWallet({ wallet, address: account.address as Address, publicClient, scope })
}

/** Why the signer is unavailable, without revealing anything about the key. For diagnostics endpoints and docs. */
export function describeSignerAvailability(env: Record<string, string | undefined> = process.env): "ready-to-check" | "no-key" | "malformed-key" | "wrong-account" {
  const key = env.EVALUATOR_PRIVATE_KEY?.trim()
  if (!key) return "no-key"
  if (!PRIVATE_KEY.test(key)) return "malformed-key"
  try {
    const a = privateKeyToAccount(key as `0x${string}`)
    return lower(a.address) === lower(activeDeployment().roles.evaluator) ? "ready-to-check" : "wrong-account"
  } catch {
    return "malformed-key"
  }
}

export { ChainUnavailableError }
