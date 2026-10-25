import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  http,
  toHex,
  zeroHash,
  type Hex,
} from "viem"

import { MAX_UINT256 } from "./amounts"
import type { ChainReader } from "./client"
import { contractAddresses, xrplEvmTestnet } from "./config"
import { ChainReadError } from "./errors"
import { invoiceAdvanceAbi, mockUsdcAbi } from "./generated"
import {
  INVOICE_STATUSES,
  ROLE_IDS,
  findInvoice,
  getAvailableReserve,
  getEscrowAllowance,
  getInvoice,
  getNextInvoiceId,
  getOnchainRoleIds,
  getReserveBalance,
  getReserveSnapshot,
  waitForBlock,
  getTokenAllowance,
  getTokenBalance,
  getTokenMetadata,
  getTotalEscrow,
  hasRole,
  parseInvoiceId,
} from "./reads"

const B = (n: number | string) => BigInt(n)
const CLIENT = "0x8d93eD20e6eD28c34aE0057f441ED97d3e63459E"
const FREELANCER = "0x02379033ECD642D9A9aA590ABe763D62AEa967F4"
const OPERATOR = "0x6e83F6Bb6758Ced46e60be88271D72C22B84482E"
const META = ("0x" + "11".repeat(32)) as Hex
const EVAL = ("0x" + "22".repeat(32)) as Hex

interface World {
  nextInvoiceId: bigint
  invoices: Map<
    bigint,
    {
      freelancer: string
      client: string
      amount: bigint
      advanceAmount: bigint
      metadataHash: Hex
      evaluationHash: Hex
      status: number
    }
  >
  reserve: bigint
  escrow: bigint
  balances: Map<string, bigint>
  allowances: Map<string, bigint>
  roles: Set<string>
  revertWith?: "InvalidAmount"
}

function world(): World {
  return {
    nextInvoiceId: B(2),
    invoices: new Map([
      [
        B(1),
        {
          freelancer: FREELANCER,
          client: CLIENT,
          amount: B(1000000000),
          advanceAmount: B(900000000),
          metadataHash: META,
          evaluationHash: EVAL,
          status: 3,
        },
      ],
    ]),
    reserve: B(10000000000),
    escrow: B(0),
    balances: new Map([
      [contractAddresses.invoiceAdvance.toLowerCase(), B(10000000000)],
      [FREELANCER.toLowerCase(), B(1000000000)],
    ]),
    allowances: new Map(),
    roles: new Set([`${ROLE_IDS.operator}:${OPERATOR}`.toLowerCase()]),
  }
}

interface Log {
  calls: { to: string; functionName: string; blockTag: unknown }[]
  /** Number of eth_blockNumber requests that actually reached the node. */
  headRequests?: number
}

