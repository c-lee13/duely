import { redactUrls } from "../../lib/chain/errors"
import { VerificationError } from "./run"

export interface VerifyOptions {
  /** Read attempts before giving up (default 4). */
  attempts?: number
  /** Base delay between attempts; grows linearly (default 1500 ms). */
  backoffMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
}

export interface VerifyArgs<S> {
  /**
   * The confirmed transaction's receipt block. State is read AT this block, never "latest": that
   * is the state immediately after the confirmed transaction, and it cannot be older than it.
   */
  block: bigint
  /** Waits until the RPC has this block (throws if it never does). */
  waitForBlock: (block: bigint) => Promise<unknown>
  /** Reads ALL related state (invoice, reserve, escrow, balances, allowances) at exactly `block`. */
  read: (block: bigint) => Promise<S>
  /** Returns the differences between `state` and what the plan expects (empty = matches). */
  compare: (state: S) => string[]
  options?: VerifyOptions
}

function describe(error: unknown): string {
  return redactUrls(error instanceof Error ? error.message : String(error))
}

/**
 * Verifies live state after a confirmed transaction, robustly against a lagging or load-balanced
 * RPC and against client-side caching:
 *
 *  1. wait until the RPC reports a head >= the receipt block;
 *  2. read everything at that one block, so the invoice, reserve, escrow and balances are from
 *     the same snapshot;
 *  3. if reading fails (for example "header not found" from a node that is still behind) or the
 *     snapshot disagrees, back off and read again, up to `attempts` times, since a single bad
 *     answer from one node must not decide the outcome.
 *
 * It resolves with the state when it matches. Otherwise it throws a VerificationError whose kind
 * says whether the state could not be read at all ("unavailable") or was read and definitively
 * disagrees ("mismatch"). It never says anything about the transaction: that is confirmed.
 */
export async function verifyAtBlock<S>(args: VerifyArgs<S>): Promise<S> {
  const attempts = Math.max(1, args.options?.attempts ?? 4)
  const backoffMs = args.options?.backoffMs ?? 1_500
  const sleep =
    args.options?.sleep ??
    ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  let last:
    | { kind: "unavailable"; message: string }
    | { kind: "mismatch"; message: string }
    | undefined

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await args.waitForBlock(args.block)
      const state = await args.read(args.block)
      const differences = args.compare(state)
      if (differences.length === 0) return state
      last = {
        kind: "mismatch",
        message: `the state at block ${args.block} differs from the plan (read ${attempt} of ${attempts}):\n  ${differences.join("\n  ")}`,
      }
    } catch (error) {
      last = {
        kind: "unavailable",
        message: `could not read a consistent snapshot at block ${args.block} (attempt ${attempt} of ${attempts}): ${describe(error)}`,
      }
    }
    if (attempt < attempts) await sleep(backoffMs * attempt)
  }
  throw new VerificationError(last!.kind, last!.message)
}
