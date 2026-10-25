import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { parseUnits } from "viem"

import {
  advanceAmountFor,
  formatToken,
  parseToken,
} from "../../lib/chain/amounts"
import {
  getDeployment,
  getRegisteredToken,
  setDeploymentOverrideForTests,
} from "../../lib/chain/deployments"
import {
  DEFAULT_AMOUNT_DUSD,
  DEFAULT_AMOUNT_EXTERNAL,
  DEFAULT_RESERVE_TARGET_EXTERNAL,
  parseArgs,
} from "./args"
import { buildPlan, type Snapshot } from "./plan"

const R = (human: string) => parseUnits(human, 18)
const XRP = (n: number) => BigInt(n) * BigInt(10) ** BigInt(18)

afterEach(() => setDeploymentOverrideForTests(null))

function useRlusd() {
  setDeploymentOverrideForTests({
    ...getDeployment("dusd"),
    key: "rlusd",
    token: getRegisteredToken("rlusd"),
  })
}

/** The live RLUSD situation: a fresh contract, client ~60, operator ~20, evaluator holds none. */
function fresh(over: Partial<Snapshot> = {}): Snapshot {
  return {
    amount: R("1"),
    reserveBalance: BigInt(0),
    totalEscrow: BigInt(0),
    contractDusd: BigInt(0),
    clientDusd: R("60"),
    clientAllowance: BigInt(0),
    operatorDusd: R("20"),
    freelancerDusd: BigInt(0),
    gasBalance: { client: XRP(5), evaluator: XRP(5), operator: XRP(5) },
    gasPrice: BigInt(1_000_000_000),
    reserveTarget: R("5"),
    ...over,
  }
}

describe("RLUSD defaults and configurable amounts", () => {
  it("dUSD defaults are untouched: 100, no reserve target", () => {
    const args = parseArgs([])
    assert.equal(args.amountDusd, DEFAULT_AMOUNT_DUSD)
    assert.equal(args.reserveTarget, undefined)
  })

  it("RLUSD defaults to a 1 RLUSD invoice and a 5 RLUSD reserve target", () => {
    useRlusd()
    const args = parseArgs([])
    assert.equal(DEFAULT_AMOUNT_EXTERNAL, "1")
    assert.equal(DEFAULT_RESERVE_TARGET_EXTERNAL, "5")
    assert.equal(args.amount, R("1"))
    assert.equal(args.reserveTarget, R("5"))
    assert.equal(advanceAmountFor(args.amount), R("0.9"))
  })

  it("accepts fractional invoices and targets up to 18 decimals, rejects more", () => {
    useRlusd()
    const args = parseArgs(["--amount", "0.25", "--reserve-target", "2.5"])
    assert.equal(args.amount, R("0.25"))
    assert.equal(args.reserveTarget, R("2.5"))
    assert.equal(
      parseArgs(["--amount", "0.000000000000000011"]).amount,
      BigInt(11)
    )
    assert.throws(
      () => parseArgs(["--amount", "0.0000000000000000001"]),
      /18 decimals/
    )
    assert.throws(
      () => parseArgs(["--reserve-target", "-1"]),
      /--reserve-target/
    )
    assert.throws(() => parseArgs(["--reserve-target"]), /needs a value/)
    assert.equal(parseToken("1.5"), R("1.5"))
    assert.equal(formatToken(R("0.9")), "0.9")
  })

  it("--reserve-target is also available on dUSD, in 6 decimals", () => {
    const args = parseArgs(["--reserve-target", "40.5"])
    assert.equal(args.reserveTarget, BigInt(40_500_000))
  })
})