/** A real viem public client whose transport is a deterministic in-memory chain. */
function mockReader(
  w: World,
  log: Log = { calls: [] },
  /** The chain head the node reports on each eth_blockNumber request. */
  head: () => number = () => 500
): ChainReader {
  const client = createPublicClient({
    chain: xrplEvmTestnet,
    transport: custom(
      {
        async request({
          method,
          params,
        }: {
          method: string
          params?: unknown
        }) {
          if (method === "eth_chainId") return toHex(xrplEvmTestnet.id)
          if (method === "eth_blockNumber") {
            log.headRequests = (log.headRequests ?? 0) + 1
            return toHex(head())
          }
          if (method !== "eth_call")
            throw new Error(`unexpected method ${method}`)
          const [{ to, data }, blockTag] = params as [
            { to: string; data: Hex },
            unknown,
          ]
          const isIa =
            to.toLowerCase() === contractAddresses.invoiceAdvance.toLowerCase()
          const abi = isIa ? invoiceAdvanceAbi : mockUsdcAbi
          const { functionName, args = [] } = decodeFunctionData({
            abi,
            data,
          }) as { functionName: string; args?: readonly unknown[] }
          log.calls.push({ to, functionName, blockTag })
          if (w.revertWith) {
            throw Object.assign(new Error("execution reverted"), {
              code: 3,
              data: encodeErrorResult({
                abi: invoiceAdvanceAbi,
                errorName: w.revertWith,
              }),
            })
          }
          const encode = (result: unknown) =>
            encodeFunctionResult({
              abi,
              functionName: functionName as never,
              result: result as never,
            })
          switch (functionName) {
            case "nextInvoiceId":
              return encode(w.nextInvoiceId)
            case "getInvoice": {
              const id = args[0] as bigint
              const inv = w.invoices.get(id)
              if (!inv) {
                throw Object.assign(new Error("execution reverted"), {
                  code: 3,
                  data: encodeErrorResult({
                    abi: invoiceAdvanceAbi,
                    errorName: "InvoiceNotFound",
                    args: [id],
                  }),
                })
              }
              return encode(inv)
            }
            case "reserveBalance":
            case "availableReserve":
              return encode(w.reserve)
            case "totalEscrow":
              return encode(w.escrow)
            case "paymentToken":
              return encode(contractAddresses.paymentToken)
            case "name":
              return encode("Duely Demo USD")
            case "symbol":
              return encode("dUSD")
            case "decimals":
              return encode(6)
            case "balanceOf":
              return encode(
                w.balances.get((args[0] as string).toLowerCase()) ?? B(0)
              )
            case "allowance":
              return encode(
                w.allowances.get(
                  `${(args[0] as string).toLowerCase()}:${(args[1] as string).toLowerCase()}`
                ) ?? B(0)
              )
            case "hasRole":
              return encode(w.roles.has(`${args[0]}:${args[1]}`.toLowerCase()))
            case "DEFAULT_ADMIN_ROLE":
              return encode(ROLE_IDS.admin)
            case "OPERATOR_ROLE":
              return encode(ROLE_IDS.operator)
            case "EVALUATOR_ROLE":
              return encode(ROLE_IDS.evaluator)
            default:
              throw new Error(`unhandled ${functionName}`)
          }
        },
      },
      { retryCount: 0 }
    ),
  })
  return client
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: string
): Promise<ChainReadError> {
  try {
    await promise
  } catch (error) {
    assert.ok(
      error instanceof ChainReadError,
      `expected ChainReadError, got ${String(error)}`
    )
    assert.equal(error.code, code, error.message)
    return error
  }
  assert.fail(`expected rejection with ${code}`)
}

describe("invoice ID validation", () => {
  it("accepts positive integers as bigint, number or decimal string", () => {
    assert.equal(parseInvoiceId(B(1)), B(1))
    assert.equal(parseInvoiceId(1), B(1))
    assert.equal(parseInvoiceId("1"), B(1))
    assert.equal(parseInvoiceId(MAX_UINT256.toString()), MAX_UINT256)
  })

  it("rejects malformed IDs before any RPC call", async () => {
    const log: Log = { calls: [] }
    const client = mockReader(world(), log)
    const bad: (bigint | number | string)[] = [
      0,
      B(0),
      "0",
      -1,
      B(-1),
      "-1",
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "",
      " 1",
      "1 ",
      "abc",
      "1e3",
      "0x1",
      "1.5",
      MAX_UINT256 + B(1),
      (MAX_UINT256 + B(1)).toString(),
    ]
    for (const id of bad) {
      await rejectsWith(getInvoice(id, { client }), "INVALID_INVOICE_ID")
    }
    assert.equal(
      log.calls.length,
      0,
      "no RPC call may be made for an invalid ID"
    )
  })
})

describe("invoices", () => {
  it("reads invoice #1 with typed fields and status name", async () => {
    const inv = await getInvoice(1, { client: mockReader(world()) })
    assert.equal(inv.invoiceId, B(1))
    assert.equal(inv.client, CLIENT)
    assert.equal(inv.freelancer, FREELANCER)
    assert.equal(inv.amount, B(1000000000))
    assert.equal(inv.advanceAmount, B(900000000))
    assert.equal(inv.metadataHash, META)
    assert.equal(inv.evaluationHash, EVAL)
    assert.equal(inv.status, 3)
    assert.equal(inv.statusName, "Settled")
    assert.equal(typeof inv.amount, "bigint")
  })

  it("maps every enum value in spec order", async () => {
    const w = world()
    const base = w.invoices.get(B(1))!
    for (let s = 0; s < INVOICE_STATUSES.length; s++)
      w.invoices.set(B(10 + s), { ...base, status: s })
    const client = mockReader(w)
    for (let s = 0; s < INVOICE_STATUSES.length; s++) {
      assert.equal(
        (await getInvoice(B(10 + s), { client })).statusName,
        INVOICE_STATUSES[s]
      )
    }
    assert.deepEqual(
      [...INVOICE_STATUSES],
      ["Created", "Funded", "Advanced", "Settled", "Disputed", "Cancelled"]
    )
  })

  it("flags a status the SDK does not know as UNEXPECTED_RESPONSE", async () => {
    const w = world()
    w.invoices.set(B(5), { ...w.invoices.get(B(1))!, status: 9 })
    await rejectsWith(
      getInvoice(5, { client: mockReader(w) }),
      "UNEXPECTED_RESPONSE"
    )
  })

  it("maps the InvoiceNotFound revert to INVOICE_NOT_FOUND; findInvoice returns null", async () => {
    const client = mockReader(world())
    await rejectsWith(getInvoice(99, { client }), "INVOICE_NOT_FOUND")
    assert.equal(await findInvoice(99, { client }), null)
    assert.equal((await findInvoice(1, { client }))?.statusName, "Settled")
    await rejectsWith(findInvoice(0, { client }), "INVALID_INVOICE_ID")
  })

  it("reports other contract reverts as CONTRACT_REVERT and does not hide them in findInvoice", async () => {
    const w = world()
    w.revertWith = "InvalidAmount"
    const client = mockReader(w)
    const err = await rejectsWith(getInvoice(1, { client }), "CONTRACT_REVERT")
    assert.match(err.message, /InvalidAmount/)
    await rejectsWith(findInvoice(1, { client }), "CONTRACT_REVERT")
  })

  it("reads nextInvoiceId", async () => {
    assert.equal(await getNextInvoiceId({ client: mockReader(world()) }), B(2))
  })
})

