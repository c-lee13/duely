import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  getEscrowAllowance,
  getInvoice,
  getReserveSnapshot,
  getTokenBalance,
  waitForBlock,
} from "../../lib/chain/index"
import type { ConfirmedTransaction } from "../../lib/chain/lifecycle"
import type { SubmittedTransaction } from "../../lib/chain/writes"
import type { Config, LiveState } from "./flow"
import { mismatches, readState } from "./flow"
import { buildPlan, type Snapshot } from "./plan"
import {
  VerificationError,
  classifyOutcome,
  runSteps,
  type RunStep,
} from "./run"
import { verifyAtBlock } from "./verify"

const B = (n: number | string) => BigInt(n)
const D = (n: number) => BigInt(Math.round(n * 1e6))

const CLIENT = "0x8d93eD20e6eD28c34aE0057f441ED97d3e63459E"
const FREELANCER = "0x02379033ECD642D9A9aA590ABe763D62AEa967F4"
const OPERATOR = "0x6e83F6Bb6758Ced46e60be88271D72C22B84482E"
const IA = "0x328fc0DbF3d1F704B065192f4bFC7583bfA550E0"

const cfg = {
  addresses: {
    client: CLIENT,
    freelancer: FREELANCER,
    operator: OPERATOR,
    evaluator: "0x276acaB037BB048a682E0E7ad900F3fFDCe65ECb",
  },
} as unknown as Config

// The real numbers from the live run (invoice #2): advance at block 9226979, settlement at 9226980.
const ADVANCE_BLOCK = B(9226979)
const SETTLE_BLOCK = B(9226980)

interface ChainAt {
  reserve: bigint
  escrow: bigint
  balances: Record<string, bigint>
  invoiceStatus: number
}
const AFTER_ADVANCE: ChainAt = {
  reserve: D(9910),
  escrow: D(100),
  balances: {
    [IA.toLowerCase()]: D(10010),
    [CLIENT.toLowerCase()]: B(0),
    [FREELANCER.toLowerCase()]: D(1090),
    [OPERATOR.toLowerCase()]: B(0),
  },
  invoiceStatus: 2,
}
const SETTLED: ChainAt = {
  reserve: D(10000),
  escrow: B(0),
  balances: {
    [IA.toLowerCase()]: D(10000),
    [CLIENT.toLowerCase()]: B(0),
    [FREELANCER.toLowerCase()]: D(1100),
    [OPERATOR.toLowerCase()]: B(0),
  },
  invoiceStatus: 3,
}

/** A fake clock that advances 5 ms per reading, so a regression times out in microseconds, not minutes. */
const boundedClock = () => {
  let t = 0
  return () => (t += 5)
}
const noSleep = async () => undefined

const initial: Snapshot = {
  amount: D(100),
  reserveBalance: D(10000),
  totalEscrow: B(0),
  contractDusd: D(10000),
  clientDusd: D(100),
  clientAllowance: B(0),
  operatorDusd: B(0),
  freelancerDusd: D(1000),
  gasBalance: { client: D(1e6), evaluator: D(1e6), operator: D(1e6) },
  gasPrice: B(1),
}
const plan = buildPlan(initial)

/**
 * A fake chain client modelling an RPC fronted by several nodes:
 *  - `reportedHead()` is what getBlockNumber says (can be stale: cached, or from a lagging node);
 *  - pinned reads are answered from the state at the requested block, and fail like a real node
 *    ("header not found") if that block is newer than `nodeHead`;
 *  - unpinned ("latest") reads are served by a fresh node at `latestHead`.
 */
