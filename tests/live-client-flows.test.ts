import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it } from "node:test"
import { DomainError } from "@/lib/frontend/errors"
import { computeCriteriaHash } from "@/lib/shared/criteria"
import type { TxProgress } from "@/lib/frontend/tx-runner"
import { ADDR } from "./helpers/sim-contract"
import { CRITERIA, ONE, U, WALLET, createWorld, input, type World } from "./helpers/live-harness"

/**
 * Client workflows in live mode: create invoice -> register -> approve allowance -> fund escrow, with the real browser
 * repository, wallet gate, SDK, backend handlers, chain adapter and schema, against one simulated chain.
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
const steps = (progress: TxProgress[]) => progress.map((p) => `${p.label}:${p.status}`)
const dbCount = async (sql: string, params: unknown[] = []) => (await w.db.query<{ c: number }>(sql, params)).rows[0].c

before(async () => {
  w = await createWorld()
})
after(async () => w.close())
beforeEach(async () => {
  // fresh ledger and database rows per test; wallet back to the client on the right network
  w.chain.state.invoices.clear()
  w.chain.state.nextInvoiceId = BigInt(1)
  w.chain.state.reserve = BigInt(0)
  w.chain.state.escrow = BigInt(0)
  w.chain.state.allowances.clear()
  w.chain.state.balances.set(WALLET.client, BigInt(60_000_000))
  w.chain.state.balances.set(WALLET.freelancer, BigInt(0))
  w.sim.sent.length = 0
  for (const t of ["advance_requests", "transactions", "evaluations", "submissions"]) {
    await w.db.exec(`alter table ${t} disable trigger user; delete from ${t}; alter table ${t} enable trigger user`)
  }
  await w.db.exec("alter table invoice_criteria disable trigger user; alter table invoices disable trigger user; delete from invoice_criteria; delete from invoices; alter table invoice_criteria enable trigger user; alter table invoices enable trigger user")
  w.storage.data.clear()
  w.wallet.account = ADDR.client
  w.wallet.chainId = 1449000
})

describe("create invoice (wallet -> chain -> backend registration)", () => {
  it("runs create then register in order, each step visible; the result exists on-chain AND in the database with the verified commitment", async () => {
    const progress: TxProgress[] = []
    const repo = w.repoFor(U.client)
    const created = await repo.createInvoice(input(), (p) => progress.push(p))

    assert.deepEqual(steps(progress), [
      "Create invoice:awaiting_wallet",
      "Create invoice:pending",
      "Create invoice:confirmed",
      "Register invoice with Duely:pending",
      "Register invoice with Duely:confirmed",
    ])
    assert.equal(created.invoiceId, "1")
    assert.equal(created.onchainStatus, "Created")
    assert.equal(created.amount, ONE.toString())

    // The calldata carried the shared criteria hash, and the server stored and re-verified exactly that hash.
    const expectedHash = computeCriteriaHash(CRITERIA.map((c, i) => ({ id: `c${i + 1}`, text: c.text, mandatory: c.mandatory })))
    assert.equal(w.chain.state.invoices.get(BigInt(1))?.metadataHash, expectedHash)
    const row = (await w.db.query<{ criteria_hash: string; chain_id: number; client_address: string; contract_address: string; invoice_id: string }>("select criteria_hash, chain_id::int, client_address, contract_address, invoice_id::text from invoices")).rows[0]
    assert.equal(row.criteria_hash, expectedHash)
    assert.deepEqual({ chain: row.chain_id, client: row.client_address, contract: row.contract_address, id: row.invoice_id }, { chain: 1449000, client: WALLET.client, contract: w.scope.contractAddress, id: "1" })
    assert.equal(await dbCount("select count(*)::int c from invoice_criteria"), 2)
    assert.deepEqual(w.sim.sent.map((s) => s.fn), ["createInvoice"], "exactly one transaction")
  })

  it("the invoice shown afterwards comes from the chain: Created, nothing in escrow", async () => {
    const repo = w.repoFor(U.client)
    await repo.createInvoice(input())
    const bundle = await repo.getInvoice("1")
    assert.equal(bundle.invoice.onchainStatus, "Created")
    assert.equal(bundle.invoice.escrowBalance, "0")
    assert.equal(bundle.chainVerified, true)
    assert.equal(bundle.transactions[0].action, "createInvoice")
    assert.equal(bundle.transactions[0].status, "confirmed")
  })

  it("refuses before the wallet when MetaMask is on the wrong network or the wrong/unlinked account (no transaction, no database row)", async () => {
    const repo = w.repoFor(U.client)
    w.wallet.chainId = 1
    assert.equal(await codeOf(repo.createInvoice(input())), "WRONG_NETWORK")
    w.wallet.chainId = 1449000
    w.wallet.account = ADDR.stranger // not linked to this sign-in's account
    w.wallet.account = "0x" + "9".repeat(40) // not a verified wallet of anyone
    assert.equal(await codeOf(repo.createInvoice(input())), "WRONG_ACCOUNT")
    assert.equal(w.sim.sent.length, 0)
    assert.equal(await dbCount("select count(*)::int c from invoices"), 0)
  })

  it("rejects invalid input locally: zero amount, freelancer equal to the client", async () => {
    const repo = w.repoFor(U.client)
    assert.equal(await codeOf(repo.createInvoice(input(BigInt(0)))), "INVALID_INPUT")
    assert.equal(await codeOf(repo.createInvoice(input(ONE, { freelancer: ADDR.client }))), "INVALID_INPUT")
    assert.equal(w.sim.sent.length, 0)
  })

  it("a rejected wallet prompt is USER_REJECTED and leaves nothing behind", async () => {
    const repo = w.repoFor(U.client)
    w.chain.send.mode = "reject"
    assert.equal(await codeOf(repo.createInvoice(input())), "USER_REJECTED")
    w.chain.send.mode = "ok"
    assert.equal(w.chain.state.invoices.size, 0)
    assert.equal(await dbCount("select count(*)::int c from invoices"), 0)
    assert.deepEqual(await repo.listTransactions(), [])
  })

  it("a reverted creation is a failure (TX_FAILED), is logged as failed, and is never registered", async () => {
    const world = await createWorld({ revert: { createInvoice: true } })
    try {
      const repo = world.repoFor(U.client)
      assert.equal(await codeOf(repo.createInvoice(input())), "TX_FAILED")
      const txs = await repo.listTransactions()
      assert.deepEqual(txs.map((t) => t.status), ["failed"])
      assert.equal((await world.db.query<{ c: number }>("select count(*)::int c from invoices")).rows[0].c, 0)
    } finally {
      await world.close()
    }
  })

  it("a creation that stays unmined is TX_UNCONFIRMED (shown pending, never created), and is not registered", async () => {
    const world = await createWorld({ hold: { createInvoice: true } })
    try {
      const repo = world.repoFor(U.client)
      assert.equal(await codeOf(repo.createInvoice(input())), "TX_UNCONFIRMED")
      const [tx] = await repo.listTransactions()
      assert.equal(tx.status, "pending")
      assert.match(tx.error ?? "", /Do not send it twice/)
      assert.equal((await world.db.query<{ c: number }>("select count(*)::int c from invoices")).rows[0].c, 0)
    } finally {
      await world.close()
    }
  })

  it("if registration fails after the on-chain creation, the user is told nothing is lost, and the next load completes it", async () => {
    let failing = true
    const first = w.repoFor(U.client, { failRegistration: () => failing })
    const progress: TxProgress[] = []
    await assert.rejects(first.createInvoice(input(), (p) => progress.push(p)), (e: DomainError) => {
      assert.equal(e.code, "REGISTRATION_PENDING")
      assert.match(e.message, /exists on-chain/)
      assert.match(e.message, /Nothing is lost/)
      return true
    })
    assert.equal(w.chain.state.invoices.size, 1, "the invoice exists on-chain")
    assert.equal(await dbCount("select count(*)::int c from invoices"), 0, "but is not registered yet")
    assert.equal(progress.at(-1)?.status, "failed")

    failing = false
    const reloaded = w.repoFor(U.client) // a page reload: new repository, same browser storage
    const list = await reloaded.listInvoices("client", WALLET.client)
    assert.deepEqual(list.map((i) => i.invoiceId), ["1"])
    assert.equal(await dbCount("select count(*)::int c from invoices"), 1)
    // and it is idempotent: another load does not duplicate
    await w.repoFor(U.client).listInvoices("client", WALLET.client)
    assert.equal(await dbCount("select count(*)::int c from invoices"), 1)
  })
})

describe("fund escrow (exact allowance, then fund)", () => {
  async function created() {
    const repo = w.repoFor(U.client)
    await repo.createInvoice(input())
    w.sim.sent.length = 0
    return repo
  }

  it("approves exactly the amount, then funds; both confirmed; escrow and status come back from the chain", async () => {
    const repo = await created()
    const progress: TxProgress[] = []
    await repo.fundInvoice("1", (p) => progress.push(p))
    assert.deepEqual(steps(progress), [
      "Approve dUSD allowance:awaiting_wallet",
      "Approve dUSD allowance:pending",
      "Approve dUSD allowance:confirmed",
      "Fund escrow:awaiting_wallet",
      "Fund escrow:pending",
      "Fund escrow:confirmed",
    ])
    const approve = w.sim.sent.find((s) => s.fn === "approve")!
    assert.equal(approve.args[1], ONE, "exact amount, never unlimited")
    assert.equal(w.chain.state.escrow, ONE)
    assert.equal(w.chain.state.balances.get(WALLET.client), BigInt(59_000_000))
    const bundle = await repo.getInvoice("1")
    assert.equal(bundle.invoice.onchainStatus, "Funded")
    assert.equal(bundle.invoice.escrowBalance, ONE.toString())
  })

  it("skips the approval when the allowance is already enough", async () => {
    const repo = await created()
    w.chain.state.allowances.set(`${WALLET.client}:${w.scope.contractAddress}`, ONE)
    const progress: TxProgress[] = []
    await repo.fundInvoice("1", (p) => progress.push(p))
    assert.deepEqual(steps(progress).filter((s) => s.endsWith("confirmed")), ["Fund escrow:confirmed"])
    assert.deepEqual(w.sim.sent.map((s) => s.fn), ["fundInvoice"])
  })

  it("never shows 'funded' when the funding transaction reverts: status stays Created, the approval remains the only confirmed step", async () => {
    const world = await createWorld({ revert: { fundInvoice: true } })
    try {
      const repo = world.repoFor(U.client)
      await repo.createInvoice(input())
      assert.equal(await codeOf(repo.fundInvoice("1")), "TX_FAILED")
      assert.equal((await repo.getInvoice("1")).invoice.onchainStatus, "Created")
      assert.equal(world.chain.state.escrow, BigInt(0))
      const txs = (await repo.listTransactions()).map((t) => `${t.action}:${t.status}`).sort()
      assert.deepEqual(txs, ["approve:confirmed", "createInvoice:confirmed", "fundInvoice:failed"])
    } finally {
      await world.close()
    }
  })

  it("refuses without sending anything: insufficient balance, paused token, already funded, wrong account, wrong network", async () => {
    const repo = await created()
    w.chain.state.balances.set(WALLET.client, ONE - BigInt(1))
    await assert.rejects(repo.fundInvoice("1"), (e: DomainError) => e.code === "INSUFFICIENT_BALANCE" && /hold 0\.999999 dUSD/.test(e.message) && /needs 1 dUSD/.test(e.message))
    w.chain.state.balances.set(WALLET.client, BigInt(60_000_000))
    w.wallet.account = ADDR.freelancer
    assert.equal(await codeOf(repo.fundInvoice("1")), "WRONG_ACCOUNT")
    w.wallet.account = ADDR.client
    w.wallet.chainId = 56
    assert.equal(await codeOf(repo.fundInvoice("1")), "WRONG_NETWORK")
    w.wallet.chainId = 1449000
    assert.equal(w.sim.sent.length, 0)

    await repo.fundInvoice("1")
    w.sim.sent.length = 0
    assert.equal(await codeOf(repo.fundInvoice("1")), "INVALID_STATUS", "funding twice is refused before the wallet")
    assert.equal(w.sim.sent.length, 0)

    const paused = await createWorld({ tokenPaused: true })
    try {
      const r = paused.repoFor(U.client)
      await r.createInvoice(input())
      assert.equal(await codeOf(r.fundInvoice("1")), "TOKEN_PAUSED")
      assert.equal(paused.sim.sent.filter((s) => s.fn !== "createInvoice").length, 0)
    } finally {
      await paused.close()
    }
  })

  it("only the invoice's client can fund it, even if another verified wallet is selected", async () => {
    const repo = await created()
    w.wallet.account = ADDR.operator // verified for a different user, but not this invoice's client
    assert.equal(await codeOf(repo.fundInvoice("1")), "WRONG_ACCOUNT")
    assert.equal(w.sim.sent.length, 0)
  })

  it("subscribers are told after each transaction so open screens re-read", async () => {
    const repo = await created()
    let n = 0
    repo.subscribe(() => n++)
    await repo.fundInvoice("1")
    assert.ok(n >= 2, `expected at least one notification per transaction, got ${n}`)
  })
})

describe("deployment isolation in wallet flows", () => {
  it("an invoice that belongs to another deployment can't be funded: not found in this one, and no wallet prompt", async () => {
    await w.db.query(
      `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
       values ($1,1449000,$2,$3,55,$4,$5,1000,$6,1,'c','Other deployment',$7,'Created')`,
      [U.stranger, "0x1b972ec6b1b5e0b592010e7484bef0accc382792", "0x27b57a9d0b8d24eb97259c4e2279e45255e016f3", WALLET.client, WALLET.freelancer, "0x" + "1".repeat(64), U.client]
    )
    const repo = w.repoFor(U.client)
    assert.equal(await codeOf(repo.fundInvoice("55")), "NOT_FOUND")
    assert.equal(w.sim.sent.length, 0)
    assert.deepEqual((await repo.listInvoices("client", WALLET.client)).map((i) => i.invoiceId), [], "and it is not listed")
  })
})