describe("reserve and escrow", () => {
  it("reads reserve, available reserve and escrow", async () => {
    const client = mockReader(world())
    assert.equal(await getReserveBalance({ client }), B(10000000000))
    assert.equal(await getAvailableReserve({ client }), B(10000000000))
    assert.equal(await getTotalEscrow({ client }), B(0))
  })

  it("builds a solvency snapshot pinned to one block", async () => {
    const log: Log = { calls: [] }
    const snap = await getReserveSnapshot({ client: mockReader(world(), log) })
    assert.equal(snap.blockNumber, B(500))
    assert.equal(snap.reserveBalance, B(10000000000))
    assert.equal(snap.totalEscrow, B(0))
    assert.equal(snap.contractTokenBalance, B(10000000000))
    assert.equal(snap.solvent, true)
    assert.equal(log.calls.length, 4)
    for (const c of log.calls)
      assert.equal(c.blockTag, toHex(500), "all reads pinned to the same block")
  })

  it("reports insolvency when held tokens are below reserve + escrow", async () => {
    const w = world()
    w.escrow = B(1)
    const snap = await getReserveSnapshot({
      client: mockReader(w),
      blockNumber: B(7),
    })
    assert.equal(snap.blockNumber, B(7))
    assert.equal(snap.solvent, false)
  })
})

describe("token", () => {
  it("reads metadata", async () => {
    assert.deepEqual(await getTokenMetadata({ client: mockReader(world()) }), {
      name: "Duely Demo USD",
      symbol: "dUSD",
      decimals: 6,
    })
  })

  it("reads balance and allowance (any address casing)", async () => {
    const w = world()
    w.allowances.set(
      `${CLIENT.toLowerCase()}:${contractAddresses.invoiceAdvance.toLowerCase()}`,
      B(1000000000)
    )
    const client = mockReader(w)
    assert.equal(await getTokenBalance(FREELANCER, { client }), B(1000000000))
    assert.equal(
      await getTokenBalance(FREELANCER.toLowerCase(), { client }),
      B(1000000000)
    )
    assert.equal(await getTokenBalance(CLIENT, { client }), B(0))
    assert.equal(await getEscrowAllowance(CLIENT, { client }), B(1000000000))
    assert.equal(await getTokenAllowance(CLIENT, FREELANCER, { client }), B(0))
  })

  it("rejects invalid addresses before any RPC call", async () => {
    const log: Log = { calls: [] }
    const client = mockReader(world(), log)
    for (const bad of ["", "0x123", "not-an-address", "0x" + "g".repeat(40)]) {
      await rejectsWith(getTokenBalance(bad, { client }), "INVALID_ADDRESS")
      await rejectsWith(hasRole("operator", bad, { client }), "INVALID_ADDRESS")
    }
    await rejectsWith(
      getTokenAllowance(CLIENT, "0x1", { client }),
      "INVALID_ADDRESS"
    )
    assert.equal(log.calls.length, 0)
  })
})

