import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  encodeFunctionData,
  keccak256,
  stringToHex,
  toEventSelector,
  type Hex,
  type TransactionReceipt,
} from "viem"

import { MAX_UINT256 } from "./amounts"
import {
  contractAddresses,
  explorerAddressUrl,
  explorerBlockUrl,
  explorerTxUrl,
  tryExplorerAddressUrl,
  tryExplorerTxUrl,
} from "./config"
import { ChainWriteError } from "./errors"
import { ARG_KINDS, EXPECTED_EVENTS } from "./expected"
import { invoiceAdvanceAbi, mockUsdcAbi } from "./generated"
import {
  decodeInvoiceAdvanceEvents,
  getInvoiceIdFromReceipt,
  getTransactionStatus,
  isTerminalStatus,
  parseSubmittedTransaction,
  serializeSubmittedTransaction,
  trackTransaction,
  waitForConfirmation,
  type TransactionState,
  type TransactionStatus,
} from "./lifecycle"
import {
  approveAdvance,
  approveCompletion,
  approveToken,
  cancelInvoice,
  createInvoice,
  depositReserve,
  fundInvoice,
  raiseDispute,
  resolveDispute,
  submissionGuard,
  withdrawReserve,
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
} from "./test/mock-chain"

const B = (n: number | string) => BigInt(n)
const IA = contractAddresses.invoiceAdvance
const AMOUNT = B(1000000000)

function setup() {
  submissionGuard.reset()
  const chain = createMockChain()
  chain.state.allowances.set(allowanceKey(ADDR.client, IA), AMOUNT)
  chain.state.allowances.set(allowanceKey(ADDR.operator, IA), B(20000000000))
  const ctx = (who: string): WriteContext => ({
    wallet: chain.walletFor(who),
    publicClient: chain.publicClient,
  })
  const opts = { publicClient: chain.publicClient, timeoutMs: 5000 }
  return { chain, ctx, opts }
}

function expectState<S extends TransactionState>(
  status: TransactionStatus,
  state: S
): Extract<TransactionStatus, { state: S }> {
  assert.equal(status.state, state, `expected ${state}, got ${status.state}`)
  return status as Extract<TransactionStatus, { state: S }>
}

const fundedLog = () =>
  eventLog("invoiceAdvance", "InvoiceFunded", {
    invoiceId: B(1),
    client: ADDR.client,
    amount: AMOUNT,
  })

const createdLog = (
  invoiceId: bigint,
  over: Partial<{
    client: string
    freelancer: string
    amount: bigint
    metadataHash: Hex
  }> = {}
) =>
  eventLog("invoiceAdvance", "InvoiceCreated", {
    invoiceId,
    freelancer: ADDR.freelancer,
    client: ADDR.client,
    amount: AMOUNT,
    metadataHash: META,
    ...over,
  })

const H1 = "0x" + "c1".repeat(32)
const H2 = "0x" + "c2".repeat(32)

