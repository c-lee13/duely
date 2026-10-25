import {
  encodeFunctionData,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"

import { redactUrls } from "../../lib/chain/errors"
import { tryExplorerTxUrl } from "../../lib/chain/config"
import { mockUsdcAbi } from "../../lib/chain/generated"
import { VerificationError } from "./run"
import { verifyAtBlock, type VerifyOptions } from "./verify"

/**
 * Read-only verification of an owner-signed dUSD mint, after the fact. It never sends anything.
 * The receipt-level evidence (sender, destination, chain, exact calldata, the Transfer event) is
 * checked independently of any state read; the balance and supply change is then read PINNED at the
 * receipt block (and the block before it), after waiting for the RPC to reach that block.
 *
 *  verified     receipt evidence matches AND the pinned state changed by exactly the amount
 *  reverted     the transaction was mined but reverted: nothing changed
 *  mismatch     definitive: the receipt evidence, or a consistent pinned snapshot, disagrees
 *  inconclusive the receipt evidence is fine, but no consistent pinned snapshot could be read
 *  pending      no receipt yet
 */
export type MintVerdict =
  "verified" | "reverted" | "mismatch" | "inconclusive" | "pending"

export interface MintExpectation {
  chainId: number
  token: Address
  owner: Address
  recipient: Address
  /** Base units. */
  amount: bigint
}

export interface MintCheck {
  name: string
  ok: boolean
  detail: string
}

export interface MintVerification {
  verdict: MintVerdict
  hash: Hex
  explorerUrl: string | null
  blockNumber?: bigint
  gasUsed?: bigint
  checks: MintCheck[]
  /** Recipient balance and total supply immediately before / after the mint block. */
  balances?: { before: bigint; after: bigint }
  supply?: { before: bigint; after: bigint }
  message: string
}

export type MintClient = Pick<
  PublicClient,
  | "getChainId"
  | "getTransaction"
  | "getTransactionReceipt"
  | "getBlockNumber"
  | "readContract"
>

const same = (a: string | null | undefined, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase()

export interface VerifyMintOptions extends VerifyOptions {
  /** Waits for the RPC to reach the receipt block (inject in tests). */
  waitForBlock: (block: bigint) => Promise<unknown>
}

export async function verifyMint(
  client: MintClient,
  hash: Hex,
  expected: MintExpectation,
  options: VerifyMintOptions
): Promise<MintVerification> {
  const explorerUrl = tryExplorerTxUrl(hash)
  const base = { hash, explorerUrl }
  const checks: MintCheck[] = []
  const add = (name: string, ok: boolean, detail: string) =>
    checks.push({ name, ok, detail })

  try {
    const chainId = await client.getChainId()
    add(
      "chain",
      chainId === expected.chainId,
      `RPC chain ${chainId}, expected ${expected.chainId}`
    )
    if (chainId !== expected.chainId) {
      return {
        ...base,
        verdict: "mismatch",
        checks,
        message: "the RPC is on the wrong chain",
      }
    }

    let receipt
    try {
      receipt = await client.getTransactionReceipt({ hash })
    } catch {
      return {
        ...base,
        verdict: "pending",
        checks,
        message:
          "no receipt yet: the transaction is not mined (or the RPC has not seen it)",
      }
    }
    const tx = await client.getTransaction({ hash })

    add("receipt status", receipt.status === "success", receipt.status)
    if (receipt.status !== "success") {
      return {
        ...base,
        verdict: "reverted",
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        checks,
        message: "the transaction was mined but reverted: no dUSD was minted",
      }
    }

    const calldata = encodeFunctionData({
      abi: mockUsdcAbi,
      functionName: "mint",
      args: [expected.recipient, expected.amount],
    })
    add(
      "sender is the token owner",
      same(tx.from, expected.owner),
      `from ${tx.from}`
    )
    add(
      "destination is the dUSD token",
      same(tx.to, expected.token) && same(receipt.to, expected.token),
      `to ${tx.to}`
    )
    add(
      "transaction chain id",
      tx.chainId === undefined || tx.chainId === expected.chainId,
      `chainId ${tx.chainId ?? "(not reported)"}`
    )
    add("no native value sent", tx.value === BigInt(0), `value ${tx.value}`)
    add(
      "calldata is exactly mint(recipient, amount)",
      tx.input.toLowerCase() === calldata.toLowerCase(),
      `selector ${tx.input.slice(0, 10)}`
    )

    const transfers = parseEventLogs({
      abi: mockUsdcAbi,
      logs: receipt.logs.filter((l) => same(l.address, expected.token)),
      eventName: "Transfer",
    })
    const eventOk =
      receipt.logs.length === 1 &&
      transfers.length === 1 &&
      same(transfers[0].args.from, zeroAddress) &&
      same(transfers[0].args.to, expected.recipient) &&
      transfers[0].args.value === expected.amount
    add(
      "receipt carries exactly one Transfer(0x0 -> recipient, amount)",
      eventOk,
      `${receipt.logs.length} log(s)${transfers[0] ? `, Transfer to ${transfers[0].args.to} value ${transfers[0].args.value}` : ""}`
    )
    if (checks.some((c) => !c.ok)) {
      return {
        ...base,
        verdict: "mismatch",
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        checks,
        message: "the confirmed transaction does not match the approved mint",
      }
    }

    // Receipt evidence is sound. Now the pinned state: before (block - 1) and after (block).
    const block = receipt.blockNumber
    const read = async (b: bigint) => {
      const at = { blockNumber: b }
      const [balance, supply] = await Promise.all([
        client.readContract({
          address: expected.token,
          abi: mockUsdcAbi,
          functionName: "balanceOf",
          args: [expected.recipient],
          ...at,
        }),
        client.readContract({
          address: expected.token,
          abi: mockUsdcAbi,
          functionName: "totalSupply",
          ...at,
        }),
      ])
      return { balance, supply }
    }
    type Snap = {
      before: { balance: bigint; supply: bigint }
      after: { balance: bigint; supply: bigint }
    }
    const snap = await verifyAtBlock<Snap>({
      block,
      waitForBlock: options.waitForBlock,
      read: async (b) => ({
        before: await read(b - BigInt(1)),
        after: await read(b),
      }),
      compare: (s) => {
        const diffs: string[] = []
        if (s.after.balance - s.before.balance !== expected.amount)
          diffs.push(
            `recipient balance changed by ${s.after.balance - s.before.balance}, expected +${expected.amount}`
          )
        if (s.after.supply - s.before.supply !== expected.amount)
          diffs.push(
            `total supply changed by ${s.after.supply - s.before.supply}, expected +${expected.amount}`
          )
        return diffs
      },
      options,
    })
    add(
      "balance and supply rose by exactly the amount (pinned)",
      true,
      `read at blocks ${block - BigInt(1)} and ${block}`
    )
    return {
      ...base,
      verdict: "verified",
      blockNumber: block,
      gasUsed: receipt.gasUsed,
      checks,
      balances: { before: snap.before.balance, after: snap.after.balance },
      supply: { before: snap.before.supply, after: snap.after.supply },
      message: "mint confirmed and verified",
    }
  } catch (error) {
    const message = redactUrls(
      error instanceof Error ? error.message : String(error)
    )
    if (error instanceof VerificationError) {
      add("pinned state", false, message)
      return {
        ...base,
        verdict: error.kind === "unavailable" ? "inconclusive" : "mismatch",
        checks,
        message:
          error.kind === "unavailable"
            ? "the transaction is confirmed with verified receipt evidence, but a consistent pinned snapshot could not be read yet; re-run to re-check"
            : "a consistent snapshot at the receipt block disagrees with the expected change",
      }
    }
    return {
      ...base,
      verdict: "inconclusive",
      checks,
      message: `could not complete the check: ${message}`,
    }
  }
}
