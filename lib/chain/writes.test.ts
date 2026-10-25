import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  WaitForTransactionReceiptTimeoutError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  type Abi,
  type Hex,
  type TransactionReceipt,
} from "viem"

import { MAX_UINT256 } from "./amounts"
import { contractAddresses } from "./config"
import { ChainWriteError } from "./errors"
import { invoiceAdvanceAbi, mockUsdcAbi } from "./generated"
import {
  decodeInvoiceAdvanceEvents,
  getInvoiceIdFromReceipt,
  waitForConfirmation,
} from "./lifecycle"
import {
  WRITE_REQUIREMENTS,
  submissionGuard,
  approveAdvance,
  approveCompletion,
  approveEscrowAllowance,
  approveToken,
  cancelInvoice,
  createInvoice,
  depositReserve,
  fundInvoice,
  getAllowanceStatus,
  prepareDepositReserve,
  prepareFundInvoice,
  raiseDispute,
  resolveDispute,
  revokeTokenApproval,
  withdrawReserve,
  type ChainWriteClient,
  type WriteContext,
} from "./writes"
import {
  ADDR,
  EVAL,
  META,
  allowanceKey,
  createMockChain,
  type MockChainOptions,
} from "./test/mock-chain"

const B = (n: number | string) => BigInt(n)
const IA = contractAddresses.invoiceAdvance
const TOKEN = contractAddresses.paymentToken

/** Mock chain + helpers. Allowances default to enough for client/operator unless overridden. */
function setup(options?: MockChainOptions) {
  submissionGuard.reset() // the pending-submission guard is process-wide by design
  const chain = createMockChain(options)
  chain.state.allowances.set(allowanceKey(ADDR.client, IA), B(1000000000))
  chain.state.allowances.set(allowanceKey(ADDR.operator, IA), B(20000000000))
  const ctx = (who: string, o?: { chainId?: number }): WriteContext => ({
    wallet: chain.walletFor(who, o),
    publicClient: chain.publicClient,
  })
  return { chain, ctx }
}

function lastSent(chain: ReturnType<typeof createMockChain>) {
  const tx = chain.sent[chain.sent.length - 1]
  assert.ok(tx, "a transaction should have been sent")
  const isIa = tx.to.toLowerCase() === IA.toLowerCase()
  const decoded = decodeFunctionData({
    abi: (isIa ? invoiceAdvanceAbi : mockUsdcAbi) as Abi,
    data: tx.data,
  }) as { functionName: string; args?: readonly unknown[] }
  return { tx, isIa, ...decoded }
}

async function rejects(
  promise: Promise<unknown>,
  code: string,
  revertName?: string
) {
  try {
    await promise
  } catch (error) {
    assert.ok(
      error instanceof ChainWriteError,
      `expected ChainWriteError, got ${String(error)}`
    )
    assert.equal(error.code, code, error.message)
    if (revertName) assert.equal(error.revertName, revertName)
    return error
  }
  assert.fail(`expected ${code}`)
}