describe("roles", () => {
  it("uses the contract's role ids", () => {
    assert.equal(ROLE_IDS.admin, zeroHash)
    // Known keccak256("OPERATOR_ROLE") / keccak256("EVALUATOR_ROLE") (also printed by `cast keccak`).
    assert.equal(
      ROLE_IDS.operator,
      "0x97667070c54ef182b0f5858b034beac1b6f3089aa2d3188bb1e8929f4fa9b929"
    )
    assert.equal(
      ROLE_IDS.evaluator,
      "0x4848aa3d2c0568bab3ca9720f91818ee0957e95426fa0627cc4809e2e5ed8be0"
    )
  })

  it("checks roles through hasRole and matches the contract getters", async () => {
    const client = mockReader(world())
    assert.equal(await hasRole("operator", OPERATOR, { client }), true)
    assert.equal(await hasRole("operator", CLIENT, { client }), false)
    assert.equal(await hasRole("evaluator", OPERATOR, { client }), false)
    assert.deepEqual(await getOnchainRoleIds({ client }), ROLE_IDS)
  })
})

describe("RPC failures", () => {
  it("wraps transport failures as RPC_ERROR and never leaks the endpoint URL", async () => {
    const secretUrl = "http://127.0.0.1:9/v2/SECRET-CREDENTIAL-12345"
    const client = createPublicClient({
      chain: xrplEvmTestnet,
      transport: http(secretUrl, { retryCount: 0, timeout: 3000 }),
    })
    // Sanity: the raw viem error does contain the URL, so the redaction below is meaningful.
    let raw = ""
    try {
      await client.readContract({
        address: contractAddresses.invoiceAdvance,
        abi: invoiceAdvanceAbi,
        functionName: "nextInvoiceId",
      })
    } catch (error) {
      raw = (error as Error).message
    }
    assert.match(raw, /SECRET-CREDENTIAL-12345/)

    for (const run of [
      () => getInvoice(1, { client }),
      () => getReserveBalance({ client }),
      () => getTokenBalance(FREELANCER, { client }),
      () => getReserveSnapshot({ client }),
    ]) {
      const err = await rejectsWith(run(), "RPC_ERROR")
      assert.doesNotMatch(
        err.message,
        /SECRET-CREDENTIAL|127\.0\.0\.1|https?:\/\//
      )
      assert.equal(
        err.cause,
        undefined,
        "the raw provider error must not be attached"
      )
      assert.doesNotMatch(String(err.stack), /SECRET-CREDENTIAL/)
    }
  })

  it("redacts URLs from non-viem errors too", async () => {
    const client = {
      readContract: async () => {
        throw new Error("boom https://user:SECRET@node.example/path?key=SECRET")
      },
      getBlockNumber: async () => B(1),
    } as unknown as ChainReader
    const err = await rejectsWith(getReserveBalance({ client }), "RPC_ERROR")
    assert.doesNotMatch(err.message, /SECRET|node\.example/)
  })
})

// ---- block synchronisation ------------------------------------------------------------------

/** A client whose getBlockNumber walks through `heads` (a bigint, or an Error to throw), recording its arguments. */
function headClient(heads: (bigint | Error)[]) {
  const calls: ({ cacheTime?: number } | undefined)[] = []
  let i = 0
  const client = {
    async getBlockNumber(args?: { cacheTime?: number }) {
      calls.push(args)
      const next = heads[Math.min(i++, heads.length - 1)]
      if (next instanceof Error) throw next
      return next
    },
    readContract: async () => {
      throw new Error("waitForBlock must not read contract state")
    },
  } as unknown as ChainReader
  return { client, calls, polls: () => i }
}

const fakeClock = () => {
  let t = 0
  return () => (t += 10)
}

