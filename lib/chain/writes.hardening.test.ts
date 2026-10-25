import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createWalletClient,
  custom,
  encodeFunctionData,
  type EIP1193Provider,
  type Hex,
  type Transaction,
  type TransactionReceipt,
} from "viem"

import { createWalletClientFromProvider } from "./client"
import { contractAddresses, xrplEvmTestnet } from "./config"
import { ChainWriteError } from "./errors"
import { invoiceAdvanceAbi } from "./generated"
import { waitForConfirmation } from "./lifecycle"
import {
  approveAdvance,
  approveCompletion,
  approveToken,
  cancelInvoice,
  createInvoice,
  depositReserve,
  fundInvoice,
  getAllowanceStatus,
  prepareFundInvoice,
  raiseDispute,
  resolveDispute,
  revokeTokenApproval,
  submissionGuard,
  withdrawReserve,
  approveEscrowAllowance,
  type ChainWriteClient,
  type SubmittedTransaction,
  type WriteContext,
} from "./writes"
import {
  ADDR,
  EVAL,
  META,
  allowanceKey,
  createMockChain,
  eventLog,
  type MockChainOptions,
} from "./test/mock-chain"

const B = (n: number | string) => BigInt(n)
const IA = contractAddresses.invoiceAdvance
const AMOUNT = B(1000000000)

function setup(options?: MockChainOptions) {
  submissionGuard.reset()
  const chain = createMockChain(options)
  chain.state.allowances.set(allowanceKey(ADDR.client, IA), AMOUNT)
  chain.state.allowances.set(allowanceKey(ADDR.operator, IA), B(20000000000))
  const ctx = (who: string): WriteContext => ({
    wallet: chain.walletFor(who),
    publicClient: chain.publicClient,
  })
  return { chain, ctx }
}

async function rejects(promise: Promise<unknown>, code: string) {
  try {
    await promise
  } catch (error) {
    assert.ok(
      error instanceof ChainWriteError,
      `expected ChainWriteError, got ${String(error)}`
    )
    assert.equal(error.code, code, error.message)
    return error
  }
  assert.fail(`expected ${code}`)
}

// ---- M3: address checksums -----------------------------------------------------------------

/** Same letters, one flipped to the wrong case: a mixed-case address with a bad EIP-55 checksum. */
function breakChecksum(address: string): string {
  const body = address.slice(2)
  const i = body.search(/[a-fA-F]/)
  const flipped =
    body[i] === body[i].toLowerCase()
      ? body[i].toUpperCase()
      : body[i].toLowerCase()
  return "0x" + body.slice(0, i) + flipped + body.slice(i + 1)
}

describe("M3: EIP-55 checksum validation", () => {
  it("rejects a malformed checksum on freelancer and spender addresses, with no network activity", async () => {
    const { chain, ctx } = setup()
    const c = ctx(ADDR.client)
    const badFreelancer = breakChecksum(ADDR.freelancer)
    const badSpender = breakChecksum(ADDR.operator)
    assert.notEqual(badFreelancer, ADDR.freelancer)
    assert.notEqual(badFreelancer, ADDR.freelancer.toLowerCase())

    await rejects(
      createInvoice(
        { freelancer: badFreelancer, amount: AMOUNT, metadataHash: META },
        c
      ),
      "INVALID_INPUT"
    )
    await rejects(
      approveToken({ spender: badSpender, amount: B(5) }, c),
      "INVALID_INPUT"
    )
    await rejects(revokeTokenApproval(badSpender, c), "INVALID_INPUT")
    await rejects(
      getAllowanceStatus(badSpender, B(1), { client: chain.publicClient }),
      "INVALID_INPUT"
    )
    await rejects(
      prepareFundInvoice(1, badSpender, { client: chain.publicClient }),
      "INVALID_INPUT"
    )
    assert.equal(chain.rpc.length, 0)
    assert.equal(chain.walletRequests.length, 0)
    assert.equal(chain.sent.length, 0)
  })

  it("still accepts valid checksummed and all-lowercase addresses", async () => {
    const { chain, ctx } = setup()
    await createInvoice(
      { freelancer: ADDR.freelancer, amount: AMOUNT, metadataHash: META },
      ctx(ADDR.client)
    )
    await createInvoice(
      {
        freelancer: ADDR.freelancer.toLowerCase(),
        amount: AMOUNT,
        metadataHash: ("0x" + "33".repeat(32)) as Hex,
      },
      ctx(ADDR.client)
    )
    await approveToken(
      { spender: ADDR.operator.toLowerCase(), amount: B(5) },
      ctx(ADDR.client)
    )
    await approveToken(
      { spender: ADDR.operator, amount: B(6) },
      ctx(ADDR.client)
    )
    assert.equal(chain.sent.length, 4)
  })

  it("rejects an all-uppercase hex address (not valid lowercase, bad checksum)", async () => {
    const { chain, ctx } = setup()
    const upper = "0x" + ADDR.freelancer.slice(2).toUpperCase()
    await rejects(
      createInvoice(
        { freelancer: upper, amount: AMOUNT, metadataHash: META },
        ctx(ADDR.client)
      ),
      "INVALID_INPUT"
    )
    assert.equal(chain.sent.length, 0)
  })
})

