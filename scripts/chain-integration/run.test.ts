import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { TransactionStatus } from "../../lib/chain/lifecycle"
import type { SubmittedTransaction } from "../../lib/chain/writes"
import { ChainWriteError } from "../../lib/chain/errors"
import { runSteps, type RunStep } from "./run"

const B = (n: number | string) => BigInt(n)
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0")

function submitted(n: number): SubmittedTransaction {
  return {
    hash: hash(n),
    functionName: `fn${n}`,
    explorerUrl: `https://explorer.example/tx/${hash(n)}`,
  } as unknown as SubmittedTransaction
}
const confirmed = (
  n: number,
  invoiceId: string | null = null
): TransactionStatus =>
  ({
    state: "confirmed",
    hash: hash(n),
    requestedHash: hash(n),
    blockNumber: B(100 + n),
    explorerUrl: `https://explorer.example/tx/${hash(n)}`,
    invoiceId,
    verified: true,
  }) as unknown as TransactionStatus
const failing = (
  state: string,
  n: number,
  message = "boom"
): TransactionStatus =>
  ({
    state,
    hash: hash(n),
    requestedHash: hash(n),
    explorerUrl: `https://explorer.example/tx/${hash(n)}`,
    error: new ChainWriteError("TX_REVERTED", message),
  }) as unknown as TransactionStatus

/** Steps that count how often each is submitted, to prove nothing is ever retried. */
function counted(n: number) {
  const calls = { submit: 0, verify: 0 }
  const step: RunStep = {
    id: `step${n}`,
    label: `Step ${n}`,
    signer: "client",
    submit: async () => {
      calls.submit += 1
      return submitted(n)
    },
    verify: async () => {
      calls.verify += 1
    },
  }
  return { step, calls }
}

describe("runSteps: strictly ordered, verified, never retried", () => {
  it("runs every step once, in order, recording hash, state, block and explorer URL", async () => {
    const items = [counted(1), counted(2), counted(3)]
    const order: string[] = []
    const outcome = await runSteps(
      items.map((i) => i.step),
      {
        track: async (s) => {
          order.push(s.hash)
          return confirmed(
            Number(BigInt(s.hash)),
            s.hash === hash(1) ? "7" : null
          )
        },
      }
    )
    assert.equal(outcome.failure, undefined)
    assert.deepEqual(order, [hash(1), hash(2), hash(3)])
    assert.deepEqual(
      outcome.records.map((r) => r.id),
      ["step1", "step2", "step3"]
    )
    assert.equal(outcome.records[0].state, "confirmed")
    assert.equal(outcome.records[0].blockNumber, "101")
    assert.equal(outcome.records[0].invoiceId, "7")
    assert.match(
      outcome.records[0].explorerUrl,
      /^https:\/\/explorer\.example\/tx\/0x/
    )
    for (const i of items) assert.deepEqual(i.calls, { submit: 1, verify: 1 })
  })

  it("stops on a submission error: later steps are never submitted", async () => {
    const a = counted(1)
    const b = counted(2)
    b.step.submit = async () => {
      b.calls.submit += 1
      throw new ChainWriteError(
        "SEND_FAILED",
        "wallet refused https://secret.example/KEY1"
      )
    }
    const c = counted(3)
    const tracked: string[] = []
    const outcome = await runSteps([a.step, b.step, c.step], {
      track: async (s) => (tracked.push(s.hash), confirmed(1)),
    })
    assert.equal(outcome.failure?.stepId, "step2")
    assert.equal(outcome.failure?.state, "not_submitted")
    assert.doesNotMatch(outcome.failure!.message, /KEY1|secret\.example/)
    assert.equal(outcome.records.length, 1)
    assert.equal(c.calls.submit, 0)
    assert.equal(b.calls.submit, 1)
    assert.deepEqual(tracked, [hash(1)])
  })

  for (const state of ["reverted", "replaced", "unverified", "unknown"]) {
    it(`stops when a transaction is ${state}, without retrying it or running later steps`, async () => {
      const a = counted(1)
      const b = counted(2)
      const c = counted(3)
      const outcome = await runSteps([a.step, b.step, c.step], {
        track: async (s) =>
          s.hash === hash(2)
            ? failing(state, 2, `it was ${state}`)
            : confirmed(1),
      })
      assert.equal(outcome.failure?.stepId, "step2")
      assert.equal(outcome.failure?.state, state)
      assert.match(outcome.failure!.message, new RegExp(`it was ${state}`))
      assert.equal(outcome.failure?.hash, hash(2))
      assert.match(outcome.failure!.explorerUrl!, /explorer\.example/)
      assert.equal(
        outcome.records.length,
        1,
        "the failed step is not recorded as done"
      )
      assert.equal(b.calls.submit, 1, "submitted exactly once")
      assert.equal(b.calls.verify, 0)
      assert.equal(c.calls.submit, 0)
    })
  }

  it("a live-state verification failure stops the run (the transaction itself was confirmed)", async () => {
    const a = counted(1)
    a.step.verify = async () => {
      a.calls.verify += 1
      throw new Error("reserveBalance: expected 1, found 2")
    }
    const b = counted(2)
    const outcome = await runSteps([a.step, b.step], {
      track: async () => confirmed(1),
    })
    assert.equal(outcome.failure?.state, "verification_failed")
    assert.match(outcome.failure!.message, /reserveBalance/)
    assert.equal(
      outcome.records.length,
      1,
      "the confirmed transaction is still on record"
    )
    assert.equal(b.calls.submit, 0)
  })

  it("an unexpected tracking exception is reported as unknown, not as success", async () => {
    const a = counted(1)
    const outcome = await runSteps([a.step], {
      track: async () => {
        throw new Error("socket hang up https://secret.example/KEY2")
      },
    })
    assert.equal(outcome.failure?.state, "unknown")
    assert.doesNotMatch(outcome.failure!.message, /KEY2/)
    assert.equal(outcome.failure?.hash, hash(1))
    assert.equal(a.calls.submit, 1)
  })

  it("handles an empty plan", async () => {
    const outcome = await runSteps([], { track: async () => confirmed(1) })
    assert.deepEqual(outcome, { records: [] })
  })
})
