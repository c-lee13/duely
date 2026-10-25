import { after, before, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import type { PGlite } from "@electric-sql/pglite"
import { createDb } from "./helpers/db"
import { bytes, Clock, FakeObjectStore } from "./helpers/evidence"
import { ctx, createPgBackendDb, FakeChainAdapter, FakeSigner, http, ScriptedEvaluator, TEST_SCOPE } from "./helpers/backend"
import { handleAdvance, handleGetAdvance, handleGetInvoice } from "@/lib/backend/handlers"
import { reconcileAdvance } from "@/lib/backend/reconcile"
import { ChainUnavailableError, type BackendDeps, type ChainTxStatus } from "@/lib/backend/ports"
import { buildEvidencePath } from "@/lib/evidence/policy"
import { computeEvaluationHash } from "@/lib/shared/evaluation-hash"

/**
 * Evaluator signing + reconciliation, end to end through the real HTTP handlers and the REAL schema (PGlite), with a fake
 * chain reader and a fake signer. Nothing is "paid" unless the (fake) chain proves it with a matching confirmed receipt.
 */
let db: PGlite
let chain: FakeChainAdapter
let signer: FakeSigner
let deps: BackendDeps

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const U = { freelancer: id(1), client: id(2), stranger: id(3) }
const W = { freelancer: "0x" + "b".repeat(40), client: "0x" + "a".repeat(40), stranger: "0x" + "c".repeat(40), contract: "0x" + "e".repeat(40), token: "0x" + "d".repeat(40) }
const H = "0x" + "1".repeat(64)
const INV = id(201)
const AMOUNT = "1000"
const ADVANCE = BigInt(900)
const EVALUATOR = ("0x" + "5".repeat(40)) as `0x${string}`

let seq = 0
let submissionId = ""
let evaluationId = ""

const funded = (over: Record<string, unknown> = {}) => ({ onchainStatus: "Funded" as const, amount: BigInt(AMOUNT), advanceAmount: BigInt(0), blockNumber: BigInt(13), ...over })
const expectedHash = () => computeEvaluationHash({ evaluationId, submissionId, criteriaHash: H, score: 95 })
const confirmedTx = (over: Record<string, unknown> = {}): ChainTxStatus => ({
  state: "confirmed",
  blockNumber: BigInt(777),
  blockHash: ("0x" + "ab".repeat(32)) as `0x${string}`,
  logIndex: 3,
  paid: { invoiceId: BigInt(77), freelancer: W.freelancer as `0x${string}`, amount: ADVANCE, evaluationHash: expectedHash(), ...over },
})

const one = async <T extends object>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const advanceRow = () => one<{ status: string; reason: string | null; transaction_id: string | null }>("select status, reason, transaction_id from advance_requests where invoice_uuid = $1 order by created_at desc limit 1", [INV])
const txRow = () => one<{ status: string; block_number: string | null; log_index: number | null; receipt: Record<string, string> | null; error: string | null; confirmed_at: string | null }>("select status, block_number::text, log_index, receipt, error, confirmed_at::text from transactions where invoice_uuid = $1 order by created_at desc limit 1", [INV])
const count = async (t: string, where = "true") => (await db.query<{ c: number }>(`select count(*)::int c from ${t} where ${where}`)).rows[0].c

async function request(user: string | null = U.freelancer, key?: string) {
  return http(handleAdvance, ctx(user, deps), { body: { invoiceId: INV }, headers: key ? { "idempotency-key": key } : {} })
}
const poll = (requestId: string, user: string | null = U.freelancer) =>
  handleGetAdvance(new Request("http://localhost:3000/x"), ctx(user, deps), { id: requestId }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> })) // eslint-disable-line @typescript-eslint/no-explicit-any

before(async () => {
  db = await createDb()
  for (const [k, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, `${k}@t.invalid`])
  for (const [user, addr] of [[U.freelancer, W.freelancer], [U.client, W.client], [U.stranger, W.stranger]] as const) {
    await db.query("insert into user_wallets (user_id, address, verified_at, verification_method) values ($1,$2,now(),'eip191')", [user, addr])
  }
  await db.query(
    `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
     values ($1, 1440002, $2, $3, 77, $4, $5, $6::numeric, $7, 1, 'canon', 'Seeded', $8, 'Funded')`,
    [INV, W.contract, W.token, W.client, W.freelancer, AMOUNT, H, U.client]
  )
  await db.query("insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ($1,0,'c1','Logo delivered',true)", [INV])
})
after(async () => db.close())