describe("trackTransaction: every outcome is a typed status", () => {
  it("submitted -> pending -> confirmed, with everything a UI needs", async () => {
    const { chain, ctx, opts } = setup()
    const submitted = await fundInvoice(1, ctx(ADDR.client))
    assert.equal(submitted.explorerUrl, explorerTxUrl(submitted.hash))
    assert.equal(typeof submitted.submittedAt, "number")

    chain.mine(submitted.hash, "success", [fundedLog()])
    const seen: TransactionStatus[] = []
    const status = await trackTransaction(submitted, {
      ...opts,
      onStatus: (s) => seen.push(s),
    })

    assert.deepEqual(
      seen.map((s) => s.state),
      ["pending", "confirmed"]
    )
    const pending = expectState(seen[0], "pending")
    assert.equal(pending.hash, submitted.hash)
    assert.equal(pending.submittedAt, submitted.submittedAt)
    assert.equal(pending.explorerUrl, submitted.explorerUrl)

    const confirmed = expectState(status, "confirmed")
    assert.equal(confirmed.hash, submitted.hash)
    assert.equal(confirmed.requestedHash, submitted.hash)
    assert.equal(confirmed.functionName, "fundInvoice")
    assert.equal(confirmed.verified, true)
    assert.equal(confirmed.explorerUrl, explorerTxUrl(submitted.hash))
    assert.equal(typeof confirmed.blockNumber, "bigint")
    assert.equal(confirmed.blockNumber, confirmed.receipt.blockNumber)
    assert.equal(confirmed.event?.eventName, "InvoiceFunded")
    assert.equal(confirmed.event?.args.amount, AMOUNT)
    assert.equal(confirmed.invoiceId, "1")
    assert.equal(confirmed.events.length, 1)
    assert.equal(confirmed.feeBumpedFrom, undefined)
    assert.equal(isTerminalStatus(confirmed), true)
  })

  it("invoiceId is a decimal string only for events that carry one", async () => {
    const { chain, ctx, opts } = setup()
    const deposit = await depositReserve(B(700), ctx(ADDR.operator))
    chain.mine(deposit.hash, "success", [
      eventLog("invoiceAdvance", "ReserveDeposited", {
        operator: ADDR.operator,
        amount: B(700),
      }),
    ])
    const confirmed = expectState(
      await trackTransaction(deposit, opts),
      "confirmed"
    )
    assert.equal(confirmed.invoiceId, null)
    assert.equal(confirmed.event?.args.amount, B(700))
  })

  it("a throwing onStatus callback cannot mask the outcome", async () => {
    const { chain, ctx, opts } = setup()
    const submitted = await cancelInvoice(1, ctx(ADDR.client))
    chain.mine(submitted.hash, "success", [
      eventLog("invoiceAdvance", "InvoiceCancelled", { invoiceId: B(1) }),
    ])
    const status = await trackTransaction(submitted, {
      ...opts,
      onStatus: () => {
        throw new Error("UI bug")
      },
    })
    assert.equal(status.state, "confirmed")
  })

  it("reverted: mined but failed, with the receipt and block", async () => {
    const { chain, ctx, opts } = setup()
    const submitted = await cancelInvoice(1, ctx(ADDR.client))
    chain.mine(submitted.hash, "reverted")
    const reverted = expectState(
      await trackTransaction(submitted, opts),
      "reverted"
    )
    assert.equal(reverted.error.code, "TX_REVERTED")
    assert.equal(reverted.receipt.status, "reverted")
    assert.equal(typeof reverted.blockNumber, "bigint")
    assert.equal(isTerminalStatus(reverted), true)
    assert.equal(submissionGuard.size(), 0)
  })

  it("replaced (cancelled): the intended operation did not run", async () => {
    const { chain, ctx, opts } = setup()
    const submitted = await fundInvoice(1, ctx(ADDR.client))
    chain.registerPending(submitted.hash)
    chain.placeReplacement(
      H1,
      { from: ADDR.client, to: ADDR.client, data: "0x" },
      []
    )
    const replaced = expectState(
      await trackTransaction(submitted, opts),
      "replaced"
    )
    assert.equal(replaced.reason, "cancelled")
    assert.equal(replaced.hash, submitted.hash)
    assert.equal(replaced.replacementHash.toLowerCase(), H1)
    assert.equal(replaced.replacementExplorerUrl, explorerTxUrl(H1))
    assert.equal(replaced.error.code, "TX_REPLACED")
    assert.equal(isTerminalStatus(replaced), true)
  })

  it("replaced (different call): reported as replaced even though that receipt succeeded", async () => {
    const { chain, ctx, opts } = setup()
    const submitted = await fundInvoice(1, ctx(ADDR.client))
    chain.registerPending(submitted.hash)
    const other = encodeFunctionData({
      abi: invoiceAdvanceAbi,
      functionName: "cancelInvoice",
      args: [B(1)],
    })
    chain.placeReplacement(H1, { from: ADDR.client, to: IA, data: other }, [
      eventLog("invoiceAdvance", "InvoiceCancelled", { invoiceId: B(1) }),
    ])
    const replaced = expectState(
      await trackTransaction(submitted, opts),
      "replaced"
    )
    assert.equal(replaced.reason, "replaced")
  })

  it("a same-call fee bump is confirmed and keeps both hashes", async () => {
    const { chain, ctx, opts } = setup()
    const submitted = await fundInvoice(1, ctx(ADDR.client))
    const sent = chain.registerPending(submitted.hash)
    chain.placeReplacement(H2, sent, [fundedLog()], { gasPrice: 5000000000 })
    const confirmed = expectState(
      await trackTransaction(submitted, opts),
      "confirmed"
    )
    assert.equal(confirmed.hash.toLowerCase(), H2)
    assert.equal(confirmed.requestedHash, submitted.hash)
    assert.equal(confirmed.feeBumpedFrom, submitted.hash)
    assert.equal(confirmed.explorerUrl, explorerTxUrl(H2))
  })

  it("unknown (timeout): not a failure, and the duplicate guard stays on", async () => {
    const { ctx, opts } = setup()
    const submitted = await cancelInvoice(1, ctx(ADDR.client))
    const unknown = expectState(
      await trackTransaction(submitted, { ...opts, timeoutMs: 150 }),
      "unknown"
    )
    assert.equal(unknown.reason, "timeout")
    assert.equal(unknown.error.code, "WAIT_TIMEOUT")
    assert.match(unknown.error.message, /Do not resubmit/)
    assert.equal(isTerminalStatus(unknown), false)
    await assert.rejects(
      cancelInvoice(1, ctx(ADDR.client)),
      (e) => e instanceof ChainWriteError && e.code === "DUPLICATE_SUBMISSION"
    )
  })

  it("unknown (rpc_error): sanitized, never contains the endpoint", async () => {
    const { ctx } = setup()
    const submitted = await cancelInvoice(1, ctx(ADDR.client))
    const publicClient = {
      waitForTransactionReceipt: async () => {
        throw new Error("fetch failed https://secret.example/v2/KEY123")
      },
    } as unknown as ChainWriteClient
    const unknown = expectState(
      await trackTransaction(submitted, { publicClient }),
      "unknown"
    )
    assert.equal(unknown.reason, "rpc_error")
    assert.doesNotMatch(unknown.error.message, /KEY123|secret\.example/)
    assert.equal(unknown.error.txHash, submitted.hash)
  })

  it("unverified: a successful receipt without the expected event is not success", async () => {
    const { chain, ctx, opts } = setup()
    const submitted = await fundInvoice(1, ctx(ADDR.client))
    chain.mine(submitted.hash, "success", [])
    const unverified = expectState(
      await trackTransaction(submitted, opts),
      "unverified"
    )
    assert.equal(unverified.error.code, "RECEIPT_MISMATCH")
    assert.match(unverified.error.message, /not treating it as proof/)
    assert.ok(unverified.receipt)
    assert.equal(isTerminalStatus(unverified), true)
  })

  it("a bare hash confirms only as unverified-success (verified: false, no event)", async () => {
    const { chain, ctx, opts } = setup()
    const submitted = await fundInvoice(1, ctx(ADDR.client))
    chain.mine(submitted.hash, "success", [])
    const confirmed = expectState(
      await trackTransaction(submitted.hash, opts),
      "confirmed"
    )
    assert.equal(confirmed.verified, false)
    assert.equal(confirmed.event, null)
    assert.equal(confirmed.invoiceId, null)
    assert.equal(confirmed.functionName, undefined)
  })

  it("only an invalid hash throws", async () => {
    await assert.rejects(
      trackTransaction("0x123"),
      (e) => e instanceof ChainWriteError && e.code === "INVALID_INPUT"
    )
  })

  it("waitForConfirmation throws exactly the error carried by the matching status", async () => {
    const { chain, ctx, opts } = setup()
    const a = await cancelInvoice(1, ctx(ADDR.client))
    chain.mine(a.hash, "reverted")
    const status = expectState(await trackTransaction(a, opts), "reverted")
    submissionGuard.reset()
    const b = await raiseDispute(2, ctx(ADDR.client))
    chain.mine(b.hash, "reverted")
    await assert.rejects(
      waitForConfirmation(b, opts),
      (e) => e instanceof ChainWriteError && e.code === status.error.code
    )
  })

  it("isTerminalStatus: confirmed, reverted, replaced, unverified are final; pending and unknown are not", () => {
    const states: [TransactionState, boolean][] = [
      ["pending", false],
      ["unknown", false],
      ["confirmed", true],
      ["reverted", true],
      ["replaced", true],
      ["unverified", true],
    ]
    for (const [state, terminal] of states) {
      assert.equal(
        isTerminalStatus({ state } as unknown as TransactionStatus),
        terminal,
        state
      )
    }
  })
})