describe("encoding: each operation sends the exact ABI function and arguments", () => {
  const cases: {
    name: string
    who: string
    run: (c: WriteContext) => Promise<{ hash: Hex }>
    to: string
    fn: string
    args: unknown[]
  }[] = [
    {
      name: "createInvoice",
      who: ADDR.client,
      to: IA,
      fn: "createInvoice",
      run: (c) =>
        createInvoice(
          {
            freelancer: ADDR.freelancer,
            amount: B(1000000000),
            metadataHash: META,
          },
          c
        ),
      args: [ADDR.freelancer, B(1000000000), META],
    },
    {
      name: "cancelInvoice",
      who: ADDR.client,
      to: IA,
      fn: "cancelInvoice",
      run: (c) => cancelInvoice(1, c),
      args: [B(1)],
    },
    {
      name: "fundInvoice",
      who: ADDR.client,
      to: IA,
      fn: "fundInvoice",
      run: (c) => fundInvoice("1", c),
      args: [B(1)],
    },
    {
      name: "approveEscrowAllowance",
      who: ADDR.client,
      to: TOKEN,
      fn: "approve",
      run: (c) => approveEscrowAllowance(B(1000000000), c),
      args: [IA, B(1000000000)],
    },
    {
      name: "approveToken",
      who: ADDR.client,
      to: TOKEN,
      fn: "approve",
      run: (c) => approveToken({ spender: ADDR.stranger, amount: B(5) }, c),
      args: [ADDR.stranger, B(5)],
    },
    {
      name: "revokeTokenApproval",
      who: ADDR.client,
      to: TOKEN,
      fn: "approve",
      run: (c) => revokeTokenApproval(IA, c),
      args: [IA, B(0)],
    },
    {
      name: "depositReserve",
      who: ADDR.operator,
      to: IA,
      fn: "depositReserve",
      run: (c) => depositReserve(B(2500000000), c),
      args: [B(2500000000)],
    },
    {
      name: "withdrawReserve",
      who: ADDR.operator,
      to: IA,
      fn: "withdrawReserve",
      run: (c) => withdrawReserve(B(700), c),
      args: [B(700)],
    },
    {
      name: "approveAdvance",
      who: ADDR.evaluator,
      to: IA,
      fn: "approveAdvance",
      run: (c) => approveAdvance(B(2), EVAL, c),
      args: [B(2), EVAL],
    },
    {
      name: "approveCompletion",
      who: ADDR.client,
      to: IA,
      fn: "approveCompletion",
      run: (c) => approveCompletion(3, c),
      args: [B(3)],
    },
    {
      name: "raiseDispute",
      who: ADDR.client,
      to: IA,
      fn: "raiseDispute",
      run: (c) => raiseDispute(2, c),
      args: [B(2)],
    },
    {
      name: "resolveDispute(true)",
      who: ADDR.operator,
      to: IA,
      fn: "resolveDispute",
      run: (c) => resolveDispute(4, true, c),
      args: [B(4), true],
    },
    {
      name: "resolveDispute(false)",
      who: ADDR.operator,
      to: IA,
      fn: "resolveDispute",
      run: (c) => resolveDispute(4, false, c),
      args: [B(4), false],
    },
  ]

  for (const c of cases) {
    it(`${c.name}`, async () => {
      const { chain, ctx } = setup()
      const result = await c.run(ctx(c.who))
      assert.match(result.hash, /^0x[0-9a-f]{64}$/)
      assert.equal(chain.sent.length, 1, "exactly one transaction submitted")
      const sent = lastSent(chain)
      assert.equal(
        sent.tx.from.toLowerCase(),
        c.who.toLowerCase(),
        "sent from the supplied wallet"
      )
      assert.equal(sent.tx.to.toLowerCase(), c.to.toLowerCase())
      assert.equal(sent.functionName, c.fn)
      const norm = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v)
      assert.deepEqual((sent.args ?? []).map(norm), c.args.map(norm))
      assert.equal(
        chain.walletRequests.some((r) => r.method.startsWith("wallet_")),
        false
      )
    })
  }

  it("simulates (eth_call from the signer) before submitting", async () => {
    const { chain, ctx } = setup()
    await cancelInvoice(1, ctx(ADDR.client))
    const sim = chain.rpc.filter((r) => r.functionName === "cancelInvoice")
    assert.equal(sim.length, 1)
    assert.equal(sim[0].from?.toLowerCase(), ADDR.client.toLowerCase())
  })

  it("accepts checksummed or lowercase addresses and normalizes the calldata", async () => {
    const { chain, ctx } = setup()
    await createInvoice(
      {
        freelancer: ADDR.freelancer.toLowerCase(),
        amount: B(1),
        metadataHash: META,
      },
      ctx(ADDR.client)
    )
    assert.equal((lastSent(chain).args ?? [])[0], ADDR.freelancer)
  })
})

