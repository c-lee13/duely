import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it } from "node:test"
import { DomainError } from "@/lib/frontend/errors"
import type { TxProgress } from "@/lib/frontend/tx-runner"
import { bytes } from "./helpers/evidence"
import { ADDR } from "./helpers/sim-contract"
import { ONE, U, WALLET, createWorld, input, type World } from "./helpers/live-harness"

/**
 * The whole lifecycle through the live repository: operator funds the reserve, client creates + funds, freelancer submits
 * evidence, is evaluated and requests the advance (backend signer), client approves or disputes, operator resolves. Every
 * state shown is read back from the simulated chain; nothing is optimistic.
 */
let w: World
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e instanceof DomainError ? e.code : `other:${String(e)}`
  }
  return "none"
}
const as = (account: string) => {
  w.wallet.account = account
  w.wallet.chainId = 1449000
}
const bal = (a: string) => w.chain.state.balances.get(a.toLowerCase()) ?? BigInt(0)
const pdf = () => new File([bytes.pdf], "proof.pdf", { type: "application/pdf" })
const FIVE = BigInt(5_000_000)

async function reset() {
  w.chain.state.invoices.clear()
  w.chain.state.nextInvoiceId = BigInt(1)
  w.chain.state.reserve = BigInt(0)
  w.chain.state.escrow = BigInt(0)
  w.chain.state.allowances.clear()
  w.chain.state.balances.set(WALLET.client, BigInt(60_000_000))
  w.chain.state.balances.set(WALLET.operator, BigInt(20_000_000))
  w.chain.state.balances.set(WALLET.freelancer, BigInt(0))
  w.sim.sent.length = 0
  for (const t of ["advance_requests", "transactions", "evaluations", "submissions"]) {
    await w.db.exec(`alter table ${t} disable trigger user; delete from ${t}; alter table ${t} enable trigger user`)
  }
  await w.db.exec("alter table invoice_criteria disable trigger user; alter table invoices disable trigger user; delete from invoice_criteria; delete from invoices; alter table invoice_criteria enable trigger user; alter table invoices enable trigger user")
  w.storage.data.clear()
  as(ADDR.client)
}

/** Operator funds the reserve, the client creates and funds a 1 dUSD invoice. Returns repositories per actor. */
async function fundedInvoice(reserve = FIVE) {
  const operator = w.repoFor(U.operator)
  const client = w.repoFor(U.client)
  const freelancer = w.repoFor(U.freelancer)
  if (reserve > BigInt(0)) {
    as(ADDR.operator)
    await operator.depositReserve(reserve.toString())
  }
  as(ADDR.client)
  await client.createInvoice(input())
  await client.fundInvoice("1")
  w.sim.sent.length = 0
  return { operator, client, freelancer }
}

async function evaluated(freelancer: ReturnType<World["repoFor"]>) {
  as(ADDR.freelancer)
  const sub = await freelancer.submitEvidence({ invoiceId: "1", fileName: "proof.pdf", fileSize: bytes.pdf.length, mimeType: "application/pdf", note: "done", file: pdf() })
  const ev = await freelancer.requestEvaluation(sub.submissionId)
  assert.equal(ev.passed, true)
  return sub
}

before(async () => {
  w = await createWorld()
})
after(async () => w.close())
beforeEach(reset)