describe("waitForBlock", () => {
  it("returns the head immediately when the RPC is already at or past the block", async () => {
    const { client, polls } = headClient([B(600)])
    assert.equal(await waitForBlock(B(500), { client }), B(600))
    assert.equal(await waitForBlock(B(600), { client }), B(600))
    assert.equal(polls(), 2)
  })

  it("polls a lagging RPC until it reaches the block, always asking for a fresh head", async () => {
    const { client, calls, polls } = headClient([
      B(497),
      B(498),
      B(498),
      B(500),
    ])
    let slept = 0
    const head = await waitForBlock(B(500), {
      client,
      pollMs: 7,
      sleep: async (ms) => {
        assert.equal(ms, 7)
        slept += 1
      },
      now: fakeClock(),
    })
    assert.equal(head, B(500))
    assert.equal(polls(), 4)
    assert.equal(slept, 3)
    assert.ok(
      calls.every((a) => a?.cacheTime === 0),
      "never served from viem's client-side head cache"
    )
  })

  it("treats provider errors while polling as transient", async () => {
    const { client } = headClient([
      new Error("fetch failed https://secret.example/KEY"),
      B(499),
      new Error("503"),
      B(500),
    ])
    assert.equal(
      await waitForBlock(B(500), {
        client,
        sleep: async () => undefined,
        now: fakeClock(),
      }),
      B(500)
    )
  })

  it("never answers with a stale head: times out with RPC_BEHIND naming the last head", async () => {
    const { client } = headClient([B(498)])
    await assert.rejects(
      waitForBlock(B(500), {
        client,
        timeoutMs: 100,
        pollMs: 1,
        sleep: async () => undefined,
        now: fakeClock(),
      }),
      (e) =>
        e instanceof ChainReadError &&
        e.code === "RPC_BEHIND" &&
        /block 500 within 100 ms \(last head 498\)/.test(e.message)
    )
  })

  it("if the RPC never answers at all, the last provider error is surfaced, sanitized", async () => {
    const { client } = headClient([
      new Error("fetch failed https://secret.example/KEY123"),
    ])
    await assert.rejects(
      waitForBlock(B(500), {
        client,
        timeoutMs: 50,
        sleep: async () => undefined,
        now: fakeClock(),
      }),
      (e) =>
        e instanceof ChainReadError &&
        e.code === "RPC_ERROR" &&
        !/KEY123|secret\.example/.test(e.message)
    )
  })

  it("validates the block argument", async () => {
    const { client } = headClient([B(1)])
    for (const bad of [-1, "5", 1.5, null] as unknown[]) {
      await assert.rejects(
        waitForBlock(bad as bigint, { client }),
        (e) => e instanceof ChainReadError && e.code === "UNEXPECTED_RESPONSE"
      )
    }
    await assert.rejects(
      waitForBlock(B(-1), { client }),
      (e) => e instanceof ChainReadError
    )
  })
})

describe("REGRESSION: a snapshot must not be pinned to viem's cached chain head", () => {
  it("documents the hazard: a default viem getBlockNumber is served from a 4 s client cache", async () => {
    let head = 9226979
    const log: Log = { calls: [] }
    const client = mockReader(world(), log, () => head++) as unknown as {
      getBlockNumber: (a?: { cacheTime?: number }) => Promise<bigint>
    }
    assert.equal(await client.getBlockNumber(), B(9226979))
    assert.equal(
      await client.getBlockNumber(),
      B(9226979),
      "chain moved on, the cached head did not"
    )
    assert.equal(log.headRequests, 1)
    assert.equal(
      await client.getBlockNumber({ cacheTime: 0 }),
      B(9226980),
      "cacheTime: 0 reaches the node"
    )
  })

  it("getReserveSnapshot asks the node for its head every time, so consecutive snapshots follow the chain", async () => {
    let head = 9226979
    const log: Log = { calls: [] }
    const client = mockReader(world(), log, () => head++)
    const first = await getReserveSnapshot({ client })
    const second = await getReserveSnapshot({ client }) // within the 4 s cache window
    assert.equal(first.blockNumber, B(9226979))
    assert.equal(
      second.blockNumber,
      B(9226980),
      "the second snapshot is not stuck on the first one's head"
    )
    assert.equal(log.headRequests, 2)
    const pins = log.calls.map((c) => c.blockTag)
    assert.deepEqual([...new Set(pins)], [toHex(9226979), toHex(9226980)])
  })

  it("an explicit blockNumber is honoured without asking for any head", async () => {
    const log: Log = { calls: [] }
    const client = mockReader(world(), log, () => 1)
    const snap = await getReserveSnapshot({ client, blockNumber: B(9226980) })
    assert.equal(snap.blockNumber, B(9226980))
    assert.equal(log.headRequests, undefined)
    assert.ok(log.calls.every((c) => c.blockTag === toHex(9226980)))
  })

  it("waitForBlock on a real viem client sees fresh heads even though the client caches", async () => {
    let head = 100
    const log: Log = { calls: [] }
    const client = mockReader(world(), log, () => head++)
    const reached = await waitForBlock(B(102), {
      client,
      pollMs: 1,
      sleep: async () => undefined,
      now: fakeClock(),
    })
    assert.equal(reached, B(102))
    assert.equal(
      log.headRequests,
      3,
      "three real head requests, none served from the cache"
    )
  })
})