// ---- M2: wallet retries (audit) ---------------------------------------------------------------

/**
 * A provider where `failMethod` always fails like a flaky wallet/node (-32603) and every attempt
 * at it is counted. Other requests succeed (eth_chainId returns the right chain).
 */
function flakyProvider(failMethod: string) {
  const counter = { attempts: 0 }
  const provider = {
    async request({ method }: { method: string }) {
      if (method === failMethod) {
        counter.attempts += 1
        throw Object.assign(new Error("internal error"), { code: -32603 })
      }
      if (method === "eth_chainId") return "0x" + xrplEvmTestnet.id.toString(16)
      throw new Error(`unexpected ${method}`)
    },
  } as unknown as EIP1193Provider
  return { provider, counter }
}

describe("M2: wallet transport retries", () => {
  const tx = { to: ADDR.operator as `0x${string}`, data: "0x" as Hex }
  // Default retryCount (3) with a tiny delay so the retrying case runs fast.
  const defaultWallet = (provider: EIP1193Provider) =>
    createWalletClient({
      account: ADDR.client,
      chain: xrplEvmTestnet,
      transport: custom(provider, { retryDelay: 1 }),
    })

  it("CANARY: a default viem wallet client retries ordinary requests but sends a transaction exactly once", async () => {
    // Retry machinery is genuinely active on this client: a failing read is attempted repeatedly...
    const read = flakyProvider("eth_chainId")
    await assert.rejects(defaultWallet(read.provider).getChainId())
    assert.ok(
      read.counter.attempts > 1,
      `reads were attempted ${read.counter.attempts} time(s)`
    )

    // ...but eth_sendTransaction is never resent, because viem hard-codes retryCount: 0 for it.
    // If a viem upgrade ever changes this, this test fails and the SDK's guarantee must be revisited.
    const send = flakyProvider("eth_sendTransaction")
    await assert.rejects(defaultWallet(send.provider).sendTransaction(tx))
    assert.equal(send.counter.attempts, 1)
  })

  it("end to end through the SDK, a default-config wallet still sends once and reports SEND_FAILED", async () => {
    const { chain } = setup()
    const send = flakyProvider("eth_sendTransaction")
    const err = await rejects(
      cancelInvoice(1, {
        wallet: defaultWallet(send.provider),
        publicClient: chain.publicClient,
      }),
      "SEND_FAILED"
    )
    assert.equal(send.counter.attempts, 1)
    assert.match(err.message, /check the account's recent transactions/)
  })

  it("the safe factory disables transport retries entirely (inspectable), as defense in depth", async () => {
    const read = flakyProvider("eth_chainId")
    const safe = createWalletClientFromProvider(read.provider, ADDR.client)
    assert.equal((safe.transport as { retryCount: number }).retryCount, 0)
    await assert.rejects(safe.getChainId())
    assert.equal(read.counter.attempts, 1, "no retries of any request")

    const send = flakyProvider("eth_sendTransaction")
    await assert.rejects(
      createWalletClientFromProvider(
        send.provider,
        ADDR.client
      ).sendTransaction(tx)
    )
    assert.equal(send.counter.attempts, 1)
  })

  it("accepts any wallet client shape: there is no transport-based rejection that could break wagmi clients", async () => {
    const { chain, ctx } = setup()
    // A client built the way a connector library would (default transport options).
    const { provider } = flakyProvider("eth_sendTransaction")
    const wallet = defaultWallet(provider)
    const err = await cancelInvoice(1, {
      wallet,
      publicClient: chain.publicClient,
    }).catch((e: unknown) => e)
    assert.ok(err instanceof ChainWriteError)
    assert.equal(err.code, "SEND_FAILED") // reached the send: nothing rejected it up front
    void ctx
  })
})

// ---- M1: pending duplicate guard --------------------------------------------------------------

describe("M1: pending submissions block duplicates until mined", () => {
  const newMeta = ("0x" + "44".repeat(32)) as Hex
  const operations: [
    string,
    (c: WriteContext) => Promise<SubmittedTransaction>,
    string,
  ][] = [
    [
      "createInvoice",
      (c) =>
        createInvoice(
          {
            freelancer: ADDR.freelancer,
            amount: AMOUNT,
            metadataHash: newMeta,
          },
          c
        ),
      ADDR.client,
    ],
    ["depositReserve", (c) => depositReserve(B(500000000), c), ADDR.operator],
    ["withdrawReserve", (c) => withdrawReserve(B(500000000), c), ADDR.operator],
    ["fundInvoice", (c) => fundInvoice(1, c), ADDR.client],
    [
      "approveEscrowAllowance",
      (c) => approveEscrowAllowance(AMOUNT, c),
      ADDR.client,
    ],
  ]

  for (const [name, run, who] of operations) {
    it(`${name}: a second identical call is blocked with the pending hash, then allowed once mined`, async () => {
      const { chain, ctx } = setup()
      const first = await run(ctx(who)) // separate SDK calls, fresh wallet/ctx objects each time
      const err = await rejects(run(ctx(who)), "DUPLICATE_SUBMISSION")
      assert.equal(err.txHash, first.hash)
      assert.ok(err.message.includes(first.hash))
      assert.equal(
        chain.sent.length,
        1,
        "the duplicate never reached the wallet"
      )

      chain.mine(first.hash)
      const second = await run(ctx(who))
      assert.notEqual(second.hash, first.hash)
      assert.equal(chain.sent.length, 2)
    })
  }

  it("different arguments, a different signer, or a different contract call are not duplicates", async () => {
    const { chain, ctx } = setup()
    await depositReserve(B(100), ctx(ADDR.operator))
    await depositReserve(B(101), ctx(ADDR.operator)) // different amount
    await withdrawReserve(B(100), ctx(ADDR.operator)) // different function
    await cancelInvoice(1, ctx(ADDR.client))
    await raiseDispute(2, ctx(ADDR.client))
    assert.equal(chain.sent.length, 5)
  })

  it("does not lock forever: the entry expires after the ttl even if nobody confirms or mines", async () => {
    const { chain, ctx } = setup()
    let clock = 1_000_000
    submissionGuard.now = () => clock
    submissionGuard.ttlMs = 60_000
    await cancelInvoice(1, ctx(ADDR.client))
    clock += 59_999
    await rejects(cancelInvoice(1, ctx(ADDR.client)), "DUPLICATE_SUBMISSION")
    clock += 2
    await cancelInvoice(1, ctx(ADDR.client))
    assert.equal(chain.sent.length, 2)
  })

  it("expired entries are pruned so the guard cannot grow without bound", async () => {
    const { ctx } = setup()
    let clock = 5_000_000
    submissionGuard.now = () => clock
    submissionGuard.ttlMs = 1_000
    await raiseDispute(2, ctx(ADDR.client))
    await raiseDispute(3, ctx(ADDR.client))
    assert.equal(submissionGuard.size(), 2)
    clock += 5_000
    await cancelInvoice(1, ctx(ADDR.client))
    assert.equal(submissionGuard.size(), 1)
  })

  it("waitForConfirmation releases the guard when the transaction is mined or reverts", async () => {
    const { chain, ctx } = setup()
    const first = await cancelInvoice(1, ctx(ADDR.client))
    chain.mine(first.hash, "success", [
      eventLog("invoiceAdvance", "InvoiceCancelled", { invoiceId: B(1) }),
    ])
    await waitForConfirmation(first, {
      publicClient: chain.publicClient,
      timeoutMs: 5000,
    })
    assert.equal(submissionGuard.size(), 0)

    const second = await cancelInvoice(1, ctx(ADDR.client))
    chain.mine(second.hash, "reverted")
    await rejects(
      waitForConfirmation(second, {
        publicClient: chain.publicClient,
        timeoutMs: 5000,
      }),
      "TX_REVERTED"
    )
    assert.equal(submissionGuard.size(), 0)
    await cancelInvoice(1, ctx(ADDR.client)) // a reverted tx changed nothing, so retrying is fine
  })

  it("a wait that times out keeps blocking duplicates (the tx may still land)", async () => {
    const { chain, ctx } = setup()
    const first = await cancelInvoice(1, ctx(ADDR.client))
    await rejects(
      waitForConfirmation(first, {
        publicClient: chain.publicClient,
        timeoutMs: 150,
      }),
      "WAIT_TIMEOUT"
    )
    const err = await rejects(
      cancelInvoice(1, ctx(ADDR.client)),
      "DUPLICATE_SUBMISSION"
    )
    assert.equal(err.txHash, first.hash)
  })

  it("releases immediately when nothing was sent: user rejection and failed simulation", async () => {
    const { chain, ctx } = setup()
    chain.send.mode = "reject"
    await rejects(cancelInvoice(1, ctx(ADDR.client)), "USER_REJECTED")
    chain.send.mode = "ok"
    await cancelInvoice(1, ctx(ADDR.client))

    await rejects(cancelInvoice(2, ctx(ADDR.client)), "SIMULATION_REVERTED") // invoice 2 is Funded
    chain.state.invoices.get(B(2))!.status = 0
    await cancelInvoice(2, ctx(ADDR.client)) // state fixed: the same call is allowed again
    assert.equal(chain.sent.length, 2)
  })

  it("holds the lock after an ambiguous send failure until the ttl", async () => {
    const { chain, ctx } = setup()
    let clock = 9_000_000
    submissionGuard.now = () => clock
    submissionGuard.ttlMs = 30_000
    chain.send.mode = "fail"
    await rejects(depositReserve(B(100), ctx(ADDR.operator)), "SEND_FAILED")
    chain.send.mode = "ok"
    const err = await rejects(
      depositReserve(B(100), ctx(ADDR.operator)),
      "DUPLICATE_SUBMISSION"
    )
    assert.match(err.message, /may have been broadcast/)
    assert.equal(chain.sent.length, 0)
    clock += 30_001
    await depositReserve(B(100), ctx(ADDR.operator))
    assert.equal(chain.sent.length, 1)
  })

  it("is shared through globalThis so separate copies of the module in one runtime agree", async () => {
    const { ctx } = setup()
    await cancelInvoice(1, ctx(ADDR.client))
    const slot = (
      globalThis as unknown as Record<
        string,
        { byKey: Map<string, unknown> } | undefined
      >
    ).__duelyChainPendingSubmissions
    assert.equal(slot?.byKey.size, 1)
  })
})

// ---- H1: replacement and receipt verification ---------------------------------------------------

const H_CANCEL = "0x" + "c1".repeat(32)
const H_BUMP = "0x" + "c2".repeat(32)
const H_OTHER = "0x" + "c3".repeat(32)

/** Sends a real fundInvoice through the mock wallet and registers it as pending on the RPC. */
async function pendingFund() {
  const { chain, ctx } = setup()
  const submitted = await fundInvoice(1, ctx(ADDR.client))
  const sent = chain.sentByHash.get(submitted.hash)!
  chain.rpcTxs.set(
    submitted.hash.toLowerCase(),
    chain.rpcTxFor(submitted.hash, sent, 7)
  )
  const waitOpts = { publicClient: chain.publicClient, timeoutMs: 5000 }
  /** Registers `replacement` in block 500 with a receipt, exactly as a node would after a replacement. */
  const replaceWith = (
    hash: string,
    replacement: { from: string; to: string; data: Hex },
    logs: ReturnType<typeof eventLog>[],
    gasPrice = 1000000000
  ) => {
    const tx = chain.rpcTxFor(hash, replacement, 7, gasPrice)
    chain.blocks.set(500, [
      {
        ...tx,
        blockHash: "0x" + "ab".repeat(32),
        blockNumber: "0x1f4",
        transactionIndex: "0x0",
      },
    ])
    chain.setReceipt(
      hash,
      chain.receiptJson(hash, replacement.from, replacement.to, "success", logs)
    )
  }
  return { chain, ctx, submitted, sent, waitOpts, replaceWith }
}

const fundedLog = () =>
  eventLog("invoiceAdvance", "InvoiceFunded", {
    invoiceId: B(1),
    client: ADDR.client,
    amount: AMOUNT,
  })

describe("H1: replacement handling (viem's real receipt-waiting logic over a mock node)", () => {
  it("a CANCELLED funding transaction is never reported as success, even though the cancel's receipt succeeded", async () => {
    const { submitted, waitOpts, replaceWith } = await pendingFund()
    replaceWith(
      H_CANCEL,
      { from: ADDR.client, to: ADDR.client, data: "0x" },
      []
    )
    const err = await rejects(
      waitForConfirmation(submitted, waitOpts),
      "TX_REPLACED"
    )
    assert.match(err.message, /cancelled/)
    assert.match(err.message, /did NOT run/)
    assert.equal(err.txHash, submitted.hash)
    assert.equal(err.replacementHash?.toLowerCase(), H_CANCEL)
    assert.equal(
      submissionGuard.size(),
      0,
      "the original is gone: nothing left pending"
    )
  })

  it("accepts a genuine fee bump of the same call and reports both hashes", async () => {
    const { submitted, sent, waitOpts, replaceWith } = await pendingFund()
    replaceWith(H_BUMP, sent, [fundedLog()], 5000000000)
    const confirmed = await waitForConfirmation(submitted, waitOpts)
    assert.equal(confirmed.hash.toLowerCase(), H_BUMP)
    assert.equal(confirmed.requestedHash, submitted.hash)
    assert.equal(confirmed.feeBumpedFrom, submitted.hash)
    assert.equal(confirmed.events.length, 1)
    assert.equal(confirmed.events[0].eventName, "InvoiceFunded")
    assert.equal(submissionGuard.size(), 0)
  })

  it("a fee bump whose receipt lacks the expected event is not proof (RECEIPT_MISMATCH)", async () => {
    const { submitted, sent, waitOpts, replaceWith } = await pendingFund()
    replaceWith(H_BUMP, sent, [])
    await rejects(waitForConfirmation(submitted, waitOpts), "RECEIPT_MISMATCH")
  })

  it("rejects an UNRELATED replacement that succeeded (a different contract call)", async () => {
    const { submitted, waitOpts, replaceWith } = await pendingFund()
    const other = encodeFunctionData({
      abi: invoiceAdvanceAbi,
      functionName: "cancelInvoice",
      args: [B(1)],
    })
    replaceWith(H_OTHER, { from: ADDR.client, to: IA, data: other }, [
      eventLog("invoiceAdvance", "InvoiceCancelled", { invoiceId: B(1) }),
    ])
    const err = await rejects(
      waitForConfirmation(submitted, waitOpts),
      "TX_REPLACED"
    )
    assert.match(err.message, /replaced by a different transaction/)
    assert.equal(err.replacementHash?.toLowerCase(), H_OTHER)
  })
})

function tx(
  partial: Omit<Partial<Transaction>, "hash"> & { hash: string }
): Transaction {
  return {
    from: ADDR.client,
    to: IA,
    input: "0x1234",
    value: B(0),
    nonce: 7,
    gas: B(200000),
    gasPrice: B(1000000000),
    type: "legacy",
    blockHash: null,
    blockNumber: null,
    transactionIndex: null,
    ...partial,
  } as unknown as Transaction
}

function fakeWait(
  receipt: TransactionReceipt,
  replacement?: {
    reason: "repriced" | "cancelled" | "replaced"
    replaced: Transaction
    replacement: Transaction
  }
): ChainWriteClient {
  return {
    async waitForTransactionReceipt(params: {
      onReplaced?: (r: unknown) => void
    }) {
      if (replacement) {
        params.onReplaced?.({
          reason: replacement.reason,
          replacedTransaction: replacement.replaced,
          transaction: replacement.replacement,
          transactionReceipt: receipt,
        })
      }
      return receipt
    },
  } as unknown as ChainWriteClient
}

const okReceipt = (
  hash: string,
  logs: unknown[] = [],
  from = ADDR.client,
  to: string = IA
) =>
  ({
    status: "success",
    logs,
    transactionHash: hash,
    from,
    to,
    blockNumber: B(10),
  }) as unknown as TransactionReceipt

describe("H1: realistic viem callback payloads and defense in depth", () => {
  const original = "0x" + "a1".repeat(32)
  const replacement = "0x" + "a2".repeat(32)

  it("does not trust viem's 'repriced' label if the calldata actually differs", async () => {
    const replaced = tx({ hash: original, input: "0x1234" })
    const replacing = tx({ hash: replacement, input: "0xdeadbeef" }) // lying label
    await rejects(
      waitForConfirmation(original, {
        publicClient: fakeWait(okReceipt(replacement), {
          reason: "repriced",
          replaced,
          replacement: replacing,
        }),
      }),
      "TX_REPLACED"
    )
  })

  it("does not accept a 'repriced' replacement from a different sender, nonce or target", async () => {
    const replaced = tx({ hash: original })
    for (const changed of [
      { from: ADDR.stranger },
      { nonce: 8 },
      { to: ADDR.operator },
      { value: B(1) },
    ]) {
      const replacing = tx({ hash: replacement, ...changed })
      await rejects(
        waitForConfirmation(original, {
          publicClient: fakeWait(okReceipt(replacement), {
            reason: "repriced",
            replaced,
            replacement: replacing,
          }),
        }),
        "TX_REPLACED"
      )
    }
  })

  it("accepts a case-insensitive identical fee bump", async () => {
    const replaced = tx({ hash: original, input: "0xABCDEF" })
    const replacing = tx({
      hash: replacement,
      input: "0xabcdef",
      from: ADDR.client.toLowerCase() as `0x${string}`,
    })
    const confirmed = await waitForConfirmation(original, {
      publicClient: fakeWait(okReceipt(replacement), {
        reason: "repriced",
        replaced,
        replacement: replacing,
      }),
    })
    assert.equal(confirmed.feeBumpedFrom, original)
  })

  it("rejects when the replaced transaction is not the one we waited for", async () => {
    const replaced = tx({ hash: "0x" + "ee".repeat(32) })
    const replacing = tx({ hash: replacement })
    await rejects(
      waitForConfirmation(original, {
        publicClient: fakeWait(okReceipt(replacement), {
          reason: "repriced",
          replaced,
          replacement: replacing,
        }),
      }),
      "TX_REPLACED"
    )
  })

  it("rejects when the fee-bump receipt belongs to some other transaction", async () => {
    const replaced = tx({ hash: original })
    const replacing = tx({ hash: replacement })
    await rejects(
      waitForConfirmation(original, {
        publicClient: fakeWait(okReceipt("0x" + "ff".repeat(32)), {
          reason: "repriced",
          replaced,
          replacement: replacing,
        }),
      }),
      "RECEIPT_MISMATCH"
    )
  })

  it("never treats a successful receipt for a different transaction as proof", async () => {
    const err = await rejects(
      waitForConfirmation(original, {
        publicClient: fakeWait(okReceipt("0x" + "bb".repeat(32))),
      }),
      "RECEIPT_MISMATCH"
    )
    assert.match(err.message, /not treating it as proof/)
  })
})

describe("H1: confirmation proves the intended operation, not just a successful receipt", () => {
  it("every write operation is confirmed by its own event, decoded against the real ABI", async () => {
    const { chain, ctx } = setup()
    const wait = (s: SubmittedTransaction) =>
      waitForConfirmation(s, {
        publicClient: chain.publicClient,
        timeoutMs: 5000,
      })
    const cases: [
      string,
      Promise<SubmittedTransaction>,
      ReturnType<typeof eventLog>,
    ][] = [
      [
        "createInvoice",
        createInvoice(
          { freelancer: ADDR.freelancer, amount: AMOUNT, metadataHash: META },
          ctx(ADDR.client)
        ),
        eventLog("invoiceAdvance", "InvoiceCreated", {
          invoiceId: B(6),
          freelancer: ADDR.freelancer,
          client: ADDR.client,
          amount: AMOUNT,
          metadataHash: META,
        }),
      ],
      [
        "cancelInvoice",
        cancelInvoice(1, ctx(ADDR.client)),
        eventLog("invoiceAdvance", "InvoiceCancelled", { invoiceId: B(1) }),
      ],
      ["fundInvoice", fundInvoice(1, ctx(ADDR.client)), fundedLog()],
      [
        "approveCompletion",
        approveCompletion(2, ctx(ADDR.client)),
        eventLog("invoiceAdvance", "InvoiceSettled", {
          invoiceId: B(2),
          reserveRepaid: B(0),
          freelancerPaid: AMOUNT,
        }),
      ],
      [
        "raiseDispute",
        raiseDispute(3, ctx(ADDR.client)),
        eventLog("invoiceAdvance", "InvoiceDisputed", {
          invoiceId: B(3),
          client: ADDR.client,
          advanceAlreadyPaid: B(900000000),
        }),
      ],
      [
        "resolveDispute",
        resolveDispute(4, false, ctx(ADDR.operator)),
        eventLog("invoiceAdvance", "DisputeResolved", {
          invoiceId: B(4),
          releasedToFreelancer: false,
          unrecoveredAdvance: B(0),
        }),
      ],
      [
        "approveAdvance",
        approveAdvance(2, EVAL, ctx(ADDR.evaluator)),
        eventLog("invoiceAdvance", "AdvancePaid", {
          invoiceId: B(2),
          freelancer: ADDR.freelancer,
          amount: B(900000000),
          evaluationHash: EVAL,
        }),
      ],
      [
        "depositReserve",
        depositReserve(B(700), ctx(ADDR.operator)),
        eventLog("invoiceAdvance", "ReserveDeposited", {
          operator: ADDR.operator,
          amount: B(700),
        }),
      ],
      [
        "withdrawReserve",
        withdrawReserve(B(800), ctx(ADDR.operator)),
        eventLog("invoiceAdvance", "ReserveWithdrawn", {
          operator: ADDR.operator,
          amount: B(800),
        }),
      ],
      [
        "approveToken",
        approveToken(
          { spender: ADDR.operator, amount: B(5) },
          ctx(ADDR.client)
        ),
        eventLog("paymentToken", "Approval", {
          owner: ADDR.client,
          spender: ADDR.operator,
          value: B(5),
        }),
      ],
    ]
    for (const [name, pending, log] of cases) {
      const submitted = await pending
      chain.mine(submitted.hash, "success", [log])
      const confirmed = await wait(submitted)
      assert.equal(confirmed.hash, submitted.hash, name)
    }
  })

  it("rejects a successful receipt that lacks the expected event, has other arguments, or a spoofed emitter", async () => {
    const { chain, ctx } = setup()
    const wait = (s: SubmittedTransaction) =>
      waitForConfirmation(s, {
        publicClient: chain.publicClient,
        timeoutMs: 5000,
      })

    const none = await fundInvoice(1, ctx(ADDR.client))
    chain.mine(none.hash, "success", [])
    await rejects(wait(none), "RECEIPT_MISMATCH")

    chain.state.invoices.get(B(1))!.status = 0
    submissionGuard.reset()
    const otherInvoice = await fundInvoice(1, ctx(ADDR.client))
    chain.mine(otherInvoice.hash, "success", [
      eventLog("invoiceAdvance", "InvoiceFunded", {
        invoiceId: B(2),
        client: ADDR.client,
        amount: AMOUNT,
      }),
    ])
    await rejects(wait(otherInvoice), "RECEIPT_MISMATCH")

    submissionGuard.reset()
    const wrongClient = await fundInvoice(1, ctx(ADDR.client))
    chain.mine(wrongClient.hash, "success", [
      eventLog("invoiceAdvance", "InvoiceFunded", {
        invoiceId: B(1),
        client: ADDR.stranger,
        amount: AMOUNT,
      }),
    ])
    await rejects(wait(wrongClient), "RECEIPT_MISMATCH")

    submissionGuard.reset()
    const spoof = await fundInvoice(1, ctx(ADDR.client))
    chain.mine(spoof.hash, "success", [
      { ...fundedLog(), address: ADDR.stranger },
    ])
    await rejects(wait(spoof), "RECEIPT_MISMATCH")
  })

  it("rejects a receipt sent by someone else or addressed to another contract", async () => {
    const { chain, ctx } = setup()
    const submitted = await fundInvoice(1, ctx(ADDR.client))
    const log = fundedLog()
    chain.setReceipt(
      submitted.hash,
      chain.receiptJson(submitted.hash, ADDR.stranger, IA, "success", [log])
    )
    await rejects(
      waitForConfirmation(submitted, {
        publicClient: chain.publicClient,
        timeoutMs: 5000,
      }),
      "RECEIPT_MISMATCH"
    )
    chain.setReceipt(
      submitted.hash,
      chain.receiptJson(submitted.hash, ADDR.client, ADDR.stranger, "success", [
        log,
      ])
    )
    await rejects(
      waitForConfirmation(submitted, {
        publicClient: chain.publicClient,
        timeoutMs: 5000,
      }),
      "RECEIPT_MISMATCH"
    )
  })

  it("a bare hash is checked for identity and replacement only (documented limitation)", async () => {
    const { chain, ctx } = setup()
    const submitted = await fundInvoice(1, ctx(ADDR.client))
    chain.mine(submitted.hash, "success", [])
    const confirmed = await waitForConfirmation(submitted.hash, {
      publicClient: chain.publicClient,
      timeoutMs: 5000,
    })
    assert.equal(confirmed.hash, submitted.hash)
    await rejects(
      waitForConfirmation(submitted, {
        publicClient: chain.publicClient,
        timeoutMs: 5000,
      }),
      "RECEIPT_MISMATCH"
    )
  })
})

describe("SubmittedTransaction describes the evidence to look for", () => {
  it("carries a JSON-friendly expected-receipt spec", async () => {
    const { ctx } = setup()
    const submitted = await fundInvoice(1, ctx(ADDR.client))
    assert.deepEqual(submitted.expected, {
      contract: "invoiceAdvance",
      eventName: "InvoiceFunded",
      args: { invoiceId: B(1), client: ADDR.client },
    })
  })
})