describe("signer and role requirements", () => {
  it("documents the required signer for every operation", () => {
    assert.deepEqual(WRITE_REQUIREMENTS, {
      createInvoice: "client",
      cancelInvoice: "client",
      approveToken: "token-holder",
      fundInvoice: "client",
      depositReserve: "operator",
      withdrawReserve: "operator",
      approveAdvance: "evaluator",
      approveCompletion: "client",
      raiseDispute: "client",
      resolveDispute: "operator",
    })
  })

  it("rejects a wrong signer for every restricted operation, sending nothing", async () => {
    const { chain, ctx } = setup()
    const wrong: [string, Promise<unknown>][] = [
      ["cancelInvoice", cancelInvoice(1, ctx(ADDR.freelancer))],
      ["fundInvoice", fundInvoice(1, ctx(ADDR.freelancer))],
      ["approveCompletion", approveCompletion(2, ctx(ADDR.freelancer))],
      ["raiseDispute", raiseDispute(2, ctx(ADDR.operator))],
      ["approveAdvance(client)", approveAdvance(2, EVAL, ctx(ADDR.client))],
      ["approveAdvance(operator)", approveAdvance(2, EVAL, ctx(ADDR.operator))],
      ["depositReserve(client)", depositReserve(B(1), ctx(ADDR.client))],
      [
        "withdrawReserve(evaluator)",
        withdrawReserve(B(1), ctx(ADDR.evaluator)),
      ],
      ["resolveDispute(client)", resolveDispute(4, true, ctx(ADDR.client))],
      [
        "resolveDispute(evaluator)",
        resolveDispute(4, false, ctx(ADDR.evaluator)),
      ],
    ]
    for (const [label, p] of wrong) {
      const err = await rejects(p, "UNAUTHORIZED_SIGNER")
      assert.ok(err.message.length > 0, label)
    }
    assert.equal(chain.sent.length, 0)
  })

  it("surfaces the on-chain role error from simulation", async () => {
    const { chain, ctx } = setup()
    await rejects(
      approveAdvance(2, EVAL, ctx(ADDR.client)),
      "UNAUTHORIZED_SIGNER",
      "AccessControlUnauthorizedAccount"
    )
    await rejects(
      withdrawReserve(B(1), ctx(ADDR.evaluator)),
      "UNAUTHORIZED_SIGNER",
      "AccessControlUnauthorizedAccount"
    )
    await rejects(
      cancelInvoice(1, ctx(ADDR.freelancer)),
      "UNAUTHORIZED_SIGNER",
      "NotInvoiceClient"
    )
    assert.equal(chain.sent.length, 0)
  })
})

describe("chain and wallet checks", () => {
  it("rejects a wallet on the wrong chain without switching networks or sending", async () => {
    const { chain, ctx } = setup()
    const err = await rejects(
      fundInvoice(1, ctx(ADDR.client, { chainId: 1 })),
      "WRONG_CHAIN"
    )
    assert.match(err.message, /switch/i)
    assert.equal(chain.sent.length, 0)
    assert.equal(
      chain.walletRequests.some(
        (r) =>
          r.method === "wallet_switchEthereumChain" ||
          r.method === "wallet_addEthereumChain"
      ),
      false
    )
    assert.equal(
      chain.callsOf("fundInvoice"),
      0,
      "no simulation on the wrong chain"
    )
  })

  it("rejects an RPC endpoint on the wrong chain", async () => {
    const { chain, ctx } = setup({ rpcChainId: 1 })
    await rejects(cancelInvoice(1, ctx(ADDR.client)), "WRONG_CHAIN")
    assert.equal(chain.sent.length, 0)
  })

  it("requires the wallet client to carry an account", async () => {
    const { chain } = setup()
    const wallet = { ...chain.walletFor(ADDR.client), account: undefined }
    await rejects(
      cancelInvoice(1, { wallet, publicClient: chain.publicClient }),
      "NO_ACCOUNT"
    )
    assert.equal(chain.sent.length, 0)
  })
})