describe("operator: reserve deposit", () => {
  it("approves exactly the amount, deposits, and the reserve shown is read from the chain", async () => {
    const operator = w.repoFor(U.operator)
    as(ADDR.operator)
    const progress: TxProgress[] = []
    await operator.depositReserve(FIVE.toString(), (p) => progress.push(p))
    assert.deepEqual(progress.filter((p) => p.status === "confirmed").map((p) => p.label), ["Approve dUSD allowance", "Deposit to reserve"])
    assert.equal(w.sim.sent.find((s) => s.fn === "approve")?.args[1], FIVE, "exact allowance")
    assert.equal(w.chain.state.reserve, FIVE)
    assert.equal(bal(WALLET.operator), BigInt(15_000_000))
    const b = await operator.getBalances()
    assert.deepEqual({ reserve: b.reserveAvailable, escrow: b.escrowLocked, wallet: b.walletBalance }, { reserve: FIVE.toString(), escrow: "0", wallet: "15000000" })
  })

  it("only an on-chain OPERATOR_ROLE wallet may deposit: a client or freelancer is FORBIDDEN before any prompt", async () => {
    for (const [user, account] of [[U.client, ADDR.client], [U.freelancer, ADDR.freelancer]] as const) {
      as(account)
      assert.equal(await codeOf(w.repoFor(user).depositReserve("1000000")), "FORBIDDEN")
    }
    assert.equal(w.sim.sent.length, 0)
    assert.equal(w.chain.state.reserve, BigInt(0))
  })

  it("refuses a deposit above the wallet balance, a zero deposit, and a paused token", async () => {
    const operator = w.repoFor(U.operator)
    as(ADDR.operator)
    assert.equal(await codeOf(operator.depositReserve("999999999")), "INSUFFICIENT_BALANCE")
    assert.equal(await codeOf(operator.depositReserve("0")), "INVALID_INPUT")
    assert.equal(w.sim.sent.length, 0)
    const paused = await createWorld({ tokenPaused: true })
    try {
      paused.wallet.account = ADDR.operator
      assert.equal(await codeOf(paused.repoFor(U.operator).depositReserve("1000000")), "TOKEN_PAUSED")
    } finally {
      await paused.close()
    }
  })

  it("a deposit that reverts leaves the reserve unchanged and is logged as failed", async () => {
    const world = await createWorld({ revert: { depositReserve: true } })
    try {
      world.wallet.account = ADDR.operator
      const operator = world.repoFor(U.operator)
      assert.equal(await codeOf(operator.depositReserve("1000000")), "TX_FAILED")
      assert.equal(world.chain.state.reserve, BigInt(0))
      assert.ok((await operator.listTransactions()).some((t) => t.action === "depositReserve" && t.status === "failed"))
    } finally {
      await world.close()
    }
  })
})