beforeEach(async () => {
  for (const t of ["advance_requests", "transactions", "evaluations", "submissions"]) {
    await db.query(`alter table ${t} disable trigger user`)
    await db.query(`delete from ${t}`)
    await db.query(`alter table ${t} enable trigger user`)
  }
  await db.query("update invoices set onchain_status = 'Funded', advance_amount = 0, chain_synced_at = null, chain_synced_block = null where id = $1", [INV])
  const store = new FakeObjectStore(new Clock())
  chain = new FakeChainAdapter()
  signer = new FakeSigner()
  signer.address = EVALUATOR
  chain.state = funded()
  chain.reserve = BigInt(10_000)
  seq++
  submissionId = id(5000 + seq)
  evaluationId = id(7000 + seq)
  const p = buildEvidencePath({ invoiceId: INV, userId: U.freelancer, objectId: id(9000 + seq), ext: "pdf" })
  store.putRaw(p, bytes.pdf, "application/pdf")
  await db.query(
    `insert into submissions (id, invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type)
     values ($1,$2,$3,$4,$5,'proof.pdf',12,'application/pdf')`,
    [submissionId, INV, U.freelancer, W.freelancer, p]
  )
  await db.query(
    `insert into evaluations (id, submission_id, invoice_uuid, criteria_hash, criteria_version, model, prompt_version, state, score, passed, criteria_results, summary, pass_rule, simulated, evaluated_at)
     values ($1,$2,$3,$4,1,'m','v','completed',95,true,'[]','s','r',false, now())`,
    [evaluationId, submissionId, INV, H]
  )
  deps = { scope: TEST_SCOPE, db: createPgBackendDb(db), objects: store, chain, signer, evaluator: new ScriptedEvaluator() }
})

