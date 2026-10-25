/**
 * Live integration test of the lib/chain SDK against the deployed XRPL EVM Testnet contracts.
 *
 *   npm run chain:integration                      read-only preflight (default; sends nothing)
 *   npm run chain:integration -- --check-signers   preflight + prove the keystores match
 *   npm run chain:integration -- --execute         broadcast the run (asks for confirmation)
 *
 * Creates a NEW invoice and drives it through create -> approve -> fund -> advance -> settle using
 * only the SDK's public write and lifecycle APIs. It never mints or transfers funds to test
 * wallets, never retries a state-changing transaction, and stops at the first transaction that is
 * not confirmed with its expected event. Keys come from Foundry keystores decrypted in memory;
 * no key, password or authenticated RPC URL is ever printed or written.
 */
import {
  contractAddresses,
  createChainPublicClient,
  redactUrls,
} from "../lib/chain/index"
import { USAGE, parseArgs } from "./chain-integration/args"
import {
  dusd,
  execute,
  line,
  loadConfig,
  loadSigners,
  preflight,
  printPreflight,
} from "./chain-integration/flow"

// ---- main ---------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    line(USAGE)
    return 0
  }
  const cfg = loadConfig()
  const client = createChainPublicClient(cfg.rpcUrl)
  const pre = await preflight(cfg, args, client)
  printPreflight(cfg, args, pre)

  const failed = pre.checks.filter((c) => !c.ok)
  const plan = pre.plan

  if (args.mode === "preflight") {
    if (args.checkSigners && plan) {
      const needed = (["client", "evaluator", "operator"] as const).filter(
        (s) => plan.txCountBySigner[s] > 0
      )
      const accounts = await loadSigners(cfg, needed)
      for (const [signer, account] of accounts)
        line(
          `[ ok ] keystore ${cfg.keystoreName[signer]} -> ${account.address} (${signer})`
        )
      line()
    }
    if (failed.length === 0) {
      line("READY: every check passed. To broadcast:")
      line(
        `  npm run chain:integration -- --execute --amount ${args.amountDusd}`
      )
      return 0
    }
    line(`NOT READY: ${failed.length} check(s) failed.`)
    if (plan && plan.blockers.some((b) => b.includes("never mints"))) {
      const short = plan.amount - pre.snapshot!.clientDusd
      line(
        "The dUSD token owner (deployer keystore) must fund the client first, e.g. in contracts/:"
      )
      line(
        `  cast send ${contractAddresses.paymentToken} "mint(address,uint256)" ${cfg.addresses.client} ${short} --account ${cfg.keystoreName.operator} --rpc-url xrpl_evm_testnet`
      )
      line(
        `  (${short} base units = ${dusd(short)}; this script will not do it for you)`
      )
    }
    return 1
  }

  if (failed.length > 0 || !plan) {
    line(`Refusing to broadcast: ${failed.length} preflight check(s) failed.`)
    return 1
  }
  return execute(cfg, args, client, pre)
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
