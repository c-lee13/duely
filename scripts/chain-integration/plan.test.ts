import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { GAS_PER_TX, buildPlan, type Snapshot } from "./plan"

const B = (n: number | string) => BigInt(n)
const DUSD = (n: number) => BigInt(Math.round(n * 1e6))
const XRP = (n: number) => BigInt(Math.round(n * 1e6)) * B(1000000000000)

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    amount: DUSD(100),
    reserveBalance: DUSD(10000),
    totalEscrow: B(0),
    contractDusd: DUSD(10000),
    clientDusd: DUSD(100),
    clientAllowance: B(0),
    operatorDusd: B(0),
    freelancerDusd: DUSD(1000),
    gasBalance: { client: XRP(50), evaluator: XRP(10), operator: XRP(50) },
    gasPrice: B(785125000),
    ...over,
  }
}

const ids = (plan: ReturnType<typeof buildPlan>) => plan.steps.map((s) => s.id)

describe("plan: the normal run (reserve already funded)", () => {
  const plan = buildPlan(snapshot())

  it("is create, approve exactly the amount, fund, advance, settle: five transactions", () => {
    assert.deepEqual(ids(plan), [
      "createInvoice",
      "approveEscrow",
      "fundInvoice",
      "approveAdvance",
      "approveCompletion",
    ])
    assert.equal(plan.totalTransactions, 5)
    assert.deepEqual(plan.txCountBySigner, {
      client: 4,
      evaluator: 1,
      operator: 0,
    })
    assert.deepEqual(
      plan.steps.map((s) => s.signer),
      ["client", "client", "client", "evaluator", "client"]
    )
    assert.equal(plan.blockers.length, 0)
  })

  it("the advance is floor(90%) and needs no reserve top-up", () => {
    assert.equal(plan.advance, DUSD(90))
    assert.equal(plan.reserveShortfall, B(0))
  })

  it("never plans a mint, transfer or any step outside the invoice lifecycle", () => {
    const allowed = new Set([
      "createInvoice",
      "approveEscrow",
      "fundInvoice",
      "operatorApprove",
      "depositReserve",
      "approveAdvance",
      "approveCompletion",
    ])
    for (const id of ids(plan)) assert.ok(allowed.has(id), id)
    assert.ok(!ids(plan).some((id) => /mint|transfer/i.test(id)))
  })

  it("approves exactly the invoice amount, never more", () => {
    const approve = plan.steps.find((s) => s.id === "approveEscrow")!
    assert.equal(approve.checkpoint.clientAllowance, DUSD(100))
  })

  it("checkpoints follow the contract's accounting after each step", () => {
    const at = (id: string) => plan.steps.find((s) => s.id === id)!.checkpoint
    assert.deepEqual(at("createInvoice"), {
      invoiceStatus: "Created",
      reserve: DUSD(10000),
      escrow: B(0),
      clientDusd: DUSD(100),
    })
    assert.deepEqual(at("fundInvoice"), {
      invoiceStatus: "Funded",
      escrow: DUSD(100),
      clientDusd: B(0),
      reserve: DUSD(10000),
    })
    assert.deepEqual(at("approveAdvance"), {
      invoiceStatus: "Advanced",
      advanceAmount: DUSD(90),
      reserve: DUSD(9910),
      escrow: DUSD(100),
      freelancerDusd: DUSD(1090),
    })
    assert.deepEqual(at("approveCompletion"), plan.final)
  })

  it("the final state: settled, advance repaid into the reserve, escrow back to start, freelancer paid in full", () => {
    assert.deepEqual(plan.final, {
      invoiceStatus: "Settled",
      advanceAmount: DUSD(90),
      reserve: DUSD(10000),
      escrow: B(0),
      clientDusd: B(0),
      freelancerDusd: DUSD(1100),
      contractDusd: DUSD(10000),
    })
  })

  it("requires gas for each signer's transactions with a safety margin", () => {
    const per = (n: number) => (B(n) * GAS_PER_TX * B(785125000) * B(3)) / B(2)
    assert.equal(plan.gasRequired.client, per(4))
    assert.equal(plan.gasRequired.evaluator, per(1))
    assert.equal(plan.gasRequired.operator, B(0))
  })
})

