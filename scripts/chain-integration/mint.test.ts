import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  encodeEventTopics,
  encodeAbiParameters,
  encodeFunctionData,
  zeroAddress,
  type Hex,
} from "viem"

import { mockUsdcAbi } from "../../lib/chain/generated"
import { verifyMint, type MintClient, type MintExpectation } from "./mint"

const B = (n: number | string) => BigInt(n)
const D = (n: number) => BigInt(Math.round(n * 1e6))

const TOKEN = "0x5ff7b6ae08c37868303e7A815308Af476421506c"
const OWNER = "0x6e83F6Bb6758Ced46e60be88271D72C22B84482E"
const CLIENT = "0x8d93eD20e6eD28c34aE0057f441ED97d3e63459E"
const STRANGER = "0x1111111111111111111111111111111111111111"
const HASH = ("0x" + "ab".repeat(32)) as Hex
const BLOCK = B(9227300)

const expected: MintExpectation = {
  chainId: 1449000,
  token: TOKEN,
  owner: OWNER,
  recipient: CLIENT,
  amount: D(100),
}
const calldata = (to: string = CLIENT, amount: bigint = D(100)) =>
  encodeFunctionData({
    abi: mockUsdcAbi,
    functionName: "mint",
    args: [to as `0x${string}`, amount],
  })

const transferLog = (
  from: string,
  to: string,
  value: bigint,
  address: string = TOKEN
) => ({
  address,
  topics: encodeEventTopics({
    abi: mockUsdcAbi,
    eventName: "Transfer",
    args: { from: from as `0x${string}`, to: to as `0x${string}` },
  }),
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
})

interface Scenario {
  chainId?: number
  tx?: Partial<{
    from: string
    to: string
    input: Hex
    value: bigint
    chainId: number | undefined
  }>
  receipt?: Partial<{
    status: "success" | "reverted"
    to: string
    logs: unknown[]
  }>
  notMined?: boolean
  /** Balance/supply at [block-1, block]. */
  state?: { balance: [bigint, bigint]; supply: [bigint, bigint] }
  /** Reads fail this many times with a node error before working. */
  failReads?: number
}

function client(s: Scenario = {}) {
  const reads: { fn: string; block: bigint | undefined }[] = []
  let failures = s.failReads ?? 0
  const state = s.state ?? {
    balance: [B(0), D(100)],
    supply: [D(11000), D(11100)],
  }
  const c = {
    async getChainId() {
      return s.chainId ?? 1449000
    },
    async getTransactionReceipt() {
      if (s.notMined) throw new Error("receipt not found")
      return {
        status: "success",
        to: TOKEN,
        blockNumber: BLOCK,
        gasUsed: B(54159),
        logs: [transferLog(zeroAddress, CLIENT, D(100))],
        ...s.receipt,
      }
    },
    async getTransaction() {
      return {
        from: OWNER,
        to: TOKEN,
        input: calldata(),
        value: B(0),
        chainId: 1449000,
        ...s.tx,
      }
    },
    async getBlockNumber() {
      return BLOCK
    },
    async readContract(args: { functionName: string; blockNumber?: bigint }) {
      reads.push({ fn: args.functionName, block: args.blockNumber })
      if (failures > 0) {
        failures -= 1
        throw new Error("header not found")
      }
      const index = args.blockNumber === BLOCK ? 1 : 0
      return args.functionName === "balanceOf"
        ? state.balance[index]
        : state.supply[index]
    },
  }
  return { client: c as unknown as MintClient, reads }
}

const opts = {
  waitForBlock: async () => undefined,
  attempts: 3,
  backoffMs: 1,
  sleep: async () => undefined,
}
const failed = (r: Awaited<ReturnType<typeof verifyMint>>) =>
  r.checks.filter((c) => !c.ok).map((c) => c.name)

