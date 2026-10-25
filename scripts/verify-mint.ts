/**
 * Read-only verification of an owner-signed dUSD mint. Sends nothing, needs no keys or passwords.
 *
 *   npm run chain:verify-mint -- <txHash> [--amount 100] [--wait 120]
 *
 * Checks the receipt (sender = token owner, destination = dUSD token, chain, exact calldata, a single
 * Transfer from 0x0 to the recipient), then waits for the RPC to reach the receipt block and reads the
 * recipient balance and total supply pinned at that block and the one before it.
 * Exit codes: 0 verified, 1 reverted or mismatch, 2 still pending, 3 confirmed but state check inconclusive.
 */
import { isAddress, isHex, size, type Hex } from "viem"

import {
  CHAIN_ID,
  contractAddresses,
  createChainPublicClient,
  formatDusd,
  parseDusd,
  publicRpcUrl,
  redactUrls,
  waitForBlock,
} from "../lib/chain/index"
import { verifyMint } from "./chain-integration/mint"

function env(name: string): string | undefined {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}

function address(name: string): `0x${string}` {
  const v = env(name)
  if (!v || !isAddress(v, { strict: true }))
    throw new Error(`${name} must be set to a valid address`)
  return v as `0x${string}`
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const hash = argv[0]
  if (!hash || !isHex(hash, { strict: true }) || size(hash) !== 32) {
    throw new Error(
      "usage: chain:verify-mint -- <txHash> [--amount 100] [--wait 120]"
    )
  }
  let amountDusd = "100"
  let waitSeconds = 120
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--amount") amountDusd = argv[++i] ?? ""
    else if (argv[i] === "--wait") waitSeconds = Number(argv[++i])
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  const amount = parseDusd(amountDusd)
  if (amount <= BigInt(0)) throw new Error("--amount must be greater than zero")
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0)
    throw new Error("--wait must be a number of seconds")

  if (Number(env("CHAIN_ID")) !== CHAIN_ID)
    throw new Error(`CHAIN_ID must be ${CHAIN_ID}`)
  const token = address("TOKEN_ADDRESS")
  if (token.toLowerCase() !== contractAddresses.paymentToken.toLowerCase()) {
    throw new Error("TOKEN_ADDRESS differs from the deployment manifest")
  }
  const expected = {
    chainId: CHAIN_ID,
    token,
    owner: address("DEPLOYER_ADDRESS"),
    recipient: address("CLIENT_ADDRESS"),
    amount,
  }
  const client = createChainPublicClient(
    env("XRPL_EVM_RPC_URL") ?? publicRpcUrl
  )

  // Give a just-sent transaction time to be mined before judging it.
  const deadline = Date.now() + waitSeconds * 1000
  for (;;) {
    try {
      await client.getTransactionReceipt({ hash: hash as Hex })
      break
    } catch {
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 2_000))
    }
  }

  const result = await verifyMint(client, hash as Hex, expected, {
    waitForBlock: (b) => waitForBlock(b, { client, timeoutMs: 30_000 }),
    attempts: 3,
  })

  console.log(`== Mint verification: ${result.verdict.toUpperCase()} ==`)
  console.log(`tx        : ${result.hash}`)
  if (result.explorerUrl) console.log(`explorer  : ${result.explorerUrl}`)
  if (result.blockNumber !== undefined)
    console.log(
      `block     : ${result.blockNumber}${result.gasUsed !== undefined ? `   gas used ${result.gasUsed}` : ""}`
    )
  console.log(
    `expected  : owner ${expected.owner} mints ${formatDusd(amount)} dUSD (${amount} base units) to ${expected.recipient}`
  )
  for (const c of result.checks)
    console.log(`  [${c.ok ? " ok " : "FAIL"}] ${c.name}: ${c.detail}`)
  if (result.balances) {
    console.log(
      `recipient balance : ${formatDusd(result.balances.before)} -> ${formatDusd(result.balances.after)} dUSD (pinned at blocks ${result.blockNumber! - BigInt(1)} and ${result.blockNumber})`
    )
    console.log(
      `total supply      : ${formatDusd(result.supply!.before)} -> ${formatDusd(result.supply!.after)} dUSD`
    )
  }
  console.log(result.message)
  return { verified: 0, reverted: 1, mismatch: 1, pending: 2, inconclusive: 3 }[
    result.verdict
  ]
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(
      redactUrls(error instanceof Error ? error.message : String(error))
    )
    process.exitCode = 1
  }
)