function fakeClient(model: {
  states: Map<bigint, ChainAt>
  reportedHead: () => bigint
  nodeHead: () => bigint
  latestHead: () => bigint
  failPinnedOnce?: boolean
  stalePinnedOnce?: { block: bigint; serve: bigint }
}) {
  const log: {
    kind: "head" | "read"
    fn?: string
    block?: bigint | undefined
    cacheTime?: number
  }[] = []
  let failedOnce = false
  let staleServed = false
  const client = {
    async getBlockNumber(args?: { cacheTime?: number }) {
      const head = model.reportedHead()
      log.push({ kind: "head", block: head, cacheTime: args?.cacheTime })
      return head
    },
    async readContract(args: {
      functionName: string
      args?: readonly unknown[]
      blockNumber?: bigint
    }) {
      log.push({ kind: "read", fn: args.functionName, block: args.blockNumber })
      let at: bigint
      if (args.blockNumber === undefined) at = model.latestHead()
      else {
        if (args.blockNumber > model.nodeHead())
          throw new Error("header not found")
        if (model.failPinnedOnce && !failedOnce) {
          failedOnce = true
          throw new Error("temporary node error")
        }
        at = args.blockNumber
        if (
          model.stalePinnedOnce &&
          args.blockNumber === model.stalePinnedOnce.block &&
          !staleServed
        ) {
          staleServed = true
          at = model.stalePinnedOnce.serve // a node that answers with an older block's state
        }
      }
      const state = model.states.get(at)!
      switch (args.functionName) {
        case "reserveBalance":
        case "availableReserve":
          return state.reserve
        case "totalEscrow":
          return state.escrow
        case "balanceOf":
          return state.balances[String(args.args![0]).toLowerCase()] ?? B(0)
        case "allowance":
          return B(0)
        case "getInvoice":
          return {
            freelancer: FREELANCER,
            client: CLIENT,
            amount: D(100),
            advanceAmount: D(90),
            metadataHash: "0x" + "11".repeat(32),
            evaluationHash: "0x" + "22".repeat(32),
            status: state.invoiceStatus,
          }
        default:
          throw new Error(`unhandled ${args.functionName}`)
      }
    },
  }
  return { client: client as never, log }
}

const states = () =>
  new Map([
    [ADVANCE_BLOCK, AFTER_ADVANCE],
    [SETTLE_BLOCK, SETTLED],
  ])

/** The OLD verification read, verbatim in structure: a snapshot pinned to getBlockNumber(), every other read "latest". */
async function legacyReadState(client: never): Promise<LiveState> {
  const opts = { client }
  const [
    snap,
    clientDusd,
    freelancerDusd,
    clientAllowance,
    operatorAllowance,
    invoice,
  ] = await Promise.all([
    getReserveSnapshot(opts),
    getTokenBalance(CLIENT, opts),
    getTokenBalance(FREELANCER, opts),
    getEscrowAllowance(CLIENT, opts),
    getEscrowAllowance(OPERATOR, opts),
    getInvoice(2, opts),
  ])
  return {
    invoiceStatus: invoice.statusName,
    advanceAmount: invoice.advanceAmount,
    reserve: snap.reserveBalance,
    escrow: snap.totalEscrow,
    solvent: snap.solvent,
    clientDusd,
    freelancerDusd,
    contractDusd: snap.contractTokenBalance,
    clientAllowance,
    operatorAllowance,
  }
}

