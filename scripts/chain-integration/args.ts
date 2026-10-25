import { parseDusd } from "../../lib/chain/amounts"
import { paymentTokenInfo } from "../../lib/chain/config"

export interface Args {
  /** preflight (default) is strictly read-only; execute broadcasts transactions. */
  mode: "preflight" | "execute"
  /** In preflight, also decrypt the keystores (prompts for passwords) to prove they match. */
  checkSigners: boolean
  /** Invoice amount in base units. */
  amount: bigint
  /** The amount as typed (human dUSD), for display. */
  amountDusd: string
  /**
   * When the reserve must be funded, deposit up to this much (the same units as --amount). Undefined
   * deposits only the exact shortfall. Defaults to 5 for real-issuer tokens such as RLUSD.
   */
  reserveTarget?: bigint
  /** --reserve-target as typed, for display. */
  reserveTargetText?: string
  /** Skip the final interactive confirmation before broadcasting. */
  yes: boolean
  /** Write a JSON run report (no credentials) to this path. */
  reportPath?: string
  help: boolean
}

export const DEFAULT_AMOUNT_DUSD = "100"
/** Real-issuer tokens cannot be minted by us (RLUSD test wallets hold ~60), so default lower. */
export const DEFAULT_AMOUNT_EXTERNAL = "1"
/** RLUSD: fund the reserve once with 5, then reuse it (settlements repay every advance). */
export const DEFAULT_RESERVE_TARGET_EXTERNAL = "5"
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
  --amount <n>         Invoice amount in the active token, fractions allowed (dUSD default ${DEFAULT_AMOUNT_DUSD};
                       RLUSD default ${DEFAULT_AMOUNT_EXTERNAL}; max ${MAX_AMOUNT_DUSD})
  --reserve-target <n> If the reserve cannot cover the advance, the operator deposits up to this much
                       (never less than the advance). Default: RLUSD ${DEFAULT_RESERVE_TARGET_EXTERNAL}; dUSD only the exact shortfall.
                       A funded reserve is reused: settlement repays the advance, so later runs deposit nothing.
                       Select the token with DUELY_DEPLOYMENT=dusd|rlusd. This script never mints or transfers funds.
  --report <path>      Write a JSON report of the run (no credentials)
  --help               Show this help
`

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: "preflight",
    checkSigners: false,
    amount: BigInt(0),
    amountDusd:
      paymentTokenInfo.kind === "mock"
        ? DEFAULT_AMOUNT_DUSD
        : DEFAULT_AMOUNT_EXTERNAL,
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
      case "--reserve-target":
      case "--report": {
        const value = argv[++i]
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`${flag} needs a value`)
        }
        if (flag === "--amount") args.amountDusd = value
        else if (flag === "--reserve-target") args.reserveTargetText = value
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
      `--amount must be a positive ${paymentTokenInfo.symbol} amount with at most ${paymentTokenInfo.decimals} decimals, got "${args.amountDusd}"`
    )
  }
  if (
    args.reserveTargetText === undefined &&
    paymentTokenInfo.kind !== "mock"
  ) {
    args.reserveTargetText = DEFAULT_RESERVE_TARGET_EXTERNAL
  }
  if (args.reserveTargetText !== undefined) {
    try {
      args.reserveTarget = parseDusd(args.reserveTargetText)
    } catch {
      throw new Error(
        `--reserve-target must be a ${paymentTokenInfo.symbol} amount with at most ${paymentTokenInfo.decimals} decimals, got "${args.reserveTargetText}"`
      )
    }
    if (args.reserveTarget > parseDusd(MAX_AMOUNT_DUSD)) {
      throw new Error(
        `--reserve-target is capped at ${MAX_AMOUNT_DUSD} ${paymentTokenInfo.symbol} for this test`
      )
    }
  }
  if (args.amount <= BigInt(0))
    throw new Error("--amount must be greater than zero")
  if (args.amount > parseDusd(MAX_AMOUNT_DUSD)) {
    throw new Error(
      `--amount is capped at ${MAX_AMOUNT_DUSD} ${paymentTokenInfo.symbol} for this test`
    )
  }
  return args
}