describe("getTransactionStatus: one non-blocking look", () => {
  it("pending when the transaction is known but not mined, without waiting or sending", async () => {
    const { chain, ctx } = setup()
    const submitted = await fundInvoice(1, ctx(ADDR.client))
    chain.registerPending(submitted.hash)
    const sentBefore = chain.sent.length
    const pending = expectState(
      await getTransactionStatus(submitted, {
        publicClient: chain.publicClient,
      }),
      "pending"
    )
    assert.equal(pending.submittedAt, submitted.submittedAt)
    assert.equal(chain.sent.length, sentBefore)
  })

  it("unknown/not_found when neither mined nor in the mempool", async () => {
    const { ctx, chain } = setup()
    const submitted = await fundInvoice(1, ctx(ADDR.client))
    const unknown = expectState(
      await getTransactionStatus(submitted, {
        publicClient: chain.publicClient,
      }),
      "unknown"
    )
    assert.equal(unknown.reason, "not_found")
    assert.match(unknown.error.message, /Do not resubmit/)
  })

  it("confirmed, unverified and reverted from a receipt, releasing the duplicate guard", async () => {
    const { chain, ctx } = setup()
    const o = { publicClient: chain.publicClient }
    const a = await fundInvoice(1, ctx(ADDR.client))
    chain.mine(a.hash, "success", [fundedLog()])
    const confirmed = expectState(await getTransactionStatus(a, o), "confirmed")
    assert.equal(confirmed.invoiceId, "1")
    assert.equal(submissionGuard.size(), 0)

    const b = await cancelInvoice(1, ctx(ADDR.client))
    chain.mine(b.hash, "success", [])
    expectState(await getTransactionStatus(b, o), "unverified")

    const c = await raiseDispute(2, ctx(ADDR.client))
    chain.mine(c.hash, "reverted")
    expectState(await getTransactionStatus(c, o), "reverted")
  })

  it("unknown/rpc_error is sanitized", async () => {
    const { ctx } = setup()
    const submitted = await cancelInvoice(1, ctx(ADDR.client))
    const publicClient = {
      getTransactionReceipt: async () => {
        throw new Error("boom https://secret.example/KEY999")
      },
    } as unknown as ChainWriteClient
    const unknown = expectState(
      await getTransactionStatus(submitted, { publicClient }),
      "unknown"
    )
    assert.equal(unknown.reason, "rpc_error")
    assert.doesNotMatch(unknown.error.message, /KEY999|secret\.example/)
  })
})

