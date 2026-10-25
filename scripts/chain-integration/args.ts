import { parseDusd } from "../../lib/chain/amounts"

export interface Args {
  /** preflight (default) is strictly read-only; execute broadcasts transactions. */
  mode: "preflight" | "execute"
  /** In preflight, also decrypt the keystores (prompts for passwords) to prove they match. */
  checkSigners: boolean
  /** Invoice amount in base units. */
  amount: bigint
  /** The amount as typed (human dUSD), for display. */
  amountDusd: string
  /** Skip the final interactive confirmation before broadcasting. */
  yes: boolean
  /** Write a JSON run report (no credentials) to this path. */
  reportPath?: string
  help: boolean
}

export const DEFAULT_AMOUNT_DUSD = "100"
/** Guard against typos: this is a test, not a payment. */
export const MAX_AMOUNT_DUSD = "1000"

export const USAGE = `Usage: node scripts/chain-integration.ts [options]

Exercises the lib/chain SDK against the deployed XRPL EVM Testnet contracts with a NEW invoice:
create -> approve -> fund -> (reserve top-up if needed) -> advance -> settle.

Default mode is a read-only preflight: it sends nothing and needs no passwords.

Options:
  --execute            Broadcast the transactions (otherwise preflight only)
  --yes                With --execute: skip the final "type BROADCAST" confirmation
  --check-signers      In preflight, decrypt the keystores and verify their addresses
  --amount <dUSD>      Invoice amount in demo USD (default ${DEFAULT_AMOUNT_DUSD}, max ${MAX_AMOUNT_DUSD})
  --report <path>      Write a JSON report of the run (no credentials)
  --help               Show this help
`

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: "preflight",
    checkSigners: false,
    amount: BigInt(0),
    amountDusd: DEFAULT_AMOUNT_DUSD,
    yes: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    switch (flag) {
      case "--execute":
        args.mode = "execute"
        break
      case "--yes":
        args.yes = true
        break
      case "--check-signers":
        args.checkSigners = true
        break
      case "--help":
      case "-h":
        args.help = true
        break
      case "--amount":
      case "--report": {
        const value = argv[++i]
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`${flag} needs a value`)
        }
        if (flag === "--amount") args.amountDusd = value
        else args.reportPath = value
        break
      }
      default:
        throw new Error(`unknown argument: ${flag}`)
    }
  }
  if (args.yes && args.mode !== "execute") {
    throw new Error("--yes only makes sense together with --execute")
  }
  if (args.checkSigners && args.mode === "execute") {
    throw new Error(
      "--check-signers is a preflight option; --execute always verifies signers"
    )
  }

  try {
    args.amount = parseDusd(args.amountDusd)
  } catch {
    throw new Error(
      `--amount must be a positive dUSD amount with at most 6 decimals, got "${args.amountDusd}"`
    )
  }
  if (args.amount <= BigInt(0))
    throw new Error("--amount must be greater than zero")
  if (args.amount > parseDusd(MAX_AMOUNT_DUSD)) {
    throw new Error(
      `--amount is capped at ${MAX_AMOUNT_DUSD} dUSD for this test`
    )
  }
  return args
}