describe("freelancer: evidence -> evaluation -> advance", () => {
  it("evidence is refused until the chain shows the escrow funded (the database cache is not enough)", async () => {
    const client = w.repoFor(U.client)
    await client.createInvoice(input()) // Created, not funded
    as(ADDR.freelancer)
    const freelancer = w.repoFor(U.freelancer)
    assert.equal(await codeOf(freelancer.submitEvidence({ invoiceId: "1", fileName: "proof.pdf", fileSize: 12, mimeType: "application/pdf", note: "", file: pdf() })), "INVALID_STATUS")
    // Even if the database cache is forced to say Funded, the chain decides.
    await w.db.query("update invoices set onchain_status = 'Funded'")
    assert.equal(await codeOf(freelancer.submitEvidence({ invoiceId: "1", fileName: "proof.pdf", fileSize: 12, mimeType: "application/pdf", note: "", file: pdf() })), "INVALID_STATUS")
    assert.equal((await w.db.query<{ c: number }>("select count(*)::int c from submissions")).rows[0].c, 0)
  })

  it("a passing evaluation + an explicit request pays 90% from the reserve: PAID only after the confirmed receipt, balances moved on-chain", async () => {
    const { freelancer } = await fundedInvoice()
    await evaluated(freelancer)
    const result = await freelancer.requestAdvance("1")
    assert.equal(result.status, "paid")
    assert.match(result.txHash ?? "", /^0x[0-9a-f]{64}$/)
    assert.equal(result.amount, "900000")
    assert.equal(bal(WALLET.freelancer), BigInt(900_000))
    assert.equal(w.chain.state.reserve, FIVE - BigInt(900_000))
    assert.deepEqual(w.sim.sent.map((s) => s.fn), ["approveAdvance"])
    assert.equal(w.sim.sent[0].from.toLowerCase(), ADDR.evaluator.toLowerCase(), "signed by the evaluator account, not by a user wallet")

    const bundle = await freelancer.getInvoice("1")
    assert.equal(bundle.invoice.onchainStatus, "Advanced")
    assert.equal(bundle.invoice.advanceAmount, "900000")
    assert.equal(bundle.advanceRequests[0].status, "paid")
    const tx = bundle.transactions.find((t) => t.action === "approveAdvance")!
    assert.equal(tx.status, "confirmed")
    assert.equal(tx.txHash, result.txHash)
    assert.ok(bundle.timeline.some((e) => e.kind === "advance_paid"))
    const row = (await w.db.query<{ status: string; tstatus: string; block: string }>("select a.status, t.status as tstatus, t.block_number::text as block from advance_requests a join transactions t on t.id = a.transaction_id")).rows[0]
    assert.deepEqual({ a: row.status, t: row.tstatus }, { a: "paid", t: "confirmed" })
    assert.ok(row.block)
  })

  it("an advance whose transaction is not mined yet is shown PENDING, with its hash, and the invoice is NOT shown as advanced", async () => {
    const world = await createWorld({ hold: { approveAdvance: true } })
    try {
      const prev = world.wallet
      void prev
      world.wallet.account = ADDR.operator
      await world.repoFor(U.operator).depositReserve(FIVE.toString())
      world.wallet.account = ADDR.client
      const client = world.repoFor(U.client)
      await client.createInvoice(input())
      await client.fundInvoice("1")
      world.wallet.account = ADDR.freelancer
      const freelancer = world.repoFor(U.freelancer)
      const sub = await freelancer.submitEvidence({ invoiceId: "1", fileName: "proof.pdf", fileSize: bytes.pdf.length, mimeType: "application/pdf", note: "", file: pdf() })
      await freelancer.requestEvaluation(sub.submissionId)
      const r = await freelancer.requestAdvance("1")
      assert.equal(r.status, "pending")
      assert.ok(r.txHash)
      const bundle = await freelancer.getInvoice("1")
      assert.equal(bundle.invoice.onchainStatus, "Funded", "the chain has not advanced it")
      assert.equal(bundle.advanceRequests[0].status, "pending")
      assert.equal(bundle.transactions.find((t) => t.action === "approveAdvance")?.status, "pending")
      assert.ok(!bundle.timeline.some((e) => e.kind === "advance_paid"))
      assert.equal(bal(WALLET.freelancer).toString(), "0")
      // A second click returns the same request and does not sign again.
      const again = await freelancer.requestAdvance("1")
      assert.equal(again.requestId, r.requestId)
      assert.equal(world.sim.sent.filter((s) => s.fn === "approveAdvance").length, 1)
    } finally {
      await world.close()
    }
  })

  it("is refused without a passing evaluation, with no reserve, and for anyone but the freelancer; nothing is signed", async () => {
    const { freelancer, client } = await fundedInvoice(BigInt(0)) // reserve is empty
    as(ADDR.freelancer)
    assert.equal(await codeOf(freelancer.requestAdvance("1")), "NOT_ELIGIBLE") // no submission yet
    await evaluated(freelancer)
    assert.equal(await codeOf(freelancer.requestAdvance("1")), "INSUFFICIENT_RESERVE")
    as(ADDR.client)
    assert.equal(await codeOf(client.requestAdvance("1")), "FORBIDDEN")
    assert.equal(w.sim.sent.filter((s) => s.fn === "approveAdvance").length, 0)
  })
})