describe("input validation (no network activity)", () => {
  it("rejects invalid addresses, amounts, IDs and hashes before touching the network", async () => {
    const { chain, ctx } = setup()
    const c = ctx(ADDR.client)
    const zeroHash = ("0x" + "00".repeat(32)) as Hex
    const attempts: Promise<unknown>[] = [
      createInvoice(
        { freelancer: "0x123", amount: B(1), metadataHash: META },
        c
      ),
      createInvoice({ freelancer: "", amount: B(1), metadataHash: META }, c),
      createInvoice(
        { freelancer: "0x" + "0".repeat(40), amount: B(1), metadataHash: META },
        c
      ),
      createInvoice(
        { freelancer: ADDR.client, amount: B(1), metadataHash: META },
        c
      ), // freelancer == client
      createInvoice({ freelancer: IA, amount: B(1), metadataHash: META }, c),
      createInvoice({ freelancer: TOKEN, amount: B(1), metadataHash: META }, c),
      createInvoice(
        { freelancer: ADDR.freelancer, amount: B(0), metadataHash: META },
        c
      ),
      createInvoice(
        { freelancer: ADDR.freelancer, amount: B(-5), metadataHash: META },
        c
      ),
      createInvoice(
        {
          freelancer: ADDR.freelancer,
          amount: MAX_UINT256 + B(1),
          metadataHash: META,
        },
        c
      ),
      createInvoice(
        {
          freelancer: ADDR.freelancer,
          amount: 5 as unknown as bigint,
          metadataHash: META,
        },
        c
      ),
      createInvoice(
        { freelancer: ADDR.freelancer, amount: B(1), metadataHash: zeroHash },
        c
      ),
      createInvoice(
        { freelancer: ADDR.freelancer, amount: B(1), metadataHash: "0x1234" },
        c
      ),
      cancelInvoice(0, c),
      fundInvoice(-1, c),
      fundInvoice("abc", c),
      raiseDispute(1.5, c),
      approveCompletion("", c),
      approveAdvance(2, "0x" + "00".repeat(32), c),
      approveAdvance(2, "nope", c),
      resolveDispute(4, "true" as unknown as boolean, c),
      depositReserve(B(0), c),
      withdrawReserve(B(-1), c),
      approveToken({ spender: "0xabc", amount: B(1) }, c),
      approveToken({ spender: ADDR.stranger, amount: B(0) }, c),
    ]
    for (const p of attempts) await rejects(p, "INVALID_INPUT")
    assert.equal(chain.rpc.length, 0, "validation must not make any RPC call")
    assert.equal(chain.walletRequests.length, 0)
    assert.equal(chain.sent.length, 0)
  })
})

describe("ERC-20 approvals", () => {
  it("approves exactly the requested amount, never unlimited by default", async () => {
    const { chain, ctx } = setup()
    await approveEscrowAllowance(B(1000000000), ctx(ADDR.client))
    const sent = lastSent(chain)
    assert.deepEqual((sent.args ?? [])[1], B(1000000000))
    await rejects(
      approveToken({ spender: IA, amount: MAX_UINT256 }, ctx(ADDR.client)),
      "INVALID_INPUT"
    )
    assert.equal(chain.sent.length, 1, "the unlimited request sent nothing")
    await approveToken(
      { spender: IA, amount: MAX_UINT256, allowUnlimited: true },
      ctx(ADDR.client)
    )
    assert.deepEqual((lastSent(chain).args ?? [])[1], MAX_UINT256)
  })

  it("revokes with approve(spender, 0)", async () => {
    const { chain, ctx } = setup()
    await revokeTokenApproval(IA, ctx(ADDR.client))
    assert.deepEqual(lastSent(chain).args, [IA, B(0)])
  })

  it("fundInvoice never auto-approves: it reports the missing allowance first", async () => {
    const { chain, ctx } = setup()
    chain.state.allowances.clear()
    const err = await rejects(
      fundInvoice(1, ctx(ADDR.client)),
      "INSUFFICIENT_ALLOWANCE"
    )
    assert.match(err.message, /approveEscrowAllowance/)
    assert.equal(chain.sent.length, 0, "no approval and no funding were sent")
    assert.equal(chain.callsOf("fundInvoice"), 0, "failed before simulation")
  })

  it("fundInvoice reports a short allowance (partial approval)", async () => {
    const { chain, ctx } = setup()
    chain.state.allowances.set(allowanceKey(ADDR.client, IA), B(999999999))
    await rejects(fundInvoice(1, ctx(ADDR.client)), "INSUFFICIENT_ALLOWANCE")
    assert.equal(chain.sent.length, 0)
  })

  it("fundInvoice reports an insufficient balance", async () => {
    const { chain, ctx } = setup()
    chain.state.balances.set(ADDR.client.toLowerCase(), B(10))
    await rejects(fundInvoice(1, ctx(ADDR.client)), "INSUFFICIENT_BALANCE")
    assert.equal(chain.sent.length, 0)
  })

  it("depositReserve checks allowance and balance for the operator", async () => {
    const { chain, ctx } = setup()
    chain.state.allowances.set(allowanceKey(ADDR.operator, IA), B(99))
    await rejects(
      depositReserve(B(100), ctx(ADDR.operator)),
      "INSUFFICIENT_ALLOWANCE"
    )
    chain.state.allowances.set(allowanceKey(ADDR.operator, IA), MAX_UINT256)
    chain.state.balances.set(ADDR.operator.toLowerCase(), B(50))
    await rejects(
      depositReserve(B(100), ctx(ADDR.operator)),
      "INSUFFICIENT_BALANCE"
    )
    assert.equal(chain.sent.length, 0)
  })
})