function receiptWith(
  logs: unknown[],
  extra: Partial<TransactionReceipt> = {}
): TransactionReceipt {
  return {
    status: "success",
    logs,
    transactionHash: "0x" + "ab".repeat(32),
    blockNumber: B(9),
    ...extra,
  } as unknown as TransactionReceipt
}

describe("invoice ID extraction never guesses", () => {
  it("returns the ID for exactly one InvoiceCreated, null for none, and ignores everything else", () => {
    assert.equal(getInvoiceIdFromReceipt(receiptWith([createdLog(B(7))])), B(7))
    assert.equal(getInvoiceIdFromReceipt(receiptWith([])), null)
    assert.equal(getInvoiceIdFromReceipt(receiptWith([fundedLog()])), null)
    assert.equal(
      getInvoiceIdFromReceipt(receiptWith([fundedLog(), createdLog(B(7))])),
      B(7)
    )
    // an InvoiceCreated-shaped log from some other contract is not ours
    assert.equal(
      getInvoiceIdFromReceipt(
        receiptWith([{ ...createdLog(B(8)), address: ADDR.stranger }])
      ),
      null
    )
  })

  it("refuses to choose between multiple InvoiceCreated events", () => {
    const receipt = receiptWith([createdLog(B(7)), createdLog(B(8))])
    assert.throws(
      () => getInvoiceIdFromReceipt(receipt),
      (e) =>
        e instanceof ChainWriteError &&
        e.code === "RECEIPT_MISMATCH" &&
        /refusing to guess/.test(e.message)
    )
  })

  it("a filter selects the intended event by client, freelancer, amount or metadataHash", () => {
    const other = ("0x" + "77".repeat(32)) as Hex
    const receipt = receiptWith([
      createdLog(B(7), { client: ADDR.stranger }),
      createdLog(B(8), { amount: B(5) }),
      createdLog(B(9), { metadataHash: other, freelancer: ADDR.operator }),
    ])
    assert.equal(
      getInvoiceIdFromReceipt(receipt, { client: ADDR.stranger.toLowerCase() }),
      B(7)
    )
    assert.equal(getInvoiceIdFromReceipt(receipt, { amount: B(5) }), B(8))
    assert.equal(
      getInvoiceIdFromReceipt(receipt, { metadataHash: other }),
      B(9)
    )
    assert.equal(
      getInvoiceIdFromReceipt(receipt, { freelancer: ADDR.operator }),
      B(9)
    )
    assert.equal(
      getInvoiceIdFromReceipt(receipt, { client: ADDR.freelancer }),
      null
    )
    assert.throws(() =>
      getInvoiceIdFromReceipt(receipt, { freelancer: ADDR.freelancer })
    )
  })

  it("a verified createInvoice confirmation picks the event matching ALL submitted terms", async () => {
    const { chain, ctx, opts } = setup()
    const submitted = await createInvoice(
      { freelancer: ADDR.freelancer, amount: AMOUNT, metadataHash: META },
      ctx(ADDR.client)
    )
    chain.mine(submitted.hash, "success", [
      createdLog(B(6), { client: ADDR.stranger }),
      createdLog(B(7)),
    ])
    const confirmed = expectState(
      await trackTransaction(submitted, opts),
      "confirmed"
    )
    assert.equal(confirmed.invoiceId, "7")
  })

  it("two identical InvoiceCreated events make the result ambiguous, so it is unverified", async () => {
    const { chain, ctx, opts } = setup()
    const submitted = await createInvoice(
      { freelancer: ADDR.freelancer, amount: AMOUNT, metadataHash: META },
      ctx(ADDR.client)
    )
    chain.mine(submitted.hash, "success", [createdLog(B(6)), createdLog(B(7))])
    const unverified = expectState(
      await trackTransaction(submitted, opts),
      "unverified"
    )
    assert.match(unverified.error.message, /ambiguous/)
  })

  it("a confirmation with no matching creation event is unverified, not an invented ID", async () => {
    const { chain, ctx, opts } = setup()
    const submitted = await createInvoice(
      { freelancer: ADDR.freelancer, amount: AMOUNT, metadataHash: META },
      ctx(ADDR.client)
    )
    chain.mine(submitted.hash, "success", [createdLog(B(7), { amount: B(1) })])
    expectState(await trackTransaction(submitted, opts), "unverified")
  })
})