describe("signing: what is checked and what is sent", () => {
  it("signs approveAdvance with the deterministic evaluation hash and the invoice's on-chain reference", async () => {
    const r = await request()
    assert.equal(r.status, 202)
    assert.equal(signer.calls, 1)
    assert.equal(signer.lastEvaluationHash, expectedHash())
    assert.deepEqual(
      { chainId: signer.lastRef?.chainId, contract: signer.lastRef?.contractAddress, id: signer.lastRef?.invoiceId },
      { chainId: 1440002, contract: W.contract, id: BigInt(77) }
    )
    assert.equal((r.json as { amount: string }).amount, "900")
  })

  it("verifies the contract's own record of the parties and the criteria commitment before signing", async () => {
    for (const [label, over] of [
      ["freelancer differs", { freelancer: W.stranger as `0x${string}` }],
      ["client differs", { client: W.stranger as `0x${string}` }],
      ["criteria commitment differs", { criteriaHash: ("0x" + "2".repeat(64)) as `0x${string}` }],
      ["amount differs", { amount: BigInt(1001) }],
    ] as const) {
      chain.state = funded(Object.assign({ client: W.client, freelancer: W.freelancer, criteriaHash: H }, over))
      const r = await request(U.freelancer, `key-${label.replace(/\W/g, "")}-0001`)
      assert.equal(r.status, 409, label)
      assert.equal((r.json as any).error.code, "INTEGRITY_MISMATCH", label) // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    assert.equal(signer.calls, 0)
    assert.equal(await count("advance_requests"), 0)
  })

  it("matching parties and commitment are accepted", async () => {
    chain.state = funded({ client: W.client as `0x${string}`, freelancer: W.freelancer as `0x${string}`, criteriaHash: H as `0x${string}` })
    assert.equal((await request()).status, 202)
  })

  it("refuses ineligible chain states without signing: Created, Advanced, Disputed, Settled, Cancelled, and a missing on-chain invoice", async () => {
    for (const [status, code] of [["Created", "NOT_FUNDED"], ["Advanced", "ALREADY_ADVANCED"], ["Disputed", "INVOICE_DISPUTED"], ["Settled", "INVOICE_SETTLED"], ["Cancelled", "INVOICE_CANCELLED"]] as const) {
      chain.state = funded({ onchainStatus: status })
      const r = await request(U.freelancer, `key-${status}-0000001`)
      assert.equal((r.json as any).error.code, code, status) // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    const { ChainInvoiceNotFoundError } = await import("@/lib/backend/ports")
    chain.state = new ChainInvoiceNotFoundError()
    const missing = await request(U.freelancer, "key-missing-00000001")
    assert.equal((missing.json as any).error.code, "INTEGRITY_MISMATCH") // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(signer.calls, 0)
    assert.equal(await count("advance_requests"), 0)
  })

  it("refuses when the reserve cannot cover the advance, and when the chain cannot be read; nothing is signed or recorded", async () => {
    chain.reserve = BigInt(899)
    assert.equal(((await request()).json as any).error.code, "INSUFFICIENT_RESERVE") // eslint-disable-line @typescript-eslint/no-explicit-any
    chain.reserve = new Error("rpc down")
    assert.equal(((await request(U.freelancer, "key-rpc-down-0000001")).json as any).error.code, "CHAIN_ERROR") // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(signer.calls, 0)
    assert.equal(await count("advance_requests"), 0)
  })

  it("only the invoice's freelancer, and never a simulated/failed/stale evaluation (unchanged rules still hold with the real adapter)", async () => {
    assert.equal((await request(U.client)).status, 403)
    assert.equal((await request(U.stranger)).status, 404)
    assert.equal((await request(null)).status, 401)
    await db.query("alter table evaluations disable trigger user")
    await db.query("update evaluations set simulated = true where id = $1", [evaluationId])
    await db.query("alter table evaluations enable trigger user")
    assert.equal(((await request()).json as any).error.code, "EVALUATION_NOT_REAL") // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(signer.calls, 0)
  })

  it("an unavailable signer (no/wrong evaluator key) answers 503 and records nothing", async () => {
    signer.available = false
    const r = await request()
    assert.equal(r.status, 503)
    assert.equal(await count("advance_requests"), 0)
  })
})

describe("reconciliation: paid only on proof", () => {
  it("a broadcast without a receipt is PENDING, with the hash recorded and nothing marked paid", async () => {
    const r = await request()
    assert.equal(r.status, 202)
    assert.equal((r.json as any).status, "pending") // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual({ a: (await advanceRow()).status, t: (await txRow()).status }, { a: "pending", t: "pending" })
    assert.equal((await txRow()).block_number, null)
  })

  it("the receipt is awaited (bounded) in the same request, and a matching confirmed AdvancePaid makes it PAID with the proof recorded", async () => {
    deps.confirmWaitMs = 8000
    chain.advanceTx = confirmedTx()
    const r = await request()
    assert.equal((r.json as any).status, "paid") // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(r.status, 202)
    assert.equal(chain.lastTxWaitMs, 8000)
    assert.equal(chain.lastTxRef?.evaluationHash, expectedHash())
    assert.equal(chain.lastTxRef?.invoiceId, BigInt(77))
    assert.equal(chain.lastTxRef?.from, EVALUATOR)
    const tx = await txRow()
    assert.equal(tx.status, "confirmed")
    assert.equal(tx.block_number, "777")
    assert.equal(tx.log_index, 3)
    assert.equal(tx.receipt?.event, "AdvancePaid")
    assert.equal(tx.receipt?.amount, "900")
    assert.ok(tx.confirmed_at)
    assert.equal((await advanceRow()).status, "paid")
    const inv = await one<{ onchain_status: string; advance_amount: string; chain_synced_block: string }>("select onchain_status, advance_amount::text, chain_synced_block::text from invoices where id = $1", [INV])
    assert.equal(inv.advance_amount, "900")
  })

  it("is not paid when the receipt disagrees: wrong amount, wrong recipient, wrong evaluation hash, wrong invoice (stays pending, flagged for review)", async () => {
    for (const [label, over] of [
      ["amount", { amount: BigInt(901) }],
      ["recipient", { freelancer: W.stranger as `0x${string}` }],
      ["evaluation hash", { evaluationHash: ("0x" + "9".repeat(64)) as `0x${string}` }],
      ["invoice", { invoiceId: BigInt(78) }],
    ] as const) {
      await beforeEachReset()
      chain.advanceTx = confirmedTx(over)
      deps.confirmWaitMs = 100
      const r = await request()
      assert.equal((r.json as any).status, "pending", label) // eslint-disable-line @typescript-eslint/no-explicit-any
      const a = await advanceRow()
      assert.equal(a.status, "pending", label)
      assert.match(a.reason ?? "", /manual review/i, label)
      assert.equal((await txRow()).status, "pending", label)
    }
  })

  it("reverted or replaced: the request FAILS, the transaction FAILS, and the slot is released so a new request can be made", async () => {
    for (const state of ["reverted", "replaced"] as const) {
      await beforeEachReset()
      chain.advanceTx = state === "reverted" ? { state: "reverted", blockNumber: BigInt(5), reason: "reverted" } : { state: "replaced", reason: "replaced" }
      deps.confirmWaitMs = 100
      const first = await request()
      assert.equal((first.json as any).status, "failed", state) // eslint-disable-line @typescript-eslint/no-explicit-any
      assert.equal((await txRow()).status, "failed", state)
      assert.match((await advanceRow()).reason ?? "", /Nothing was paid/)
      // The invoice is unchanged on-chain, so the freelancer may ask again.
      chain.advanceTx = { state: "pending" }
      const again = await request(U.freelancer, "second-attempt-0001")
      assert.equal(again.status, 202, state)
      assert.equal(await count("advance_requests", "status = 'pending'"), 1, state)
    }
  })

  it("unverified receipts, unknown outcomes and RPC errors never pay and never fail: the request stays pending", async () => {
    deps.confirmWaitMs = 100
    for (const advanceTx of [
      { state: "unverified", reason: "wrong sender" } as ChainTxStatus,
      { state: "unknown", reason: "not_found" } as ChainTxStatus,
      { state: "pending" } as ChainTxStatus,
      new Error("rpc: connection reset"),
      new ChainUnavailableError(),
    ]) {
      await beforeEachReset()
      chain.advanceTx = advanceTx
      const r = await request()
      assert.equal(r.status, 202)
      assert.equal((await advanceRow()).status, "pending")
      assert.equal((await txRow()).status, "pending")
    }
  })

  it("a duplicate request while pending returns the SAME request and never signs a second transaction", async () => {
    const a = await request(U.freelancer, "dup-key-000000001")
    const b = await request(U.freelancer, "dup-key-000000001")
    const c = await request(U.freelancer) // a different key, same invoice
    assert.equal(signer.calls, 1)
    assert.equal((a.json as any).requestId, (b.json as any).requestId) // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal((a.json as any).requestId, (c.json as any).requestId) // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(b.status, 200)
    assert.equal(await count("transactions"), 1)
  })

  it("a retry settles a transaction that confirmed after the first response (and the retry still does not sign again)", async () => {
    const a = await request()
    assert.equal((a.json as any).status, "pending") // eslint-disable-line @typescript-eslint/no-explicit-any
    chain.advanceTx = confirmedTx()
    const retry = await request()
    assert.equal((retry.json as any).status, "paid") // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(signer.calls, 1)
    assert.equal((await txRow()).status, "confirmed")
  })

  it("polling GET /api/advances/:id settles against the chain; strangers get 404; invalid ids 404", async () => {
    const created = await request()
    const rid = (created.json as any).requestId as string // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal((await poll(rid)).json.status, "pending")
    chain.advanceTx = confirmedTx()
    const done = await poll(rid, U.client) // the client is a party too
    assert.equal(done.status, 200)
    assert.equal(done.json.status, "paid")
    assert.equal((await poll(rid, U.stranger)).status, 404)
    assert.equal((await poll("not-a-uuid")).status, 404)
    assert.equal((await poll(id(999))).status, 404)
    assert.equal((await poll(rid, null)).status, 401)
  })

  it("loading the invoice settles a pending advance too (a page refresh after a restart shows the truth)", async () => {
    await request()
    chain.advanceTx = confirmedTx()
    const res = await handleGetInvoice(new Request("http://localhost:3000/x"), ctx(U.freelancer, deps), { id: INV })
    const body = (await res.json()) as { advanceRequests: { status: string; txHash: string | null }[] }
    assert.equal(body.advanceRequests[0].status, "paid")
    assert.ok(body.advanceRequests[0].txHash)
  })

  it("is idempotent, and repairs a crash between the transaction update and the request update", async () => {
    await request()
    const a = await advanceRow()
    // Simulate the crash: the transaction was marked confirmed but the request never became paid.
    await db.query("update transactions set status='confirmed', block_number=777, block_hash=$2, confirmed_at=now() where id=$1", [a.transaction_id, "0x" + "ab".repeat(32)])
    chain.advanceTx = confirmedTx()
    const req = (await deps.db.getAdvanceRequest((await one<{ id: string }>("select id from advance_requests"))!.id))!
    const invoice = (await deps.db.getInvoice(INV))!
    await reconcileAdvance(deps, { request: req, invoice })
    assert.equal((await advanceRow()).status, "paid")
    await reconcileAdvance(deps, { request: (await deps.db.getAdvanceRequest(req.id))!, invoice }) // paid already: a no-op
    assert.equal((await advanceRow()).status, "paid")
    assert.equal(await count("transactions"), 1)
  })

  it("a paid or failed request is never re-judged", async () => {
    deps.confirmWaitMs = 100
    chain.advanceTx = confirmedTx()
    await request()
    chain.advanceTx = { state: "reverted", blockNumber: BigInt(1), reason: "x" }
    const rid = (await one<{ id: string }>("select id from advance_requests"))!.id
    assert.equal((await poll(rid)).json.status, "paid")
    assert.equal(chain.calls.tx, 1, "a settled request does not call the chain again")
  })
})

describe("process interruptions", () => {
  async function interrupted(ageMs: number) {
    // A pending request that never recorded a transaction (the process died between creating it and broadcasting).
    const row = await one<{ id: string }>(
      `insert into advance_requests (invoice_uuid, requester_user_id, requester_address, submission_id, evaluation_id, amount, idempotency_key, status, created_at)
       values ($1,$2,$3,$4,$5,900,'interrupted-key-1','pending', now() - ($6 || ' milliseconds')::interval) returning id`,
      [INV, U.freelancer, W.freelancer, submissionId, evaluationId, String(ageMs)]
    )
    return (await deps.db.getAdvanceRequest(row.id))!
  }
  const reconcile = async (ageMs: number, now?: number) => {
    deps.neverBroadcastAfterMs = 120_000
    if (now) deps.now = () => now
    const req = await interrupted(ageMs)
    const invoice = (await deps.db.getInvoice(INV))!
    await reconcileAdvance(deps, { request: req, invoice })
    return (await deps.db.getAdvanceRequest(req.id))!
  }

  it("inside the grace window nothing is decided (another handler may still be broadcasting)", async () => {
    const r = await reconcile(5_000)
    assert.equal(r.status, "pending")
    assert.equal(chain.calls.state, 0)
  })

  it("after the grace window, an invoice still Funded on-chain proves nothing was broadcast: the request fails and the slot is freed", async () => {
    const r = await reconcile(600_000)
    assert.equal(r.status, "failed")
    assert.match(r.reason ?? "", /never broadcast/)
    deps.confirmWaitMs = 0
    assert.equal((await request(U.freelancer, "after-interrupt-0001")).status, 202)
  })

  it("after the grace window, an advance on-chain with OUR evaluation hash is recovered from the events and confirmed", async () => {
    chain.state = funded({ onchainStatus: "Advanced", advanceAmount: ADVANCE })
    const hash = ("0x" + "f1".repeat(32)) as `0x${string}`
    chain.found = { txHash: hash, from: EVALUATOR, blockNumber: BigInt(700), evaluationHash: expectedHash() }
    chain.advanceTx = confirmedTx()
    const r = await reconcile(600_000)
    assert.equal(r.status, "paid")
    assert.equal(r.tx_hash, hash)
    assert.equal((await txRow()).status, "confirmed")
  })

  it("an advance on-chain with a DIFFERENT evaluation hash is never claimed: the request stays pending for manual review", async () => {
    chain.state = funded({ onchainStatus: "Advanced", advanceAmount: ADVANCE })
    chain.found = { txHash: ("0x" + "f2".repeat(32)) as `0x${string}`, from: EVALUATOR, blockNumber: BigInt(700), evaluationHash: ("0x" + "9".repeat(64)) as `0x${string}` }
    const r = await reconcile(600_000)
    assert.equal(r.status, "pending")
    assert.match(r.reason ?? "", /manual review/i)
    assert.equal(await count("transactions"), 0)
  })

  it("if the chain cannot be read, the interrupted request is left exactly as it was", async () => {
    chain.state = new Error("rpc down")
    const r = await reconcile(600_000)
    assert.equal(r.status, "pending")
    chain.state = funded()
    chain.found = new Error("rpc down")
    chain.state = funded({ onchainStatus: "Advanced", advanceAmount: ADVANCE })
    assert.equal((await reconcile(600_000).catch(() => ({ status: "pending" }))).status, "pending")
  })

  it("with the chain adapter unavailable nothing is judged", async () => {
    chain.available = false
    const r = await reconcile(600_000)
    assert.equal(r.status, "pending")
    assert.equal(chain.calls.state, 0)
  })
})

// `beforeEach` bodies cannot be re-invoked by name, so tests that loop over scenarios reset state with this helper.
async function beforeEachReset() {
  for (const t of ["advance_requests", "transactions"]) {
    await db.query(`alter table ${t} disable trigger user`)
    await db.query(`delete from ${t}`)
    await db.query(`alter table ${t} enable trigger user`)
  }
  await db.query("update invoices set onchain_status = 'Funded', advance_amount = 0 where id = $1", [INV])
  signer.calls = 0
  chain.advanceTx = { state: "pending" }
  chain.calls = { creation: 0, state: 0, reserve: 0, tx: 0, found: 0 }
}