describe("plan: variations", () => {
  it("skips the approval when the existing allowance already covers the invoice", () => {
    const plan = buildPlan(snapshot({ clientAllowance: DUSD(100) }))
    assert.ok(!ids(plan).includes("approveEscrow"))
    assert.equal(plan.totalTransactions, 4)
    const bigger = buildPlan(snapshot({ clientAllowance: DUSD(500) }))
    assert.ok(!ids(bigger).includes("approveEscrow"))
    const short = buildPlan(snapshot({ clientAllowance: DUSD(99.999999) }))
    assert.ok(ids(short).includes("approveEscrow"))
  })

  it("adds an operator approve + deposit when the reserve cannot cover the advance", () => {
    const plan = buildPlan(
      snapshot({
        reserveBalance: DUSD(50),
        contractDusd: DUSD(50),
        operatorDusd: DUSD(200),
      })
    )
    assert.equal(plan.reserveShortfall, DUSD(40))
    assert.deepEqual(ids(plan), [
      "createInvoice",
      "approveEscrow",
      "fundInvoice",
      "operatorApprove",
      "depositReserve",
      "approveAdvance",
      "approveCompletion",
    ])
    assert.equal(plan.txCountBySigner.operator, 2)
    assert.equal(
      plan.steps.find((s) => s.id === "operatorApprove")!.checkpoint
        .operatorAllowance,
      DUSD(40)
    )
    assert.equal(
      plan.steps.find((s) => s.id === "depositReserve")!.checkpoint.reserve,
      DUSD(90)
    )
    assert.equal(
      plan.steps.find((s) => s.id === "approveAdvance")!.checkpoint.reserve,
      B(0)
    )
    assert.equal(plan.final.reserve, DUSD(90))
    assert.equal(plan.final.contractDusd, DUSD(90))
    assert.equal(plan.blockers.length, 0)
  })

  it("an exactly sufficient reserve needs no top-up", () => {
    const plan = buildPlan(snapshot({ reserveBalance: DUSD(90) }))
    assert.equal(plan.reserveShortfall, B(0))
    assert.ok(!ids(plan).includes("depositReserve"))
  })

  it("floors the advance exactly like the contract", () => {
    assert.equal(
      buildPlan(snapshot({ amount: B(1234567), clientDusd: B(1234567) }))
        .advance,
      B(1111110)
    )
  })

  it("carries existing escrow and freelancer balances through the expectations", () => {
    const plan = buildPlan(
      snapshot({ totalEscrow: DUSD(7), contractDusd: DUSD(10007) })
    )
    assert.equal(
      plan.steps.find((s) => s.id === "fundInvoice")!.checkpoint.escrow,
      DUSD(107)
    )
    assert.equal(plan.final.escrow, DUSD(7))
  })
})

describe("plan: blockers", () => {
  it("a client without enough dUSD blocks the run and the message says the script will not mint", () => {
    const plan = buildPlan(snapshot({ clientDusd: B(0) }))
    assert.equal(plan.blockers.length, 1)
    assert.match(plan.blockers[0], /never mints or transfers funds/)
    assert.match(plan.blockers[0], /must mint 100 dUSD/)
    const partial = buildPlan(snapshot({ clientDusd: DUSD(40) }))
    assert.match(partial.blockers[0], /must mint 60 dUSD/)
    assert.equal(
      buildPlan(snapshot({ clientDusd: DUSD(100) })).blockers.length,
      0
    )
  })

  it("an operator who cannot cover a reserve shortfall blocks the run", () => {
    const plan = buildPlan(
      snapshot({ reserveBalance: DUSD(50), operatorDusd: DUSD(10) })
    )
    assert.equal(plan.blockers.length, 1)
    assert.match(plan.blockers[0], /operator holds only 10 dUSD/)
  })

  it("insufficient native gas blocks only for signers that will send", () => {
    const base = snapshot()
    const evaluatorPoor = buildPlan({
      ...base,
      gasBalance: { ...base.gasBalance, evaluator: B(1) },
    })
    assert.equal(evaluatorPoor.blockers.length, 1)
    assert.match(evaluatorPoor.blockers[0], /evaluator needs native XRP/)
    const operatorPoorButUnused = buildPlan({
      ...base,
      gasBalance: { ...base.gasBalance, operator: B(0) },
    })
    assert.equal(operatorPoorButUnused.blockers.length, 0)
    const operatorPoorAndUsed = buildPlan({
      ...base,
      reserveBalance: DUSD(0),
      operatorDusd: DUSD(500),
      gasBalance: { ...base.gasBalance, operator: B(0) },
    })
    assert.match(
      operatorPoorAndUsed.blockers.join(),
      /operator needs native XRP/
    )
  })

  it("an amount too small to advance anything is rejected", () => {
    const plan = buildPlan(snapshot({ amount: B(1), clientDusd: B(1) }))
    assert.match(plan.blockers.join(), /advance would be zero/)
  })

  it("collects every problem at once", () => {
    const plan = buildPlan(
      snapshot({
        clientDusd: B(0),
        gasBalance: { client: B(0), evaluator: B(0), operator: B(0) },
      })
    )
    assert.equal(plan.blockers.length, 3)
  })
})