describe("simulation failures", () => {
  it("rejects invalid status transitions from the simulation, sending nothing", async () => {
    const { chain, ctx } = setup()
    const wrongStatus: [string, Promise<unknown>][] = [
      ["cancel a funded invoice", cancelInvoice(2, ctx(ADDR.client))],
      ["settle a created invoice", approveCompletion(1, ctx(ADDR.client))],
      ["settle a settled invoice", approveCompletion(5, ctx(ADDR.client))],
      ["settle a disputed invoice", approveCompletion(4, ctx(ADDR.client))],
      ["dispute a created invoice", raiseDispute(1, ctx(ADDR.client))],
      ["dispute twice", raiseDispute(4, ctx(ADDR.client))],
      [
        "advance a created invoice",
        approveAdvance(1, EVAL, ctx(ADDR.evaluator)),
      ],
      ["duplicate advance", approveAdvance(3, EVAL, ctx(ADDR.evaluator))],
      [
        "advance a disputed invoice",
        approveAdvance(4, EVAL, ctx(ADDR.evaluator)),
      ],
      [
        "resolve a non-disputed invoice",
        resolveDispute(2, true, ctx(ADDR.operator)),
      ],
    ]
    for (const [label, p] of wrongStatus) {
      const err = await rejects(p, "SIMULATION_REVERTED", "InvalidStatus")
      assert.match(
        err.message,
        /InvalidStatus: invoice is (Created|Funded|Advanced|Settled|Disputed)/,
        label
      )
    }
    assert.equal(chain.sent.length, 0)
  })

  it("rejects fundInvoice on an already funded invoice before checking allowance", async () => {
    const { chain, ctx } = setup()
    chain.state.allowances.clear()
    await rejects(
      fundInvoice(2, ctx(ADDR.client)),
      "SIMULATION_REVERTED",
      "InvalidStatus"
    )
    assert.equal(chain.sent.length, 0)
  })

  it("reports insufficient reserve for an advance", async () => {
    const { chain, ctx } = setup()
    chain.state.reserve = B(899999999)
    const err = await rejects(
      approveAdvance(2, EVAL, ctx(ADDR.evaluator)),
      "SIMULATION_REVERTED",
      "InsufficientReserve"
    )
    assert.match(err.message, /required 900000000, available 899999999/)
    assert.equal(chain.sent.length, 0)
  })

  it("reports a withdrawal above the reserve", async () => {
    const { chain, ctx } = setup()
    await rejects(
      withdrawReserve(chain.state.reserve + B(1), ctx(ADDR.operator)),
      "SIMULATION_REVERTED",
      "InsufficientReserve"
    )
    assert.equal(chain.sent.length, 0)
  })

  it("reports nonexistent invoices", async () => {
    const { chain, ctx } = setup()
    await rejects(cancelInvoice(99, ctx(ADDR.client)), "INVOICE_NOT_FOUND")
    await rejects(fundInvoice(99, ctx(ADDR.client)), "INVOICE_NOT_FOUND")
    await rejects(
      approveAdvance(99, EVAL, ctx(ADDR.evaluator)),
      "INVOICE_NOT_FOUND"
    )
    assert.equal(chain.sent.length, 0)
  })

  it("maps RPC failures during simulation to a sanitized RPC_ERROR and sends nothing", async () => {
    const { chain, ctx } = setup({ failCallsFor: ["cancelInvoice"] })
    const err = await rejects(cancelInvoice(1, ctx(ADDR.client)), "RPC_ERROR")
    assert.doesNotMatch(err.message, /TOP-SECRET|secret-node|https?:\/\//)
    assert.equal(err.cause, undefined)
    assert.equal(chain.sent.length, 0)
  })
})

describe("submission safety", () => {
  it("does not retry a rejected request", async () => {
    const { chain, ctx } = setup()
    chain.send.mode = "reject"
    await rejects(cancelInvoice(1, ctx(ADDR.client)), "USER_REJECTED")
    assert.equal(chain.send.attempts, 1)
    assert.equal(chain.sent.length, 0)
  })

  it("does not retry a failed send and warns the caller to verify first", async () => {
    const { chain, ctx } = setup()
    chain.send.mode = "fail"
    const err = await rejects(cancelInvoice(1, ctx(ADDR.client)), "SEND_FAILED")
    assert.equal(
      chain.send.attempts,
      1,
      "exactly one attempt: the wallet client has retries disabled"
    )
    assert.match(err.message, /check the account's recent transactions/)
    assert.doesNotMatch(err.message, /wallet-node|KEY|https?:\/\//)
  })

  it("blocks an identical submission while the first is in flight and while it is pending", async () => {
    const { chain, ctx } = setup()
    chain.send.holdNext()
    const first = cancelInvoice(1, ctx(ADDR.client))
    // Let the first call reach the (held) send.
    for (let i = 0; i < 50 && chain.send.attempts === 0; i++)
      await new Promise((r) => setTimeout(r, 5))
    assert.equal(chain.send.attempts, 1)
    await rejects(cancelInvoice(1, ctx(ADDR.client)), "DUPLICATE_SUBMISSION")
    chain.send.release()
    const submitted = await first
    assert.equal(
      chain.sent.length,
      1,
      "only the first submission reached the wallet"
    )

    // Returned a hash but not mined yet: still blocked, and the error names the pending hash.
    const err = await rejects(
      cancelInvoice(1, ctx(ADDR.client)),
      "DUPLICATE_SUBMISSION"
    )
    assert.equal(err.txHash, submitted.hash)
    assert.ok(err.message.includes(submitted.hash))
    assert.equal(chain.sent.length, 1)

    chain.mine(submitted.hash) // once mined, the contract's own status checks take over
    await cancelInvoice(1, ctx(ADDR.client))
    assert.equal(chain.sent.length, 2)
  })

  it("different signers or different arguments are not treated as duplicates", async () => {
    const { chain, ctx } = setup()
    chain.send.holdNext()
    const a = raiseDispute(2, ctx(ADDR.client))
    for (let i = 0; i < 50 && chain.send.attempts === 0; i++)
      await new Promise((r) => setTimeout(r, 5))
    const b = raiseDispute(3, ctx(ADDR.client))
    for (let i = 0; i < 50 && chain.send.attempts < 2; i++)
      await new Promise((r) => setTimeout(r, 5))
    assert.equal(chain.send.attempts, 2)
    chain.send.release()
    await Promise.all([a, b])
    assert.equal(chain.sent.length, 2)
  })
})

describe("preparation is read-only", () => {
  it("prepareFundInvoice / prepareDepositReserve / getAllowanceStatus never send", async () => {
    const { chain } = setup()
    const opts = { client: chain.publicClient }

    const ready = await prepareFundInvoice(1, ADDR.client, opts)
    assert.equal(ready.ready, true)
    assert.deepEqual(ready.blockers, [])
    assert.equal(ready.allowance.sufficient, true)

    chain.state.allowances.clear()
    const blocked = await prepareFundInvoice(1, ADDR.client, opts)
    assert.equal(blocked.ready, false)
    assert.equal(blocked.allowance.shortfall, B(1000000000))
    assert.match(
      blocked.blockers.join(" "),
      /approve 1000000000 more base units/
    )

    const wrongAccount = await prepareFundInvoice(1, ADDR.stranger, opts)
    assert.match(wrongAccount.blockers.join(" "), /not the invoice client/)
    const funded = await prepareFundInvoice(2, ADDR.client, opts)
    assert.match(funded.blockers.join(" "), /status is Funded/)

    const status = await getAllowanceStatus(ADDR.client, B(10), opts)
    assert.equal(status.current, B(0))
    assert.equal(status.shortfall, B(10))
    assert.equal(status.spender, IA)

    const dep = await prepareDepositReserve(B(100), ADDR.client, opts)
    assert.equal(dep.ready, false)
    assert.match(dep.blockers.join(" "), /OPERATOR_ROLE/)

    assert.equal(chain.sent.length, 0)
    assert.equal(chain.walletRequests.length, 0)
    assert.equal(
      chain.rpc.filter((r) => r.functionName === "fundInvoice").length,
      0
    )
  })
})

// ---- confirmation ---------------------------------------------------------------------------

const HASH = "0x" + "ab".repeat(32)

function receiptFor(
  status: "success" | "reverted",
  logs: unknown[] = [],
  transactionHash: string = HASH
): TransactionReceipt {
  return {
    status,
    logs,
    transactionHash,
    blockNumber: B(10),
  } as unknown as TransactionReceipt
}

function createdLog(address: string, invoiceId: bigint) {
  return {
    address,
    topics: encodeEventTopics({
      abi: invoiceAdvanceAbi,
      eventName: "InvoiceCreated",
      args: { invoiceId, freelancer: ADDR.freelancer, client: ADDR.client },
    }),
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }],
      [B(1000000000), META]
    ),
    blockNumber: B(10),
    logIndex: 0,
    transactionIndex: 0,
    transactionHash: "0x" + "ab".repeat(32),
    blockHash: "0x" + "cd".repeat(32),
    removed: false,
  }
}

