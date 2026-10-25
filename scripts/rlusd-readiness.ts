/**
 * Read-only readiness check for deploying InvoiceAdvance against RLUSD (A6.6.4). It needs no
 * InvoiceAdvance (none exists yet), sends nothing and asks for no passwords:
 *
 *   npm run chain:rlusd-readiness
 *
 * It confirms the registered RLUSD token is what the chain reports, that it is not paused, that the
 * test wallets hold what the plan needs (the invoice, the reserve target, gas), and that the
 * addresses the deployment would use are distinct and well formed.
 */
import {
  createChainPublicClient,
  getRegisteredToken,
  paymentTokenAbi,
  redactUrls,
  tokenPauseAbi,
} from "../lib/chain/index"
import { formatTokenUnits, parseTokenUnits } from "../lib/chain/amounts"
import {
  DEFAULT_AMOUNT_EXTERNAL,
  DEFAULT_RESERVE_TARGET_EXTERNAL,
} from "./chain-integration/args"
import { loadConfig, line } from "./chain-integration/flow"

const MIN_GAS_WEI = BigInt(10) ** BigInt(17) // 0.1 XRP per signer is ample for a handful of transactions

async function main(): Promise<number> {
  const cfg = loadConfig()
  const client = createChainPublicClient(cfg.rpcUrl)
  const token = getRegisteredToken("rlusd")
  const decimals = token.decimals
  const amount = parseTokenUnits(DEFAULT_AMOUNT_EXTERNAL, decimals, "RLUSD")
  const reserve = parseTokenUnits(
    DEFAULT_RESERVE_TARGET_EXTERNAL,
    decimals,
    "RLUSD"
  )
  const a = cfg.addresses
  let failed = 0
  const report = (ok: boolean, name: string, detail: string) => {
    if (!ok) failed += 1
    line(`[${ok ? " ok " : "FAIL"}] ${name}\n       ${detail}`)
  }
  const read = <T>(fn: string, args: readonly unknown[] = []) =>
    client.readContract({
      address: token.address,
      abi: paymentTokenAbi,
      functionName: fn,
      args,
    } as never) as Promise<T>

  line("== RLUSD deployment readiness (read-only) ==")
  const chainId = await client.getChainId()
  report(chainId === cfg.chainId, "RPC chain ID", String(chainId))
  const code = await client.getCode({ address: token.address })
  report(!!code && code !== "0x", "RLUSD contract code", token.address)

  const [name, symbol, dec] = await Promise.all([
    read<string>("name"),
    read<string>("symbol"),
    read<number>("decimals"),
  ])
  report(
    name === token.name && symbol === token.symbol && dec === decimals,
    "Token metadata matches the registry",
    `${name} (${symbol}), ${dec} decimals`
  )

  const paused = await client
    .readContract({
      address: token.address,
      abi: tokenPauseAbi,
      functionName: "paused",
    })
    .catch(() => undefined)
  report(
    paused === false,
    "Token is not paused",
    paused === undefined ? "paused() unavailable" : `paused() = ${paused}`
  )

  const need: [string, `0x${string}`, bigint][] = [
    ["client (invoice)", a.client, amount],
    ["operator (reserve deposit)", a.operator, reserve],
  ]
  for (const [label, address, min] of need) {
    const balance = await read<bigint>("balanceOf", [address])
    report(
      balance >= min,
      `${label} holds enough RLUSD`,
      `${formatTokenUnits(balance, decimals)} RLUSD, needs ${formatTokenUnits(min, decimals)}`
    )
  }
  const evaluatorBalance = await read<bigint>("balanceOf", [a.evaluator])
  report(
    true,
    "evaluator RLUSD (informational; it only signs)",
    `${formatTokenUnits(evaluatorBalance, decimals)} RLUSD`
  )

  for (const signer of ["operator", "client", "evaluator"] as const) {
    const gas = await client.getBalance({ address: a[signer] })
    report(
      gas >= MIN_GAS_WEI,
      `${signer} has gas`,
      `${gas} wei (want at least ${MIN_GAS_WEI})`
    )
  }
  report(
    new Set(Object.values(a).map((x) => x.toLowerCase())).size === 4,
    "client, evaluator, operator and freelancer are distinct",
    "loadConfig enforces this"
  )

  line()
  line(
    failed === 0
      ? "READY: nothing blocks the RLUSD deployment from the token side."
      : `NOT READY: ${failed} check(s) failed.`
  )
  return failed === 0 ? 0 : 1
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
