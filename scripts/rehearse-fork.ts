/**
 * Rehearses scripts/chain-integration.ts end to end on a LOCAL FORK of XRPL EVM Testnet, so the
 * real execute() path (plan, SDK writes, lifecycle tracking, stop-on-failure, accounting checks)
 * can be proven against the real contracts' logic before anything is sent to the live chain.
 *
 *   anvil --fork-url https://rpc.testnet.xrplevm.org --chain-id 1449000 --port 8560 --auto-impersonate
 *   npm run chain:rehearse -- --scenario normal      # 5 transactions
 *   npm run chain:rehearse -- --scenario topup       # 7 transactions (reserve too small)
 *   npm run chain:rehearse -- --scenario bad-evaluator   # must stop safely at the advance
 *
 * Safety: it only talks to 127.0.0.1:8560 and aborts unless that node answers `anvil_nodeInfo`
 * (which no live RPC does). The fork signs for impersonated addresses, so no keys are involved.
 * The setup it performs (minting dUSD as the token owner, withdrawing reserve as the operator)
 * exists only on the throwaway fork; the real script never does either.
 */
import { createWalletClient, http, type Address } from "viem"

import {
  contractAddresses,
  createChainPublicClient,
  getReserveBalance,
  getTokenBalance,
  invoiceAdvanceAbi,
  mockUsdcAbi,
  parseDusd,
  xrplEvmTestnet,
} from "../lib/chain/index"
import { parseArgs } from "./chain-integration/args"
import {
  execute,
  loadConfig,
  preflight,
  printPreflight,
} from "./chain-integration/flow"
import type { Signer } from "./chain-integration/plan"

const LOCAL = "http://127.0.0.1:8560"
type Scenario = "normal" | "topup" | "bad-evaluator"

function parseScenario(argv: string[]): { scenario: Scenario; rest: string[] } {
  const rest: string[] = []
  let scenario: Scenario = "normal"
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scenario") {
      const value = argv[++i]
      if (
        value !== "normal" &&
        value !== "topup" &&
        value !== "bad-evaluator"
      ) {
        throw new Error("--scenario must be normal, topup or bad-evaluator")
      }
      scenario = value
    } else rest.push(argv[i])
  }
  return { scenario, rest }
}

async function main(): Promise<number> {
  const { scenario, rest } = parseScenario(process.argv.slice(2))
  process.env.XRPL_EVM_RPC_URL = LOCAL // replaces whatever the env file held, before anything reads it
  const cfg = loadConfig()
  if (cfg.rpcUrl !== LOCAL)
    throw new Error("config did not pick up the local fork")
  const client = createChainPublicClient(LOCAL)

  try {
    await client.request({ method: "anvil_nodeInfo" } as never)
  } catch {
    throw new Error(
      `${LOCAL} is not an Anvil node. Start the fork first (see the header of this file). Refusing to continue.`
    )
  }
  console.log(
    `[rehearsal] local Anvil fork, chain ${await client.getChainId()}, block ${await client.getBlockNumber()}`
  )

  const args = parseArgs(["--execute", "--yes", ...rest])
  const wallet = (address: Address) =>
    createWalletClient({
      account: address, // JSON-RPC account: the fork signs for impersonated addresses
      chain: xrplEvmTestnet,
      transport: http(LOCAL, { retryCount: 0 }),
    })
  const send = async (hash: `0x${string}`) => {
    await client.waitForTransactionReceipt({ hash, timeout: 60_000 })
  }

  // ---- fork-only setup (never part of the real script) ----
  const { client: clientAddress, operator } = cfg.addresses
  const owner = (process.env.DEPLOYER_ADDRESS ?? operator) as Address
  if (scenario === "topup") {
    const keep = parseDusd("40")
    const reserve = await getReserveBalance({ client })
    if (reserve > keep) {
      await send(
        await wallet(operator).writeContract({
          address: contractAddresses.invoiceAdvance,
          abi: invoiceAdvanceAbi,
          functionName: "withdrawReserve",
          args: [reserve - keep],
        })
      )
      console.log(
        `[rehearsal] fork setup: operator withdrew reserve down to 40 dUSD`
      )
    }
  }
  const have = await getTokenBalance(clientAddress, { client })
  if (have < args.amount) {
    await send(
      await wallet(owner).writeContract({
        address: contractAddresses.paymentToken,
        abi: mockUsdcAbi,
        functionName: "mint",
        args: [clientAddress, args.amount - have],
      })
    )
    console.log(`[rehearsal] fork setup: token owner minted dUSD to the client`)
  }

  const pre = await preflight(cfg, args, client)
  printPreflight(cfg, args, pre)
  if (pre.checks.some((c) => !c.ok)) {
    console.log("[rehearsal] preflight not ready; not executing")
    return 2
  }
  const code = await execute(cfg, args, client, pre, {
    walletFor: (signer: Signer) =>
      wallet(
        cfg.addresses[
          scenario === "bad-evaluator" && signer === "evaluator"
            ? "client"
            : signer
        ]
      ),
  })
  const expected = scenario === "bad-evaluator" ? 1 : 0
  console.log(
    code === expected
      ? `\n[rehearsal] scenario "${scenario}" behaved as expected (exit ${code})`
      : `\n[rehearsal] scenario "${scenario}" did NOT behave as expected: exit ${code}, wanted ${expected}`
  )
  return code === expected ? 0 : 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
)