// ---- audit: event signatures vs the real ABI and docs/CONTRACT_SPEC.md ------------------------

interface SpecParam {
  type: string
  indexed: boolean
  name: string
}

function specEvents(): Map<string, SpecParam[]> {
  const doc = readFileSync(
    new URL("../../docs/CONTRACT_SPEC.md", import.meta.url),
    "utf8"
  )
  const events = new Map<string, SpecParam[]>()
  for (const [, name, params] of doc.matchAll(/^event (\w+)\(([^)]*)\);$/gm)) {
    events.set(
      name,
      params.split(",").map((p) => {
        const words = p.trim().split(/\s+/)
        return {
          type: words[0],
          indexed: words.includes("indexed"),
          name: words[words.length - 1],
        }
      })
    )
  }
  return events
}

describe("event audit: ABI vs docs/CONTRACT_SPEC.md §6", () => {
  const allAbiEvents = invoiceAdvanceAbi.filter((x) => x.type === "event")
  const spec = specEvents()
  // Inherited from OpenZeppelin AccessControl; not part of the spec's nine.
  const INHERITED = ["RoleAdminChanged", "RoleGranted", "RoleRevoked"]
  const abiEvents = allAbiEvents.filter((e) => spec.has(e.name))

  it("the spec lists nine events; the ABI has exactly those plus OZ's three AccessControl events", () => {
    assert.equal(spec.size, 9)
    assert.deepEqual(
      abiEvents.map((e) => e.name).sort(),
      [...spec.keys()].sort()
    )
    assert.deepEqual(
      allAbiEvents
        .map((e) => e.name)
        .filter((n) => !spec.has(n))
        .sort(),
      INHERITED
    )
  })

  it("names, argument types, argument names, indexing and topic0 all match the spec", () => {
    for (const event of abiEvents) {
      const want = spec.get(event.name)!
      assert.deepEqual(
        event.inputs.map((i) => ({
          type: i.type,
          indexed: i.indexed,
          name: i.name,
        })),
        want,
        event.name
      )
      const signature = `${event.name}(${want.map((p) => p.type).join(",")})`
      assert.equal(
        toEventSelector(event),
        keccak256(stringToHex(signature)),
        signature
      )
    }
  })

  it("every expected-event argument exists on the real event, with a value kind we validate", () => {
    const tokenEvents = mockUsdcAbi.filter((x) => x.type === "event")
    for (const [fn, spec] of Object.entries(EXPECTED_EVENTS)) {
      const source =
        spec.contract === "invoiceAdvance" ? abiEvents : tokenEvents
      const event = source.find((e) => e.name === spec.eventName)
      assert.ok(event, `${fn}: event ${spec.eventName} must exist in the ABI`)
      const inputs = new Map(event.inputs.map((i) => [i.name, i.type]))
      for (const arg of spec.args) {
        assert.ok(
          inputs.has(arg),
          `${fn}: ${spec.eventName} has no argument ${arg}`
        )
        const kind = ARG_KINDS[arg as keyof typeof ARG_KINDS]
        const type = inputs.get(arg)!
        const okType = {
          address: "address",
          bytes32: "bytes32",
          uint: "uint256",
          bool: "bool",
        }[kind]
        assert.equal(type, okType, `${fn}.${arg}`)
      }
    }
  })

  it("decodeInvoiceAdvanceEvents decodes every spec event with its arguments", () => {
    const sample = (type: string): unknown =>
      ({ uint256: B(5), address: ADDR.client, bytes32: META, bool: true })[type]
    for (const event of abiEvents) {
      const args = Object.fromEntries(
        event.inputs.map((i) => [i.name, sample(i.type)])
      )
      const [decoded, ...rest] = decodeInvoiceAdvanceEvents(
        receiptWith([eventLog("invoiceAdvance", event.name, args)])
      )
      assert.equal(rest.length, 0)
      assert.equal(decoded.eventName, event.name)
      for (const [name, value] of Object.entries(args)) {
        assert.equal(
          (decoded.args as Record<string, unknown>)[name],
          value,
          `${event.name}.${name}`
        )
      }
    }
  })

  it("every write operation attaches the table's evidence and nothing else", async () => {
    const { chain, ctx } = setup()
    const calls: [string, Promise<SubmittedTransaction>][] = [
      [
        "createInvoice",
        createInvoice(
          { freelancer: ADDR.freelancer, amount: AMOUNT, metadataHash: META },
          ctx(ADDR.client)
        ),
      ],
      ["cancelInvoice", cancelInvoice(1, ctx(ADDR.client))],
      ["fundInvoice", fundInvoice(1, ctx(ADDR.client))],
      ["approveCompletion", approveCompletion(2, ctx(ADDR.client))],
      ["raiseDispute", raiseDispute(3, ctx(ADDR.client))],
      ["resolveDispute", resolveDispute(4, true, ctx(ADDR.operator))],
      ["approveAdvance", approveAdvance(2, EVAL, ctx(ADDR.evaluator))],
      ["depositReserve", depositReserve(B(7), ctx(ADDR.operator))],
      ["withdrawReserve", withdrawReserve(B(7), ctx(ADDR.operator))],
      [
        "approve",
        approveToken(
          { spender: ADDR.operator, amount: B(7) },
          ctx(ADDR.client)
        ),
      ],
    ]
    assert.deepEqual(
      calls.map(([name]) => name).sort(),
      Object.keys(EXPECTED_EVENTS).sort()
    )
    for (const [name, pending] of calls) {
      const submitted = await pending
      const spec = EXPECTED_EVENTS[name as keyof typeof EXPECTED_EVENTS]
      assert.equal(submitted.expected.contract, spec.contract, name)
      assert.equal(submitted.expected.eventName, spec.eventName, name)
      assert.deepEqual(
        Object.keys(submitted.expected.args).sort(),
        [...spec.args].sort(),
        name
      )
      assert.equal(submitted.functionName, name)
    }
    assert.equal(chain.sent.length, 10)
  })
})