describe("verifyMint: receipt evidence", () => {
  it("verifies the approved mint exactly, with pinned before/after reads", async () => {
    const { client: c, reads } = client()
    const r = await verifyMint(c, HASH, expected, opts)
    assert.equal(r.verdict, "verified")
    assert.equal(r.blockNumber, BLOCK)
    assert.equal(
      r.explorerUrl,
      `https://explorer.testnet.xrplevm.org/tx/${HASH}`
    )
    assert.deepEqual(r.balances, { before: B(0), after: D(100) })
    assert.deepEqual(r.supply, { before: D(11000), after: D(11100) })
    assert.ok(r.checks.every((x) => x.ok))
    assert.ok(
      reads.length >= 4 &&
        reads.every((x) => x.block === BLOCK || x.block === BLOCK - B(1)),
      "every read pinned to the receipt block or the one before"
    )
  })

  const bad: [string, Scenario, string][] = [
    [
      "a different sender",
      { tx: { from: STRANGER } },
      "sender is the token owner",
    ],
    [
      "a different destination contract",
      { tx: { to: STRANGER }, receipt: { to: STRANGER } },
      "destination is the dUSD token",
    ],
    [
      "a different recipient in the calldata",
      { tx: { input: calldata(STRANGER) } },
      "calldata is exactly mint(recipient, amount)",
    ],
    [
      "a different amount in the calldata",
      { tx: { input: calldata(CLIENT, D(101)) } },
      "calldata is exactly mint(recipient, amount)",
    ],
    [
      "a different function entirely",
      { tx: { input: ("0xa9059cbb" + "00".repeat(64)) as Hex } },
      "calldata is exactly mint(recipient, amount)",
    ],
    ["native value attached", { tx: { value: B(1) } }, "no native value sent"],
    [
      "a different transaction chain id",
      { tx: { chainId: 1 } },
      "transaction chain id",
    ],
    [
      "no Transfer event",
      { receipt: { logs: [] } },
      "receipt carries exactly one Transfer(0x0 -> recipient, amount)",
    ],
    [
      "a Transfer to someone else",
      { receipt: { logs: [transferLog(zeroAddress, STRANGER, D(100))] } },
      "receipt carries exactly one Transfer(0x0 -> recipient, amount)",
    ],
    [
      "a Transfer of another amount",
      { receipt: { logs: [transferLog(zeroAddress, CLIENT, D(1))] } },
      "receipt carries exactly one Transfer(0x0 -> recipient, amount)",
    ],
    [
      "a Transfer that is not from the zero address",
      { receipt: { logs: [transferLog(OWNER, CLIENT, D(100))] } },
      "receipt carries exactly one Transfer(0x0 -> recipient, amount)",
    ],
    [
      "an extra unrelated log",
      {
        receipt: {
          logs: [
            transferLog(zeroAddress, CLIENT, D(100)),
            transferLog(zeroAddress, CLIENT, D(100)),
          ],
        },
      },
      "receipt carries exactly one Transfer(0x0 -> recipient, amount)",
    ],
    [
      "the Transfer emitted by another contract",
      {
        receipt: { logs: [transferLog(zeroAddress, CLIENT, D(100), STRANGER)] },
      },
      "receipt carries exactly one Transfer(0x0 -> recipient, amount)",
    ],
  ]
  for (const [label, scenario, check] of bad) {
    it(`rejects ${label} as a definitive mismatch, without trusting any state read`, async () => {
      const { client: c, reads } = client(scenario)
      const r = await verifyMint(c, HASH, expected, opts)
      assert.equal(r.verdict, "mismatch")
      assert.ok(
        failed(r).includes(check),
        `failed checks: ${failed(r).join(", ")}`
      )
      assert.equal(
        reads.length,
        0,
        "state is not even read once the receipt evidence disagrees"
      )
    })
  }

  it("a reverted transaction is 'reverted', never 'verified'", async () => {
    const { client: c } = client({ receipt: { status: "reverted", logs: [] } })
    const r = await verifyMint(c, HASH, expected, opts)
    assert.equal(r.verdict, "reverted")
    assert.match(r.message, /no dUSD was minted/)
  })

  it("an unmined transaction is 'pending'", async () => {
    const { client: c } = client({ notMined: true })
    assert.equal((await verifyMint(c, HASH, expected, opts)).verdict, "pending")
  })

  it("refuses to judge anything on the wrong chain (never mainnet)", async () => {
    const { client: c, reads } = client({ chainId: 1440000 })
    const r = await verifyMint(c, HASH, expected, opts)
    assert.equal(r.verdict, "mismatch")
    assert.equal(reads.length, 0)
  })
})

describe("verifyMint: block-pinned state", () => {
  it("a wrong balance change at the receipt block is a definitive mismatch", async () => {
    const { client: c } = client({
      state: { balance: [B(0), D(50)], supply: [D(11000), D(11100)] },
    })
    const r = await verifyMint(c, HASH, expected, opts)
    assert.equal(r.verdict, "mismatch")
    assert.match(
      r.checks.at(-1)!.detail,
      /recipient balance changed by 50000000, expected \+100000000/
    )
  })

  it("a wrong total-supply change is a mismatch too", async () => {
    const { client: c } = client({
      state: { balance: [B(0), D(100)], supply: [D(11000), D(11200)] },
    })
    assert.equal(
      (await verifyMint(c, HASH, expected, opts)).verdict,
      "mismatch"
    )
  })

  it("transient node errors are retried and do not decide the verdict", async () => {
    const { client: c } = client({ failReads: 2 })
    assert.equal(
      (await verifyMint(c, HASH, expected, { ...opts, attempts: 4 })).verdict,
      "verified"
    )
  })

  it("an RPC that never serves the block is 'inconclusive': confirmed evidence, unchecked state", async () => {
    const { client: c } = client({ failReads: 99 })
    const r = await verifyMint(c, HASH, expected, opts)
    assert.equal(r.verdict, "inconclusive")
    assert.match(r.message, /confirmed with verified receipt evidence/)
    assert.ok(
      r.checks.slice(0, -1).every((x) => x.ok),
      "all receipt-level checks passed"
    )
  })

  it("waits for the RPC to reach the receipt block before reading", async () => {
    const { client: c, reads } = client()
    let waitedFor: bigint | undefined
    await verifyMint(c, HASH, expected, {
      ...opts,
      waitForBlock: async (b) => {
        assert.equal(reads.length, 0, "nothing read before waiting")
        waitedFor = b
      },
    })
    assert.equal(waitedFor, BLOCK)
  })
})