function fakeClient(impl: () => Promise<TransactionReceipt>): ChainWriteClient {
  return { waitForTransactionReceipt: impl } as unknown as ChainWriteClient
}

describe("confirmation", () => {
  const hash = "0x" + "ab".repeat(32)

  it("resolves only for a successful receipt and decodes InvoiceAdvance events", async () => {
    const receipt = receiptFor("success", [
      createdLog(IA, B(7)),
      createdLog("0x" + "9".repeat(40), B(8)), // other contract: ignored
    ])
    const confirmed = await waitForConfirmation(hash, {
      publicClient: fakeClient(async () => receipt),
    })
    assert.equal(confirmed.events.length, 1)
    assert.equal(confirmed.events[0].eventName, "InvoiceCreated")
    assert.equal(getInvoiceIdFromReceipt(receipt), B(7))
    assert.equal(decodeInvoiceAdvanceEvents(receipt).length, 1)
    assert.equal(getInvoiceIdFromReceipt(receiptFor("success")), null)
  })

  it("throws TX_REVERTED with the hash for a mined-but-reverted transaction", async () => {
    const err = await rejects(
      waitForConfirmation(hash, {
        publicClient: fakeClient(async () => receiptFor("reverted")),
      }),
      "TX_REVERTED"
    )
    assert.equal(err.txHash, hash)
  })

  it("throws WAIT_TIMEOUT (do not resubmit) on a timeout", async () => {
    const err = await rejects(
      waitForConfirmation(hash, {
        publicClient: fakeClient(async () => {
          throw new WaitForTransactionReceiptTimeoutError({ hash: hash as Hex })
        }),
      }),
      "WAIT_TIMEOUT"
    )
    assert.match(err.message, /Do not resubmit/)
    assert.equal(err.txHash, hash)
  })

  it("validates the hash", async () => {
    await rejects(waitForConfirmation("0x123"), "INVALID_INPUT")
  })
})

describe("browser-safe modules hold no secrets", () => {
  it("writes.ts, client.ts, errors.ts and config.ts reference no keys or server RPC variables", () => {
    for (const file of ["writes.ts", "client.ts", "errors.ts", "config.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
      assert.doesNotMatch(
        source,
        /privateKey|PRIVATE_KEY|mnemonic|server-only/i,
        file
      )
      assert.doesNotMatch(
        source.replace(/NEXT_PUBLIC_XRPL_EVM_RPC_URL/g, ""),
        /process\.env\.XRPL_EVM_RPC_URL/,
        file
      )
    }
  })
})