describe("persistence: resume tracking after a reload", () => {
  async function allSubmitted() {
    const { chain, ctx, opts } = setup()
    const list = [
      await createInvoice(
        { freelancer: ADDR.freelancer, amount: AMOUNT, metadataHash: META },
        ctx(ADDR.client)
      ),
      await cancelInvoice(1, ctx(ADDR.client)),
      await fundInvoice(1, ctx(ADDR.client)),
      await approveCompletion(2, ctx(ADDR.client)),
      await raiseDispute(3, ctx(ADDR.client)),
      await resolveDispute(4, false, ctx(ADDR.operator)),
      await approveAdvance(2, EVAL, ctx(ADDR.evaluator)),
      await depositReserve(B(7), ctx(ADDR.operator)),
      await withdrawReserve(B(7), ctx(ADDR.operator)),
      await approveToken(
        { spender: ADDR.operator, amount: B(7) },
        ctx(ADDR.client)
      ),
    ]
    return { chain, ctx, opts, list }
  }

  it("round-trips every operation exactly, bigints included", async () => {
    const { list } = await allSubmitted()
    for (const submitted of list) {
      const json = serializeSubmittedTransaction(submitted)
      assert.doesNotThrow(() => JSON.parse(json))
      assert.deepEqual(
        parseSubmittedTransaction(json),
        submitted,
        submitted.functionName
      )
    }
  })

  it("a parsed transaction can be tracked to a verified confirmation", async () => {
    const { chain, ctx, opts } = setup()
    const submitted = await fundInvoice(1, ctx(ADDR.client))
    const stored = serializeSubmittedTransaction(submitted)
    chain.mine(submitted.hash, "success", [fundedLog()])
    const resumed = await trackTransaction(
      parseSubmittedTransaction(stored),
      opts
    )
    assert.equal(expectState(resumed, "confirmed").invoiceId, "1")
  })

  it("rejects tampered, truncated or inconsistent stored data", async () => {
    const { list } = await allSubmitted()
    interface Stored {
      [key: string]: unknown
      from: string
      expected: { [key: string]: unknown; args: Record<string, unknown> }
    }
    const fund: Stored = JSON.parse(serializeSubmittedTransaction(list[2]))
    const create: Stored = JSON.parse(serializeSubmittedTransaction(list[0]))
    const mutate = (base: Stored, change: (o: Stored) => void) => {
      const copy = JSON.parse(JSON.stringify(base))
      change(copy)
      return JSON.stringify(copy)
    }
    const bad: [string, string][] = [
      ["not json", "{"],
      ["not an object", "[]"],
      ["null", "null"],
      ["wrong version", mutate(fund, (o) => (o.version = 2))],
      ["short hash", mutate(fund, (o) => (o.hash = "0x1234"))],
      ["non-hex hash", mutate(fund, (o) => (o.hash = "0x" + "zz".repeat(32)))],
      ["unknown function", mutate(fund, (o) => (o.functionName = "grantRole"))],
      [
        "prototype key as function",
        mutate(fund, (o) => (o.functionName = "constructor")),
      ],
      [
        "bad sender checksum",
        mutate(
          fund,
          (o) =>
            (o.from =
              o.from.slice(0, 5) +
              o.from
                .slice(5)
                .toLowerCase()
                .replace(/[a-f]/, (c: string) => c.toUpperCase()))
        ),
      ],
      ["wrong chain", mutate(fund, (o) => (o.chainId = 1))],
      ["bad submittedAt", mutate(fund, (o) => (o.submittedAt = -1))],
      [
        "event name swapped",
        mutate(fund, (o) => (o.expected.eventName = "InvoiceCancelled")),
      ],
      [
        "contract swapped",
        mutate(fund, (o) => (o.expected.contract = "paymentToken")),
      ],
      ["missing argument", mutate(fund, (o) => delete o.expected.args.client)],
      ["extra argument", mutate(fund, (o) => (o.expected.args.evil = "x"))],
      [
        "negative bigint",
        mutate(fund, (o) => (o.expected.args.invoiceId = { $bigint: "-1" })),
      ],
      [
        "fractional bigint",
        mutate(fund, (o) => (o.expected.args.invoiceId = { $bigint: "1.5" })),
      ],
      [
        "bigint over uint256",
        mutate(
          fund,
          (o) =>
            (o.expected.args.invoiceId = {
              $bigint: (MAX_UINT256 + B(1)).toString(),
            })
        ),
      ],
      [
        "bigint not tagged",
        mutate(fund, (o) => (o.expected.args.invoiceId = "1")),
      ],
      ["address wrong type", mutate(fund, (o) => (o.expected.args.client = 5))],
      [
        "bytes32 too short",
        mutate(create, (o) => (o.expected.args.metadataHash = "0x12")),
      ],
    ]
    for (const [label, json] of bad) {
      assert.throws(
        () => parseSubmittedTransaction(json),
        (e) =>
          e instanceof ChainWriteError &&
          e.code === "INVALID_INPUT" &&
          /malformed/.test(e.message),
        label
      )
    }
  })

  it("the explorer link is recomputed from the hash, never trusted from storage", async () => {
    const { list } = await allSubmitted()
    const stored = JSON.parse(serializeSubmittedTransaction(list[2]))
    stored.explorerUrl = "https://evil.example/phish"
    assert.equal(
      parseSubmittedTransaction(JSON.stringify(stored)).explorerUrl,
      explorerTxUrl(list[2].hash)
    )
  })
})

