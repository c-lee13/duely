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
 * RLUSD (the real token on the fork; its InvoiceAdvance is deployed on the fork only, because no
 * RLUSD contract exists on the live chain yet):
 *   npm run chain:rehearse -- --token rlusd --scenario normal         # reserve pre-funded by the operator
 *   npm run chain:rehearse -- --token rlusd --scenario topup          # empty reserve: deposit to the 5 RLUSD target
 *   npm run chain:rehearse -- --token rlusd --scenario bad-evaluator  # wrong signer: stops at the advance
 *   npm run chain:rehearse -- --token rlusd --scenario reuse          # two runs: fund once, reuse the reserve
 * RLUSD balances are whatever the live chain holds; nothing is minted or clawed back and no issuer
 * power is impersonated. The operator only deposits its own RLUSD.
 *
 * Safety: it only talks to 127.0.0.1:8560 and aborts unless that node answers `anvil_nodeInfo`
 * (which no live RPC does). The fork signs for impersonated addresses, so no keys are involved.
 * The setup it performs (minting dUSD as the token owner, withdrawing reserve as the operator)
 * exists only on the throwaway fork; the real script never does either.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { createWalletClient, http, type Address, type Hex } from "viem"

import {
  approveEscrowAllowance,
  contractAddresses,
  createChainPublicClient,
  depositReserve,
  getDeployment,
  getRegisteredToken,
  getReserveBalance,
  setDeploymentOverrideForTests,
  waitForConfirmation,
  getTokenBalance,
  invoiceAdvanceAbi,
  mockUsdcAbi,
  paymentTokenAbi,
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
type Scenario = "normal" | "topup" | "bad-evaluator" | "reuse"
type TokenChoice = "dusd" | "rlusd"

function parseScenario(argv: string[]): {
  scenario: Scenario
  token: TokenChoice
  rest: string[]
} {
  const rest: string[] = []
  let scenario: Scenario = "normal"
  let token: TokenChoice = "dusd"
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scenario") {
      const value = argv[++i]
      if (
        value !== "normal" &&
        value !== "topup" &&
        value !== "bad-evaluator" &&
        value !== "reuse"
      ) {
        throw new Error(
          "--scenario must be normal, topup or bad-evaluator (or reuse, with --token rlusd)"
        )
      }
      scenario = value
    } else if (argv[i] === "--token") {
      const value = argv[++i]
      if (value !== "dusd" && value !== "rlusd") {
        throw new Error("--token must be dusd or rlusd")
      }
      token = value
    } else rest.push(argv[i])
  }
  if (scenario === "reuse" && token !== "rlusd") {
    throw new Error("--scenario reuse needs --token rlusd")
  }
  return { scenario, token, rest }
}