describe("plan: fund the reserve once, then reuse it", () => {
  it("empty reserve: deposits the 5 RLUSD target, not just the 0.9 advance", () => {
    useRlusd()
    const plan = buildPlan(fresh())
    assert.equal(plan.advance, R("0.9"))
    assert.equal(plan.reserveShortfall, R("0.9"))
    assert.equal(plan.reserveDeposit, R("5"))
    assert.deepEqual(
      plan.steps.map((s) => s.id),
      [
        "createInvoice",
        "approveEscrow",
        "fundInvoice",
        "operatorApprove",
        "depositReserve",
        "approveAdvance",
        "approveCompletion",
      ]
    )
    assert.equal(plan.blockers.length, 0)
    const advance = plan.steps.find((s) => s.id === "approveAdvance")!
    assert.equal(advance.checkpoint.reserve, R("4.1"))
    assert.equal(plan.final.reserve, R("5"), "the advance is repaid in full")
    assert.equal(plan.final.contractDusd, R("5"))
    assert.equal(plan.final.freelancerDusd, R("1"))
    assert.equal(plan.final.clientDusd, R("59"))
  })

  it("the second run finds the reserve funded and deposits nothing", () => {
    useRlusd()
    const plan = buildPlan(
      fresh({
        reserveBalance: R("5"),
        contractDusd: R("5"),
        freelancerDusd: R("1"),
        clientDusd: R("59"),
      })
    )
    assert.equal(plan.reserveDeposit, BigInt(0))
    assert.deepEqual(
      plan.steps.map((s) => s.id),
      [
        "createInvoice",
        "approveEscrow",
        "fundInvoice",
        "approveAdvance",
        "approveCompletion",
      ]
    )
    assert.equal(plan.final.reserve, R("5"))
    assert.equal(plan.final.contractDusd, R("5"))
  })

  it("a reserve slightly below the advance tops up to the target, not to the advance", () => {
    useRlusd()
    const plan = buildPlan(
      fresh({ reserveBalance: R("0.5"), contractDusd: R("0.5") })
    )
    assert.equal(plan.reserveDeposit, R("4.5"))
    assert.equal(plan.final.reserve, R("5"))
  })

  it("without a target only the exact shortfall is deposited (dUSD behaviour)", () => {
    const plan = buildPlan(fresh({ reserveTarget: undefined }))
    assert.equal(plan.reserveDeposit, plan.reserveShortfall)
  })

  it("a target below the advance never shrinks the deposit under the advance", () => {
    const plan = buildPlan(fresh({ reserveTarget: R("0.1") }))
    assert.equal(plan.reserveDeposit, R("0.9"))
  })

  it("never plans a mint or a transfer to anyone: the operator only deposits its own tokens", () => {
    const plan = buildPlan(fresh())
    for (const step of plan.steps) {
      assert.doesNotMatch(step.label, /mint|transfer/i)
    }
  })
})

describe("plan: blockers use the real balances and never replenish", () => {
  it("an operator holding less than the deposit blocks the run", () => {
    useRlusd()
    const plan = buildPlan(fresh({ operatorDusd: R("3") }))
    assert.equal(plan.blockers.length, 1)
    assert.match(plan.blockers[0], /operator holds only 3 .* to deposit 5/)
    assert.match(plan.blockers[0], /never transfers or replenishes/)
  })

  it("a client below the invoice blocks it without offering to fund it", () => {
    useRlusd()
    const plan = buildPlan(fresh({ clientDusd: R("0.5") }))
    assert.match(plan.blockers.join(" "), /client holds 0\.5 RLUSD/)
    assert.match(plan.blockers.join(" "), /cannot be minted by us/)
  })

  it("the evaluator needs gas but no tokens", () => {
    const plan = buildPlan(
      fresh({
        gasBalance: { client: XRP(5), evaluator: BigInt(0), operator: XRP(5) },
      })
    )
    assert.match(plan.blockers.join(" "), /evaluator needs native XRP/)
    assert.equal(plan.blockers.filter((b) => /evaluator/.test(b)).length, 1)
  })

  it("a paused token blocks the run", () => {
    const plan = buildPlan(fresh({ tokenPaused: true }))
    assert.match(plan.blockers.join(" "), /paused by its issuer/)
  })
})