describe("REGRESSION: the post-settlement verification that misreported a completed settlement", () => {
  // The incident: getBlockNumber() answered 9226979 although the settlement receipt was in 9226980.
  const lagging = () =>
    fakeClient({
      states: states(),
      reportedHead: () => ADVANCE_BLOCK, // stale: cached, or a lagging node
      nodeHead: () => SETTLE_BLOCK,
      latestHead: () => SETTLE_BLOCK, // "latest" reads reach a fresh node
    })

  it("reproduces the observed symptom with the old unpinned reads", async () => {
    const { client } = lagging()
    const state = await legacyReadState(client)
    const diffs = mismatches(plan.final, state)
    // Exactly what the live run printed:
    assert.equal(
      state.invoiceStatus,
      "Settled",
      "the invoice read saw the settlement"
    )
    assert.equal(state.reserve, D(9910))
    assert.equal(state.escrow, D(100))
    assert.equal(state.contractDusd, D(10010))
    assert.deepEqual(diffs.map((d) => d.split(":")[0]).sort(), [
      "contract dUSD",
      "reserveBalance",
      "totalEscrow",
    ])
    assert.equal(
      state.freelancerDusd,
      D(1100),
      "unpinned balance reads were fresh, so the snapshot was mixed"
    )
  })

  it("the old snapshot was internally consistent but stale: it equals the chain state one block earlier", () => {
    assert.equal(
      AFTER_ADVANCE.reserve + AFTER_ADVANCE.escrow,
      AFTER_ADVANCE.balances[IA.toLowerCase()]
    )
  })

  it("reading everything at the receipt block yields one coherent, correct snapshot", async () => {
    const { client, log } = lagging()
    const state = await readState(cfg, client, B(2), SETTLE_BLOCK)
    assert.deepEqual(mismatches(plan.final, state), [])
    assert.equal(state.invoiceStatus, "Settled")
    const reads = log.filter((e) => e.kind === "read")
    assert.ok(reads.length >= 8)
    for (const read of reads)
      assert.equal(
        read.block,
        SETTLE_BLOCK,
        `${read.fn} must be pinned to the receipt block`
      )
    assert.ok(
      !log.some((e) => e.kind === "head"),
      "a pinned snapshot never asks the RPC for its head"
    )
  })

  it("verifyAtBlock waits until the RPC reaches the receipt block before reading anything", async () => {
    const heads = [B(9226978), B(9226979), B(9226979), SETTLE_BLOCK]
    let polls = 0
    const { client, log } = fakeClient({
      states: states(),
      // after the wait polls, a further head request lands on a lagging node again
      reportedHead: () => heads[polls++] ?? ADVANCE_BLOCK,
      nodeHead: () => SETTLE_BLOCK,
      latestHead: () => SETTLE_BLOCK,
    })
    let slept = 0
    const state = await verifyAtBlock({
      block: SETTLE_BLOCK,
      waitForBlock: (b) =>
        waitForBlock(b, {
          client,
          pollMs: 1,
          timeoutMs: 100,
          now: boundedClock(),
          sleep: async () => void (slept += 1),
        }),
      read: (b) => readState(cfg, client, B(2), b),
      compare: (s) => mismatches(plan.final, s),
      options: { attempts: 3, sleep: noSleep },
    })
    assert.equal(state.invoiceStatus, "Settled")
    assert.equal(slept, 3, "polled while the RPC was behind")
    const firstRead = log.findIndex((e) => e.kind === "read")
    const lastHeadBeforeRead = log
      .slice(0, firstRead)
      .filter((e) => e.kind === "head")
      .pop()!
    assert.ok(
      lastHeadBeforeRead.block! >= SETTLE_BLOCK,
      "no state was read before the head reached the receipt block"
    )
    assert.ok(
      log.filter((e) => e.kind === "head").every((e) => e.cacheTime === 0),
      "heads are never taken from the client cache"
    )
  })

  it("retries a transient node error ('header not found' style) instead of failing the check", async () => {
    const { client } = fakeClient({
      states: states(),
      reportedHead: () => SETTLE_BLOCK,
      nodeHead: () => SETTLE_BLOCK,
      latestHead: () => SETTLE_BLOCK,
      failPinnedOnce: true,
    })
    const sleeps: number[] = []
    const state = await verifyAtBlock({
      block: SETTLE_BLOCK,
      waitForBlock: async () => undefined,
      read: (b) => readState(cfg, client, B(2), b),
      compare: (s) => mismatches(plan.final, s),
      options: {
        attempts: 3,
        backoffMs: 10,
        sleep: async (ms) => void sleeps.push(ms),
      },
    })
    assert.equal(state.invoiceStatus, "Settled")
    assert.deepEqual(sleeps, [10], "one backoff, then success")
  })

  it("a node that answers once with older state does not decide the outcome: it re-reads and passes", async () => {
    const { client } = fakeClient({
      states: states(),
      reportedHead: () => SETTLE_BLOCK,
      nodeHead: () => SETTLE_BLOCK,
      latestHead: () => SETTLE_BLOCK,
      stalePinnedOnce: { block: SETTLE_BLOCK, serve: ADVANCE_BLOCK },
    })
    let reads = 0
    const state = await verifyAtBlock({
      block: SETTLE_BLOCK,
      waitForBlock: async () => undefined,
      read: (b) => (reads++, readState(cfg, client, B(2), b)),
      compare: (s) => mismatches(plan.final, s),
      options: { attempts: 3, backoffMs: 1, sleep: async () => undefined },
    })
    assert.equal(reads, 2, "the stale answer was re-read once")
    assert.equal(state.reserve, D(10000))
  })

  it("an RPC that never reaches the receipt block is 'unavailable', not a failed check", async () => {
    const { client } = fakeClient({
      states: states(),
      reportedHead: () => ADVANCE_BLOCK,
      nodeHead: () => ADVANCE_BLOCK,
      latestHead: () => ADVANCE_BLOCK,
    })
    let slept = 0
    await assert.rejects(
      verifyAtBlock({
        block: SETTLE_BLOCK,
        waitForBlock: (b) =>
          waitForBlock(b, {
            client,
            timeoutMs: 5,
            pollMs: 1,
            sleep: async () => undefined,
            now: (() => {
              let t = 0
              return () => (t += 10)
            })(),
          }),
        read: (b) => readState(cfg, client, B(2), b),
        compare: (s) => mismatches(plan.final, s),
        options: {
          attempts: 3,
          backoffMs: 1,
          sleep: async () => void (slept += 1),
        },
      }),
      (e) =>
        e instanceof VerificationError &&
        e.kind === "unavailable" &&
        /block 9226980/.test(e.message) &&
        /attempt 3 of 3/.test(e.message)
    )
    assert.equal(slept, 2)
  })

  it("a consistent snapshot at the receipt block that disagrees is a definitive 'mismatch'", async () => {
    const wrong = new Map([[SETTLE_BLOCK, { ...SETTLED, reserve: D(9999) }]])
    const { client } = fakeClient({
      states: wrong,
      reportedHead: () => SETTLE_BLOCK,
      nodeHead: () => SETTLE_BLOCK,
      latestHead: () => SETTLE_BLOCK,
    })
    await assert.rejects(
      verifyAtBlock({
        block: SETTLE_BLOCK,
        waitForBlock: async () => undefined,
        read: (b) => readState(cfg, client, B(2), b),
        compare: (s) => mismatches(plan.final, s),
        options: { attempts: 2, backoffMs: 1, sleep: async () => undefined },
      }),
      (e) =>
        e instanceof VerificationError &&
        e.kind === "mismatch" &&
        /reserveBalance: expected 10000000000, found 9999000000/.test(e.message)
    )
  })
})