describe("client: approve and dispute", () => {
  async function advanced() {
    const actors = await fundedInvoice()
    await evaluated(actors.freelancer)
    await actors.freelancer.requestAdvance("1")
    w.sim.sent.length = 0
    return actors
  }

  it("approval after an advance repays the reserve from escrow and pays the rest: 100% to the freelancer in total, reserve restored", async () => {
    const { client } = await advanced()
    as(ADDR.client)
    const progress: TxProgress[] = []
    await client.approveInvoice("1", (p) => progress.push(p))
    assert.deepEqual(progress.map((p) => p.status), ["awaiting_wallet", "pending", "confirmed"])
    assert.equal(bal(WALLET.freelancer), ONE, "advance 0.9 + remainder 0.1")
    assert.equal(w.chain.state.reserve, FIVE, "the advance was repaid into the reserve")
    assert.equal(w.chain.state.escrow, BigInt(0))
    const b = await client.getInvoice("1")
    assert.equal(b.invoice.onchainStatus, "Settled")
    assert.equal(b.invoice.freelancerReceived, ONE.toString())
    assert.equal(b.invoice.reserveCredited, "900000")
    assert.equal(b.invoice.escrowBalance, "0")
  })

  it("approval without an advance pays the full invoice to the freelancer", async () => {
    const { client } = await fundedInvoice()
    as(ADDR.client)
    await client.approveInvoice("1")
    assert.equal(bal(WALLET.freelancer), ONE)
    assert.equal(w.chain.state.reserve, FIVE, "reserve untouched")
    assert.equal((await client.getInvoice("1")).invoice.onchainStatus, "Settled")
  })

  it("is refused before the wallet when the chain status doesn't allow it (Created, Settled) and for a non-client account", async () => {
    const client = w.repoFor(U.client)
    await client.createInvoice(input())
    assert.equal(await codeOf(client.approveInvoice("1")), "INVALID_STATUS")
    assert.equal(await codeOf(client.disputeInvoice("1")), "INVALID_STATUS")
    await client.fundInvoice("1")
    as(ADDR.freelancer)
    assert.equal(await codeOf(client.approveInvoice("1")), "WRONG_ACCOUNT")
    assert.equal(await codeOf(client.disputeInvoice("1")), "WRONG_ACCOUNT")
    as(ADDR.client)
    w.sim.sent.length = 0
    await client.approveInvoice("1")
    w.sim.sent.length = 0
    assert.equal(await codeOf(client.approveInvoice("1")), "INVALID_STATUS", "a settled invoice is terminal")
    assert.equal(await codeOf(client.disputeInvoice("1")), "INVALID_STATUS")
    assert.equal(w.sim.sent.length, 0)
  })

  it("a reverted approval is a failure: the invoice stays funded and no money moved", async () => {
    const world = await createWorld({ revert: { approveCompletion: true } })
    try {
      world.wallet.account = ADDR.client
      const client = world.repoFor(U.client)
      await client.createInvoice(input())
      await client.fundInvoice("1")
      assert.equal(await codeOf(client.approveInvoice("1")), "TX_FAILED")
      assert.equal((await client.getInvoice("1")).invoice.onchainStatus, "Funded")
      assert.equal(world.chain.state.escrow, ONE)
    } finally {
      await world.close()
    }
  })

  it("a dispute freezes the invoice: no approval, no advance, escrow stays locked", async () => {
    const { client, freelancer } = await fundedInvoice()
    await evaluated(freelancer) // evaluated and eligible, but the client disputes before any advance
    as(ADDR.client)
    await client.disputeInvoice("1")
    assert.equal((await client.getInvoice("1")).invoice.onchainStatus, "Disputed")
    assert.equal(w.chain.state.escrow, ONE)
    assert.equal(await codeOf(client.approveInvoice("1")), "INVALID_STATUS")
    as(ADDR.freelancer)
    assert.equal(await codeOf(freelancer.requestAdvance("1")), "INVALID_STATUS")
    assert.equal(w.sim.sent.filter((s) => s.fn === "approveAdvance" || s.fn === "approveCompletion").length, 0)
    assert.equal(bal(WALLET.freelancer), BigInt(0))
  })

  it("a dispute after an advance keeps the advance with the freelancer and freezes the rest", async () => {
    const { client } = await advanced()
    as(ADDR.client)
    await client.disputeInvoice("1")
    assert.equal((await client.getInvoice("1")).invoice.onchainStatus, "Disputed")
    assert.equal(bal(WALLET.freelancer), BigInt(900_000))
    assert.equal(w.chain.state.escrow, ONE)
    assert.equal(await codeOf(client.approveInvoice("1")), "INVALID_STATUS")
  })
})