async function main(): Promise<number> {
  const { scenario, token, rest } = parseScenario(process.argv.slice(2))
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

  const wallet = (address: Address) =>
    createWalletClient({
      account: address, // JSON-RPC account: the fork signs for impersonated addresses
      chain: xrplEvmTestnet,
      transport: http(LOCAL, { retryCount: 0 }),
    })
  const send = async (hash: `0x${string}`) => {
    await client.waitForTransactionReceipt({ hash, timeout: 60_000 })
  }

  if (token === "rlusd") {
    await deployRlusdOnFork(cfg.addresses, client, wallet)
  }
  const args = parseArgs(["--execute", "--yes", ...rest])

  // ---- fork-only setup (never part of the real script) ----
  const { client: clientAddress, operator } = cfg.addresses
  const owner = (process.env.DEPLOYER_ADDRESS ?? operator) as Address
  if (token === "rlusd") {
    await checkRlusdBalances(cfg.addresses, args, client)
    if (scenario !== "topup" && scenario !== "reuse") {
      // The operator funds the (new, empty) reserve with its own RLUSD, as it would before a live run.
      const target = args.reserveTarget ?? args.amount
      const ctx = { wallet: wallet(operator), publicClient: client }
      await waitForConfirmation(await approveEscrowAllowance(target, ctx), {
        publicClient: client,
      })
      await waitForConfirmation(await depositReserve(target, ctx), {
        publicClient: client,
      })
      console.log(
        `[rehearsal] fork setup: operator deposited ${args.reserveTargetText ?? args.amountDusd} RLUSD of its own into the reserve`
      )
    }
  } else if (scenario === "topup") {
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
  if (token === "dusd" && have < args.amount) {
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

  const walletFor = (signer: Signer) =>
    wallet(
      cfg.addresses[
        scenario === "bad-evaluator" && signer === "evaluator"
          ? "client"
          : signer
      ]
    )

  const runs = scenario === "reuse" ? 2 : 1
  let code = 0
  for (let run = 1; run <= runs; run++) {
    if (runs > 1) console.log(`\n[rehearsal] run ${run} of ${runs}`)
    const pre = await preflight(cfg, args, client)
    printPreflight(cfg, args, pre)
    if (pre.checks.some((c) => !c.ok)) {
      console.log("[rehearsal] preflight not ready; not executing")
      return 2
    }
    if (scenario === "reuse") {
      const deposit = pre.plan!.reserveDeposit
      const wantDeposit = run === 1
      if (wantDeposit !== deposit > BigInt(0)) {
        console.log(
          `[rehearsal] run ${run}: expected ${wantDeposit ? "a reserve deposit" : "no deposit (reserve reused)"}, plan has a deposit of ${deposit}`
        )
        return 1
      }
    }
    code = await execute(cfg, args, client, pre, { walletFor })
    if (code !== 0) break
  }
  const expected = scenario === "bad-evaluator" ? 1 : 0
  console.log(
    code === expected
      ? `\n[rehearsal] scenario "${scenario}" behaved as expected (exit ${code})`
      : `\n[rehearsal] scenario "${scenario}" did NOT behave as expected: exit ${code}, wanted ${expected}`
  )
  return code === expected ? 0 : 1
}

/**
 * Fork only: deploys InvoiceAdvance against the REAL RLUSD token (no RLUSD contract exists on the
 * live chain yet) and points the SDK at it. Mirrors Deploy.s.sol's external-token path: admin and
 * operator are the operator address, the evaluator is separate.
 */
async function deployRlusdOnFork(
  addresses: { operator: Address; evaluator: Address },
  client: ReturnType<typeof createChainPublicClient>,
  wallet: (address: Address) => ReturnType<typeof createWalletClient>
): Promise<void> {
  const rlusd = getRegisteredToken("rlusd")
  const [decimals, symbol] = await Promise.all([
    client.readContract({
      address: rlusd.address,
      abi: paymentTokenAbi,
      functionName: "decimals",
    }),
    client.readContract({
      address: rlusd.address,
      abi: paymentTokenAbi,
      functionName: "symbol",
    }),
  ])
  if (decimals !== rlusd.decimals || symbol !== rlusd.symbol) {
    throw new Error(
      `the token at ${rlusd.address} reports ${symbol}/${decimals}, not the registered RLUSD`
    )
  }
  const artifact = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          "../contracts/out/InvoiceAdvance.sol/InvoiceAdvance.json",
          import.meta.url
        )
      ),
      "utf8"
    )
  ) as { abi: never; bytecode: { object: Hex } }
  const hash = await wallet(addresses.operator).deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [
      rlusd.address,
      addresses.operator,
      addresses.operator,
      addresses.evaluator,
    ],
  } as never)
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout: 60_000,
  })
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error("InvoiceAdvance deployment on the fork failed")
  }
  setDeploymentOverrideForTests({
    ...getDeployment("dusd"),
    key: "rlusd",
    sourceCommit: "local-fork",
    invoiceAdvance: {
      address: receipt.contractAddress,
      deployTxHash: hash,
      deployBlock: Number(receipt.blockNumber),
    },
    token: rlusd,
    roles: {
      admin: addresses.operator,
      operator: addresses.operator,
      evaluator: addresses.evaluator,
    },
  })
  // The .env of a dUSD setup names dUSD contracts; they would be flagged against the RLUSD fixture.
  for (const name of [
    "NEXT_PUBLIC_CONTRACT_ADDRESS",
    "NEXT_PUBLIC_TOKEN_ADDRESS",
    "CONTRACT_ADDRESS",
    "TOKEN_ADDRESS",
  ]) {
    delete process.env[name]
  }
  console.log(
    `[rehearsal] fork setup: InvoiceAdvance for the real RLUSD deployed on the fork only at ${receipt.contractAddress}`
  )
}

/** Fork only: the run needs the balances the live chain already holds; it never creates any. */
async function checkRlusdBalances(
  addresses: { client: Address; operator: Address },
  args: { amount: bigint; reserveTarget?: bigint },
  client: ReturnType<typeof createChainPublicClient>
): Promise<void> {
  const [clientBalance, operatorBalance] = await Promise.all([
    getTokenBalance(addresses.client, { client }),
    getTokenBalance(addresses.operator, { client }),
  ])
  const needOperator = args.reserveTarget ?? args.amount
  if (clientBalance < args.amount || operatorBalance < needOperator) {
    throw new Error(
      `the fork inherits the live RLUSD balances (client ${clientBalance}, operator ${operatorBalance} base units), which are too low for this run; the rehearsal will not create RLUSD`
    )
  }
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