describe("explorer links", () => {
  const hash = "0x" + "ab".repeat(32)

  it("builds links for transactions, addresses and blocks", () => {
    assert.equal(
      explorerTxUrl(hash),
      `https://explorer.testnet.xrplevm.org/tx/${hash}`
    )
    assert.equal(
      explorerAddressUrl(IA),
      `https://explorer.testnet.xrplevm.org/address/${IA}`
    )
    assert.equal(
      explorerBlockUrl(B(9225149)),
      "https://explorer.testnet.xrplevm.org/block/9225149"
    )
    assert.equal(
      explorerBlockUrl(0),
      "https://explorer.testnet.xrplevm.org/block/0"
    )
  })

  it("rejects anything that could alter the path or query", () => {
    const badHashes = [
      `${hash}/../x`,
      `${hash}?a=b`,
      `${hash}#x`,
      ` ${hash}`,
      `${hash} `,
      "0x123",
      "javascript:alert(1)",
      "",
      hash.slice(0, -1),
      "0x" + "zz".repeat(32),
      `${hash}\n`,
    ]
    for (const bad of badHashes) {
      assert.throws(() => explorerTxUrl(bad), TypeError, JSON.stringify(bad))
      assert.equal(tryExplorerTxUrl(bad), null)
    }
    for (const bad of [`${IA}/x`, `${IA}?x`, "0x12", "", IA.slice(0, -1)]) {
      assert.throws(() => explorerAddressUrl(bad), TypeError)
      assert.equal(tryExplorerAddressUrl(bad), null)
    }
    for (const bad of [-1, 1.5, NaN, Infinity, B(-1)] as (number | bigint)[]) {
      assert.throws(() => explorerBlockUrl(bad), TypeError, String(bad))
    }
    assert.throws(() => explorerTxUrl(5 as unknown as string), TypeError)
  })

  it("submitted and settled transactions carry ready-made links", async () => {
    const { chain, ctx, opts } = setup()
    const submitted = await cancelInvoice(1, ctx(ADDR.client))
    chain.mine(submitted.hash, "reverted")
    const status = await trackTransaction(submitted, opts)
    assert.equal(submitted.explorerUrl, explorerTxUrl(submitted.hash))
    assert.equal(status.explorerUrl, submitted.explorerUrl)
  })
})

describe("public API surface", () => {
  it("exports the lifecycle API and keeps internals private", async () => {
    const sdk = (await import("./index")) as Record<string, unknown>
    for (const name of [
      "trackTransaction",
      "getTransactionStatus",
      "waitForConfirmation",
      "isTerminalStatus",
      "serializeSubmittedTransaction",
      "parseSubmittedTransaction",
      "getInvoiceIdFromReceipt",
      "decodeInvoiceAdvanceEvents",
      "explorerTxUrl",
      "explorerBlockUrl",
      "tryExplorerTxUrl",
      "EXPECTED_EVENTS",
      "submissionGuard",
    ]) {
      assert.ok(name in sdk, `missing export ${name}`)
    }
    for (const name of [
      "releaseByHash",
      "mapWriteError",
      "expectedFor",
      "ARG_KINDS",
      "isWriteFunctionName",
    ]) {
      assert.ok(!(name in sdk), `${name} must not be public`)
    }
  })
})