// ---- the runner: a confirmed transaction stays confirmed whatever the follow-up check says --------

function submitted(n: number): SubmittedTransaction {
  const hash = "0x" + n.toString(16).padStart(64, "0")
  return {
    hash,
    functionName: `fn${n}`,
    explorerUrl: `https://explorer.example/tx/${hash}`,
  } as unknown as SubmittedTransaction
}
const confirmedStatus = (n: number) =>
  ({
    state: "confirmed",
    hash: submitted(n).hash,
    requestedHash: submitted(n).hash,
    blockNumber: B(9226975 + n),
    explorerUrl: submitted(n).explorerUrl,
    invoiceId: "2",
    verified: true,
    event: {
      eventName: "InvoiceSettled",
      args: { invoiceId: B(2), reserveRepaid: D(90), freelancerPaid: D(10) },
    },
  }) as unknown as ConfirmedTransaction

function step(n: number, verify?: RunStep["verify"]): RunStep {
  return {
    id: `s${n}`,
    label: `Step ${n}`,
    signer: "client",
    submit: async () => submitted(n),
    verify,
  }
}

describe("runner: a confirmed transaction is never reported as a failed one", () => {
  const track = async (s: SubmittedTransaction) =>
    confirmedStatus(Number(BigInt(s.hash)))

  it("verification 'unavailable' keeps every confirmed transaction on record and exits 3, not 1", async () => {
    const outcome = await runSteps(
      [
        step(1),
        step(2, async () => {
          throw new VerificationError(
            "unavailable",
            "could not read a consistent snapshot at block 9226980"
          )
        }),
      ],
      { track }
    )
    assert.equal(outcome.failure?.state, "verification_unavailable")
    assert.equal(outcome.failure?.transactionConfirmed, true)
    assert.equal(
      outcome.records.length,
      2,
      "both transactions are recorded as confirmed"
    )
    assert.ok(outcome.records.every((r) => r.state === "confirmed"))
    assert.deepEqual(classifyOutcome(outcome), {
      kind: "confirmed_unverified",
      exitCode: 3,
    })
  })

  it("a definitive mismatch is 'verification_failed' but still states the transaction is confirmed", async () => {
    const outcome = await runSteps(
      [
        step(1, async () => {
          throw new VerificationError(
            "mismatch",
            "reserveBalance: expected 1, found 2"
          )
        }),
      ],
      { track }
    )
    assert.equal(outcome.failure?.state, "verification_failed")
    assert.equal(outcome.failure?.transactionConfirmed, true)
    assert.equal(classifyOutcome(outcome).exitCode, 3)
  })

  it("an unexpected error from a state check is conservative ('failed') but never marks the transaction failed", async () => {
    const outcome = await runSteps(
      [
        step(1, async () => {
          throw new Error("boom https://secret.example/KEY")
        }),
      ],
      { track }
    )
    assert.equal(outcome.failure?.state, "verification_failed")
    assert.equal(outcome.failure?.transactionConfirmed, true)
    assert.doesNotMatch(outcome.failure!.message, /KEY|secret\.example/)
  })

  it("records the receipt's own evidence, independent of any state read", async () => {
    const outcome = await runSteps([step(1)], { track })
    assert.deepEqual(outcome.records[0].evidence, {
      eventName: "InvoiceSettled",
      args: {
        invoiceId: "2",
        reserveRepaid: "90000000",
        freelancerPaid: "10000000",
      },
    })
  })

  it("real transaction failures keep exit code 1 and are not marked confirmed", async () => {
    for (const state of ["reverted", "replaced", "unverified", "unknown"]) {
      const outcome = await runSteps([step(1)], {
        track: async (s) =>
          ({
            state,
            hash: s.hash,
            requestedHash: s.hash,
            explorerUrl: s.explorerUrl,
            error: new Error(state),
          }) as never,
      })
      assert.equal(outcome.failure?.transactionConfirmed, false, state)
      assert.deepEqual(
        classifyOutcome(outcome),
        { kind: "stopped", exitCode: 1 },
        state
      )
    }
    const notSubmitted = await runSteps(
      [
        {
          ...step(1),
          submit: async () => {
            throw new Error("no")
          },
        },
      ],
      { track }
    )
    assert.equal(notSubmitted.failure?.transactionConfirmed, false)
    assert.equal(classifyOutcome(notSubmitted).exitCode, 1)
    assert.deepEqual(classifyOutcome({ records: [] }), {
      kind: "passed",
      exitCode: 0,
    })
  })

  it("END TO END: the incident replayed through the new flow passes once the node catches up", async () => {
    const heads = [ADVANCE_BLOCK, ADVANCE_BLOCK, SETTLE_BLOCK]
    let polls = 0
    const { client } = fakeClient({
      states: states(),
      // after the wait polls, a further head request lands on a lagging node again
      reportedHead: () => heads[polls++] ?? ADVANCE_BLOCK,
      nodeHead: () => SETTLE_BLOCK,
      latestHead: () => SETTLE_BLOCK,
    })
    const settle = step(5, async (confirmed) => {
      await verifyAtBlock({
        block: SETTLE_BLOCK, // the confirmed receipt's block
        waitForBlock: (b) =>
          waitForBlock(b, {
            client,
            pollMs: 1,
            timeoutMs: 100,
            now: boundedClock(),
            sleep: noSleep,
          }),
        read: (b) => readState(cfg, client, B(2), b),
        compare: (s) => mismatches(plan.final, s),
        options: { attempts: 3, sleep: noSleep },
      })
      void confirmed
    })
    const outcome = await runSteps([settle], { track })
    assert.equal(outcome.failure, undefined)
    assert.deepEqual(classifyOutcome(outcome), { kind: "passed", exitCode: 0 })
  })

  it("END TO END: if the node never catches up, a completed settlement is reported as confirmed-but-unchecked", async () => {
    const { client } = fakeClient({
      states: states(),
      reportedHead: () => ADVANCE_BLOCK,
      nodeHead: () => ADVANCE_BLOCK,
      latestHead: () => SETTLE_BLOCK,
    })
    const settle = step(5, async () => {
      await verifyAtBlock({
        block: SETTLE_BLOCK,
        waitForBlock: (b) =>
          waitForBlock(b, {
            client,
            timeoutMs: 3,
            pollMs: 1,
            sleep: async () => undefined,
            now: (() => {
              let t = 0
              return () => (t += 5)
            })(),
          }),
        read: (b) => readState(cfg, client, B(2), b),
        compare: (s) => mismatches(plan.final, s),
        options: { attempts: 2, backoffMs: 1, sleep: async () => undefined },
      })
    })
    const outcome = await runSteps([settle], { track })
    assert.equal(outcome.failure?.transactionConfirmed, true)
    assert.equal(outcome.records[0].state, "confirmed")
    assert.deepEqual(classifyOutcome(outcome), {
      kind: "confirmed_unverified",
      exitCode: 3,
    })
  })
})