describe("operator: dispute resolution (actual contract behavior)", () => {
  async function disputed(withAdvance: boolean) {
    const actors = await fundedInvoice()
    if (withAdvance) {
      await evaluated(actors.freelancer)
      await actors.freelancer.requestAdvance("1")
    }
    as(ADDR.client)
    await actors.client.disputeInvoice("1")
    w.sim.sent.length = 0
    return actors
  }

  it("the operator sees disputed and advanced invoices (verified from the chain) even though they are no party to them", async () => {
    const { operator } = await disputed(true)
    as(ADDR.operator)
    const list = await operator.listInvoices("platform", WALLET.operator)
    assert.deepEqual(list.map((i) => [i.invoiceId, i.onchainStatus]), [["1", "Disputed"]])
    const b = await operator.getBalances()
    assert.deepEqual({ atRisk: b.advancesAtRisk, outstanding: b.advancesOutstanding }, { atRisk: "900000", outstanding: "0" })
  })

  it("refund: the client gets the WHOLE escrow back, the invoice is Cancelled, and the advance is NOT clawed back (the reserve bears it)", async () => {
    const { operator } = await disputed(true)
    as(ADDR.operator)
    const clientBefore = bal(WALLET.client)
    const reserveBefore = w.chain.state.reserve
    await operator.resolveDispute("1", false)
    assert.equal(bal(WALLET.client), clientBefore + ONE)
    assert.equal(w.chain.state.escrow, BigInt(0))
    assert.equal(bal(WALLET.freelancer), BigInt(900_000), "the freelancer keeps the advance")
    assert.equal(w.chain.state.reserve, reserveBefore, "the reserve is NOT repaid: that is the platform's loss")
    assert.equal(w.chain.state.invoices.get(BigInt(1))?.status, 5)
    as(ADDR.client)
    assert.equal((await w.repoFor(U.client).getInvoice("1")).invoice.onchainStatus, "Cancelled")
  })

  it("release: settles normally (advance repaid from escrow, remainder to the freelancer)", async () => {
    const { operator } = await disputed(true)
    as(ADDR.operator)
    await operator.resolveDispute("1", true)
    assert.equal(bal(WALLET.freelancer), ONE)
    assert.equal(w.chain.state.reserve, FIVE)
    assert.equal(w.chain.state.escrow, BigInt(0))
    as(ADDR.client)
    assert.equal((await w.repoFor(U.client).getInvoice("1")).invoice.onchainStatus, "Settled")
  })

  it("refund without any advance returns exactly the escrow and nothing else moves", async () => {
    const { operator } = await disputed(false)
    as(ADDR.operator)
    await operator.resolveDispute("1", false)
    assert.equal(bal(WALLET.client), BigInt(60_000_000))
    assert.equal(bal(WALLET.freelancer), BigInt(0))
    assert.equal(w.chain.state.reserve, FIVE)
  })

  it("only the operator may resolve: client, freelancer and strangers are FORBIDDEN; a non-disputed invoice is refused; nothing is sent", async () => {
    const { client, freelancer } = await disputed(false)
    for (const [repo, account] of [[client, ADDR.client], [freelancer, ADDR.freelancer]] as const) {
      as(account)
      assert.equal(await codeOf(repo.resolveDispute("1", false)), "FORBIDDEN")
    }
    assert.equal(w.sim.sent.length, 0)
    as(ADDR.operator)
    const operator = w.repoFor(U.operator)
    await operator.resolveDispute("1", true)
    w.sim.sent.length = 0
    assert.equal(await codeOf(operator.resolveDispute("1", true)), "INVALID_STATUS")
    assert.equal(w.sim.sent.length, 0)
  })

  it("the operator view and balances are forbidden to everyone else (authorized by the on-chain role)", async () => {
    await disputed(false)
    for (const [user, account] of [[U.client, ADDR.client], [U.freelancer, ADDR.freelancer], [U.stranger, ADDR.stranger]] as const) {
      as(account)
      const repo = w.repoFor(user)
      assert.equal(await codeOf(repo.listInvoices("platform", account)), "FORBIDDEN")
    }
  })
})

describe("activity: only verified outcomes", () => {
  it("lists the connected wallet's transactions with their real status and hashes, newest first", async () => {
    const { client } = await fundedInvoice()
    as(ADDR.client)
    const txs = await client.listTransactions()
    assert.deepEqual(txs.map((t) => `${t.action}:${t.status}`), ["fundInvoice:confirmed", "approve:confirmed", "createInvoice:confirmed"])
    assert.ok(txs.every((t) => /^0x[0-9a-f]{64}$/.test(t.txHash ?? "") && t.simulated === false))
    as(ADDR.freelancer)
    assert.deepEqual(await w.repoFor(U.freelancer).listTransactions(), [], "another wallet's history is not shown")
  })

  it("a transaction left unconfirmed in the browser log is re-checked on the next load and becomes confirmed only with a verified receipt", async () => {
    const world = await createWorld({ hold: { createInvoice: true } })
    try {
      world.wallet.account = ADDR.client
      const repo = world.repoFor(U.client)
      await assert.rejects(repo.createInvoice(input()))
      assert.equal((await repo.listTransactions())[0].status, "pending")
      // The transaction lands later: the chain now has its receipt.
      const hash = world.sim.sent[0].hash
      const IA = world.scope.contractAddress
      const { eventLog } = await import("@/lib/chain/test/mock-chain")
      const metadataHash = world.sim.sent[0].args[2] as `0x${string}` // what the wallet really sent
      world.chain.state.invoices.set(BigInt(1), { freelancer: ADDR.freelancer, client: ADDR.client, amount: ONE, advanceAmount: BigInt(0), metadataHash, evaluationHash: ("0x" + "00".repeat(32)) as `0x${string}`, status: 0 } as never)
      // A receipt for a DIFFERENT operation (other commitment) must not confirm it: the SDK checks the expected event arguments.
      world.chain.setReceipt(hash, world.chain.receiptJson(hash, ADDR.client, IA, "success", [eventLog("invoiceAdvance", "InvoiceCreated", { invoiceId: BigInt(1), freelancer: ADDR.freelancer, client: ADDR.client, amount: ONE, metadataHash: ("0x" + "11".repeat(32)) as `0x${string}` })]))
      assert.equal((await world.repoFor(U.client).listTransactions())[0].status, "failed", "a mismatching receipt is never 'confirmed'")
      world.chain.setReceipt(hash, world.chain.receiptJson(hash, ADDR.client, IA, "success", [eventLog("invoiceAdvance", "InvoiceCreated", { invoiceId: BigInt(1), freelancer: ADDR.freelancer, client: ADDR.client, amount: ONE, metadataHash })]))
      // (the first look already marked it failed, so assert on a fresh log for the matching receipt)
      const fresh = await createWorld({ hold: { createInvoice: true } })
      try {
        fresh.wallet.account = ADDR.client
        const r2 = fresh.repoFor(U.client)
        await assert.rejects(r2.createInvoice(input()))
        const h2 = fresh.sim.sent[0].hash
        const mh = fresh.sim.sent[0].args[2] as `0x${string}`
        fresh.chain.state.invoices.set(BigInt(1), { freelancer: ADDR.freelancer, client: ADDR.client, amount: ONE, advanceAmount: BigInt(0), metadataHash: mh, evaluationHash: ("0x" + "00".repeat(32)) as `0x${string}`, status: 0 } as never)
        fresh.chain.setReceipt(h2, fresh.chain.receiptJson(h2, ADDR.client, fresh.scope.contractAddress, "success", [eventLog("invoiceAdvance", "InvoiceCreated", { invoiceId: BigInt(1), freelancer: ADDR.freelancer, client: ADDR.client, amount: ONE, metadataHash: mh })]))
        assert.equal((await fresh.repoFor(U.client).listTransactions())[0].status, "confirmed")
        // and that confirmed-on-reload invoice gets registered by the next client load
        assert.deepEqual((await fresh.repoFor(U.client).listInvoices("client", WALLET.client)).map((i) => i.invoiceId), ["1"])
      } finally {
        await fresh.close()
      }
    } finally {
      await world.close()
    }
  })
})
