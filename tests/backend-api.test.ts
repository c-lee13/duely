import { after, before, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import type { PGlite } from "@electric-sql/pglite"
import { createDb, as } from "./helpers/db"
import { bytes, Clock, FakeObjectStore } from "./helpers/evidence"
import { ctx, createPgBackendDb, FakeChainAdapter, FakeSigner, http, ScriptedEvaluator, TEST_SCOPE, unavailableDeps, type Harness } from "./helpers/backend"
import { handleAdvance, handleCreateInvoice, handleEvaluate, handleGetInvoice } from "@/lib/backend/handlers"
import { advanceAmountFor } from "@/lib/backend/advances"
import { canonicalCriteriaString, computeCriteriaHash, type CanonicalCriterion } from "@/lib/backend/criteria"
import { demoEvaluator, resolveEvaluatorMode } from "@/lib/backend/demo-evaluator"
import { decidePassed } from "@/lib/backend/evaluation"
import { ChainUnavailableError, disabledEvaluator, type BackendDeps } from "@/lib/backend/ports"
import { buildEvidencePath } from "@/lib/evidence/policy"
import { PASS_SCORE_THRESHOLD } from "@/lib/frontend/eligibility"

let db: PGlite
let h: Harness

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const U = { freelancer: id(1), client: id(2), stranger: id(3), claimant: id(4), nowallet: id(5), freelancer2: id(6) }
const W = {
  freelancer: "0x" + "b".repeat(40),
  client: "0x" + "a".repeat(40),
  stranger: "0x" + "c".repeat(40),
  freelancer2: "0x" + "f".repeat(40),
  contract: "0x" + "e".repeat(40),
  token: "0x" + "d".repeat(40),
}
const INV = { adv: id(201), big: id(202), odd: id(203), other: id(204) }
const H = "0x" + "1".repeat(64)
const TX = "0x" + "cd".repeat(32)
const BIG = "1000000000000000000000"

async function seedInvoice(invId: string, n: number, amount: string, client: string, freelancer: string) {
  await db.query(
    `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
     values ($1, 1440002, $2, $3, $4, $5, $6, $7::numeric, $8, 2, 'canon', 'Seeded', $9, 'Funded')`,
    [invId, W.contract, W.token, n, client, freelancer, amount, H, U.client]
  )
  await db.query("insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ($1,0,'c1','Logo delivered',true), ($1,1,'c2','Source files included',false)", [invId])
}

before(async () => {
  db = await createDb()
  for (const [k, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1, $2)", [uid, `${k}@t.invalid`])
  for (const [user, addr] of [[U.freelancer, W.freelancer], [U.client, W.client], [U.stranger, W.stranger], [U.freelancer2, W.freelancer2]] as const) {
    await db.query("insert into user_wallets (user_id, address, verified_at, verification_method) values ($1, $2, now(), 'eip191')", [user, addr])
  }
  await db.query("insert into user_wallets (user_id, address) values ($1, $2)", [U.claimant, W.freelancer]) // unverified claim only
  await seedInvoice(INV.adv, 1, "1000", W.client, W.freelancer)
  await seedInvoice(INV.big, 2, BIG, W.client, W.freelancer)
  await seedInvoice(INV.odd, 3, "999", W.client, W.freelancer)
  await seedInvoice(INV.other, 4, "1000", W.stranger, W.freelancer2)
})
after(async () => db.close())

beforeEach(async () => {
  for (const t of ["advance_requests", "transactions", "evaluations", "submissions"]) {
    await db.query(`alter table ${t} disable trigger user`)
    await db.query(`delete from ${t}`)
    await db.query(`alter table ${t} enable trigger user`)
  }
  // registered-through-the-API invoices (they carry a create tx hash); seeded ones do not
  await db.query("alter table invoice_criteria disable trigger user")
  await db.query("alter table invoices disable trigger user")
  await db.query("delete from invoice_criteria where invoice_uuid in (select id from invoices where create_tx_hash is not null)")
  await db.query("delete from invoices where create_tx_hash is not null")
  await db.query("alter table invoice_criteria enable trigger user")
  await db.query("alter table invoices enable trigger user")
  const store = new FakeObjectStore(new Clock())
  const chain = new FakeChainAdapter()
  const signer = new FakeSigner()
  const evaluator = new ScriptedEvaluator()
  h = { deps: { scope: TEST_SCOPE, db: createPgBackendDb(db), objects: store, chain, signer, evaluator }, chain, signer, evaluator, store }
})

// ---- fixtures -------------------------------------------------------------------------------------------------

let subSeq = 0
/** A submission row (explicit, increasing created_at) plus its stored object. */
async function seedSubmission(invoiceId = INV.adv, user = U.freelancer, addr = W.freelancer): Promise<{ id: string; path: string }> {
  subSeq++
  const sid = id(5000 + subSeq)
  const p = buildEvidencePath({ invoiceId, userId: user, objectId: id(9000 + subSeq), ext: "pdf" })
  h.store.putRaw(p, bytes.pdf, "application/pdf")
  await db.query(
    `insert into submissions (id, invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type, created_at)
     values ($1,$2,$3,$4,$5,'proof.pdf',12,'application/pdf', timestamptz '2026-11-01 12:00:00+00' + ($6 || ' minutes')::interval)`,
    [sid, invoiceId, user, addr, p, String(subSeq)]
  )
  return { id: sid, path: p }
}

async function seedEvaluation(submissionId: string, invoiceId: string, o: { passed?: boolean; simulated?: boolean } = {}): Promise<string> {
  subSeq++
  const eid = id(7000 + subSeq)
  await db.query(
    `insert into evaluations (id, submission_id, invoice_uuid, criteria_hash, criteria_version, model, prompt_version, state, score, passed, criteria_results, summary, pass_rule, simulated, evaluated_at)
     values ($1,$2,$3,$4,1,'m','v','completed',$5,$6,'[]','s','r',$7, now())`,
    [eid, submissionId, invoiceId, H, o.passed === false ? 40 : 95, o.passed ?? true, o.simulated ?? false]
  )
  return eid
}

const count = async (t: string, where = "true") => (await db.query<{ c: number }>(`select count(*)::int c from ${t} where ${where}`)).rows[0].c

const CRITERIA: CanonicalCriterion[] = [
  { id: "c1", text: "Logo delivered", mandatory: true },
  { id: "c2", text: "Source files included", mandatory: false },
]
const creation = (o: Record<string, unknown> = {}) => ({
  status: "confirmed" as const,
  chainId: 1440002,
  contractAddress: W.contract as `0x${string}`,
  tokenAddress: W.token as `0x${string}`,
  invoiceId: BigInt(77),
  creator: W.client as `0x${string}`,
  freelancer: W.freelancer as `0x${string}`,
  amount: BigInt(1000),
  criteriaHash: computeCriteriaHash(CRITERIA),
  blockNumber: BigInt(12),
  ...o,
})
const fundedState = (o: Record<string, unknown> = {}) => ({ onchainStatus: "Funded" as const, amount: BigInt(1000), advanceAmount: BigInt(0), blockNumber: BigInt(13), ...o })
const invoiceBody = (o: Record<string, unknown> = {}) => ({ invoiceId: "77", txHash: TX, description: "Brand identity work", criteria: CRITERIA, ...o })

// ======================================================================================================================

describe("mock vs real mode separation", () => {
  it("API code never imports mock data or the mock repository", () => {
    const roots = ["app/api", "lib/backend", "lib/evidence", "lib/auth"]
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name) && /lib\/mocks|mock-repository|\/mocks\//.test(fs.readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))) offenders.push(p)
      }
    }
    roots.forEach(walk)
    assert.deepEqual(offenders, [])
  })

  it("NEXT_PUBLIC_DATA_MODE=mock does not weaken the real API: unauthenticated requests are still refused", async () => {
    const before = process.env.NEXT_PUBLIC_DATA_MODE
    process.env.NEXT_PUBLIC_DATA_MODE = "mock"
    try {
      const r = await http(handleAdvance, ctx(null, h.deps), { body: { invoiceId: INV.adv } })
      assert.equal(r.status, 401)
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_DATA_MODE
      else process.env.NEXT_PUBLIC_DATA_MODE = before
    }
  })

  it("the demo evaluator needs an explicit opt-in and is never active in production", () => {
    assert.equal(resolveEvaluatorMode({}), "disabled")
    assert.equal(resolveEvaluatorMode({ NODE_ENV: "development" }), "disabled")
    assert.equal(resolveEvaluatorMode({ DUELY_EVALUATOR_MODE: "demo", NODE_ENV: "development" }), "demo")
    assert.equal(resolveEvaluatorMode({ DUELY_EVALUATOR_MODE: "demo", NODE_ENV: "test" }), "demo")
    assert.equal(resolveEvaluatorMode({ DUELY_EVALUATOR_MODE: "demo", NODE_ENV: "production" }), "disabled")
    assert.equal(resolveEvaluatorMode({ DUELY_EVALUATOR_MODE: "live", NODE_ENV: "development" }), "disabled")
  })

  it("demo evaluations are flagged simulated, deterministic, and can NEVER authorize an advance, even with chain and signer available", async () => {
    h.deps.evaluator = demoEvaluator
    const sub = await seedSubmission()
    const ev = await http(handleEvaluate, ctx(U.freelancer, h.deps), { body: { submissionId: sub.id } })
    assert.equal(ev.status, 201)
    assert.equal(ev.json?.simulated, true)
    assert.equal(ev.json?.model, "demo-deterministic-evaluator")
    const again = await demoEvaluator.evaluate({ invoiceId: INV.adv, criteriaHash: H as `0x${string}`, criteriaVersion: 1, criteria: CRITERIA, submission: { id: sub.id, fileName: "x", mimeType: "application/pdf", fileSize: 12 }, evidence: bytes.pdf })
    const again2 = await demoEvaluator.evaluate({ invoiceId: INV.adv, criteriaHash: H as `0x${string}`, criteriaVersion: 1, criteria: CRITERIA, submission: { id: "other", fileName: "different-name", mimeType: "text/plain", fileSize: 1 }, evidence: bytes.pdf })
    assert.deepEqual(again, again2, "pure function of invoice, criteria hash and evidence bytes; file name and metadata cannot steer it")

    // Force a PASSING simulated evaluation so only the 'simulated' rule can stop the advance.
    await db.query("alter table evaluations disable trigger user")
    await db.query("update evaluations set passed = true, score = 100 where submission_id = $1", [sub.id])
    await db.query("alter table evaluations enable trigger user")
    h.chain.state = fundedState()
    h.chain.reserve = BigInt(10_000)
    const adv = await http(handleAdvance, ctx(U.freelancer, h.deps), { body: { invoiceId: INV.adv } })
    assert.equal(adv.status, 409)
    assert.equal((adv.json?.error as { code: string }).code, "EVALUATION_NOT_REAL")
    assert.equal(h.signer.calls, 0, "the signer is never reached")
    assert.equal(await count("advance_requests"), 0)
  })
})

describe("unauthorized requests", () => {
  const cases: Array<[string, (d: BackendDeps, user: string | null, extra?: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> | null }>]> = [
    ["POST /api/invoices", (d, u) => http(handleCreateInvoice, ctx(u, d), { body: invoiceBody() })],
    ["POST /api/evaluate", (d, u) => http(handleEvaluate, ctx(u, d), { body: { submissionId: id(1) } })],
    ["POST /api/advances", (d, u) => http(handleAdvance, ctx(u, d), { body: { invoiceId: INV.adv } })],
    ["GET /api/invoices/:id", (d, u) => http(((r: Request, c: never) => handleGetInvoice(r, c, { id: INV.adv })) as never, ctx(u, d), { method: "GET" })],
  ]
  for (const [name, run] of cases) {
    it(`${name}: signed out -> 401`, async () => {
      const r = await run(h.deps, null)
      assert.equal(r.status, 401)
      assert.equal((r.json?.error as { code: string }).code, "UNAUTHENTICATED")
    })
    it(`${name}: no verified wallet (or only an unverified claim) -> 403`, async () => {
      for (const user of [U.nowallet, U.claimant]) {
        const r = await run(h.deps, user)
        assert.equal(r.status, 403, user)
        assert.equal((r.json?.error as { code: string }).code, "NO_VERIFIED_WALLET")
      }
    })
  }
  it("POST endpoints refuse a missing or foreign Origin before doing anything", async () => {
    for (const handler of [handleCreateInvoice, handleEvaluate, handleAdvance]) {
      for (const origin of [null, "https://evil.example"]) {
        const r = await http(handler, ctx(U.freelancer, h.deps), { body: {}, origin })
        assert.equal(r.status, 403)
        assert.equal((r.json?.error as { code: string }).code, "BAD_ORIGIN")
      }
    }
  })
  it("every error uses the documented { error: { code, message } } shape and is not cacheable", async () => {
    const r = await http(handleAdvance, ctx(null, h.deps), { body: { invoiceId: INV.adv } })
    assert.deepEqual(Object.keys(r.json ?? {}), ["error"])
    assert.deepEqual(Object.keys(r.json?.error as object).sort(), ["code", "message"])
    assert.equal(r.headers.get("cache-control"), "no-store")
  })
})

describe("invalid inputs", () => {
  const post = (handler: typeof handleCreateInvoice, body: unknown, raw?: string) => http(handler, ctx(U.freelancer, h.deps), { body, raw })
  const code = (r: { json: Record<string, unknown> | null }) => (r.json?.error as { code: string }).code

  it("rejects malformed JSON and non-objects", async () => {
    for (const handler of [handleCreateInvoice, handleEvaluate, handleAdvance]) {
      assert.equal(code(await post(handler, undefined, "{not json")), "INVALID_INPUT")
      assert.equal((await post(handler, undefined, "{not json")).status, 400)
      assert.equal((await post(handler, [1, 2])).status, 400)
      assert.equal((await post(handler, null)).status, 400)
    }
  })

  it("POST /api/invoices validates every field", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["non-numeric invoiceId", { invoiceId: "abc" }],
      ["negative invoiceId", { invoiceId: "-1" }],
      ["leading-zero invoiceId", { invoiceId: "007" }],
      ["huge invoiceId (79 digits)", { invoiceId: "9".repeat(79) }],
      ["short txHash", { txHash: "0x1234" }],
      ["non-hex txHash", { txHash: "0x" + "zz".repeat(32) }],
      ["no criteria", { criteria: [] }],
      ["duplicate criterion ids", { criteria: [{ id: "a", text: "x", mandatory: true }, { id: "a", text: "y", mandatory: false }] }],
      ["empty criterion text", { criteria: [{ id: "a", text: "", mandatory: true }] }],
      ["bad criterion id", { criteria: [{ id: "has space", text: "x", mandatory: true }] }],
      ["non-boolean mandatory", { criteria: [{ id: "a", text: "x", mandatory: "yes" }] }],
      ["unknown criterion field", { criteria: [{ id: "a", text: "x", mandatory: true, weight: 9 }] }],
      ["description too long", { description: "x".repeat(4001) }],
      ["bad due date", { dueDate: "tomorrow" }],
      ["browser-supplied amount", { amount: "1000" }],
      ["browser-supplied freelancer", { freelancer: W.stranger }],
      ["browser-supplied criteriaHash", { criteriaHash: H }],
    ]
    for (const [label, patch] of bad) {
      const r = await post(handleCreateInvoice, { ...invoiceBody(), ...patch })
      assert.equal(r.status, 400, label)
      assert.equal(code(r), "INVALID_INPUT", label)
    }
    assert.equal(h.chain.calls.creation, 0, "invalid input never reaches the chain")
  })

  it("POST /api/evaluate rejects anything but a submission id, including a browser-supplied score or verdict", async () => {
    for (const body of [{}, { submissionId: "nope" }, { submissionId: id(1), score: 100 }, { submissionId: id(1), passed: true }, { submissionId: id(1), criteriaResults: [] }, { submissionId: 5 }]) {
      const r = await post(handleEvaluate, body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal(code(r), "INVALID_INPUT")
    }
    assert.equal(h.evaluator.calls, 0)
  })

  it("POST /api/advances rejects bad ids, extra fields (amount) and bad idempotency keys", async () => {
    for (const body of [{}, { invoiceId: "x" }, { invoiceId: INV.adv, amount: "999999" }, { invoiceId: INV.adv, status: "paid" }]) {
      assert.equal((await post(handleAdvance, body)).status, 400, JSON.stringify(body))
    }
    const r = await http(handleAdvance, ctx(U.freelancer, h.deps), { body: { invoiceId: INV.adv }, headers: { "idempotency-key": "short" } })
    assert.equal(r.status, 400)
  })

  it("GET /api/invoices/:id with a malformed id is a plain 404", async () => {
    const r = await http(((req: Request, c: never) => handleGetInvoice(req, c, { id: "../../etc/passwd" })) as never, ctx(U.client, h.deps), { method: "GET" })
    assert.equal(r.status, 404)
  })
})

describe("POST /api/invoices: on-chain verification before anything is stored", () => {
  const register = (user: string | null = U.client, body: Record<string, unknown> = invoiceBody()) => http(handleCreateInvoice, ctx(user, h.deps), { body })
  const err = (r: { json: Record<string, unknown> | null }) => (r.json?.error as { code: string }).code

  it("MISSING CHAIN INTEGRATION: answers 503 INTEGRATION_UNAVAILABLE and stores nothing", async () => {
    const d = unavailableDeps(db, h.store)
    const r = await http(handleCreateInvoice, ctx(U.client, d), { body: invoiceBody() })
    assert.equal(r.status, 503)
    assert.equal(err(r), "INTEGRATION_UNAVAILABLE")
    assert.equal(await count("invoices", "create_tx_hash is not null"), 0)
  })

  it("an adapter that reports unavailable mid-request is also a clean 503", async () => {
    h.chain.creation = new ChainUnavailableError()
    const r = await register()
    assert.equal(r.status, 503)
    assert.equal(err(r), "INTEGRATION_UNAVAILABLE")
  })

  it("registers a verified invoice: terms come from the chain, criteria and canonical text are frozen", async () => {
    h.chain.creation = creation()
    h.chain.state = fundedState({ onchainStatus: "Created" })
    const r = await register()
    assert.equal(r.status, 201)
    assert.equal(r.json?.invoiceId, "77")
    assert.equal(r.json?.client, W.client)
    assert.equal(r.json?.freelancer, W.freelancer)
    assert.equal(r.json?.amount, "1000")
    assert.equal(r.json?.criteriaHash, computeCriteriaHash(CRITERIA))
    assert.equal(r.json?.submissionStatus, "NotSubmitted")
    assert.equal(r.json?.financialStatusVerified, true)
    const row = (await db.query<Record<string, unknown>>("select * from invoices where id = $1", [r.json?.id])).rows[0]
    assert.equal(row.criteria_hash, computeCriteriaHash(CRITERIA))
    assert.equal(row.criteria_canonical, canonicalCriteriaString(CRITERIA))
    assert.equal(row.criteria_count, 2)
    assert.equal(row.create_tx_hash, TX)
    assert.equal(row.registered_by, U.client)
    const crit = (await db.query<{ criterion_key: string; mandatory: boolean }>("select criterion_key, mandatory from invoice_criteria where invoice_uuid = $1 order by position", [r.json?.id])).rows
    assert.deepEqual(crit, [{ criterion_key: "c1", mandatory: true }, { criterion_key: "c2", mandatory: false }])
  })

  it("is idempotent: registering the same invoice again returns it (200) without duplicating anything", async () => {
    h.chain.creation = creation()
    h.chain.state = fundedState()
    const first = await register()
    const second = await register()
    assert.equal(first.status, 201)
    assert.equal(second.status, 200)
    assert.equal(second.json?.id, first.json?.id)
    assert.equal(await count("invoices", "create_tx_hash is not null"), 1)
    assert.equal(await count("invoice_criteria", `invoice_uuid = '${first.json?.id}'`), 2)
  })

  it("two simultaneous registrations produce one invoice", async () => {
    h.chain.creation = creation()
    h.chain.state = fundedState()
    const [a, b] = await Promise.all([register(), register()])
    assert.equal(a.json?.id, b.json?.id)
    assert.equal(await count("invoices", "create_tx_hash is not null"), 1)
  })

  it("rejects a tx that was not created by one of the caller's VERIFIED wallets", async () => {
    h.chain.creation = creation()
    h.chain.state = fundedState()
    const stranger = await register(U.stranger)
    assert.equal(stranger.status, 403)
    assert.equal(err(stranger), "NOT_INVOICE_CREATOR")
    h.chain.creation = creation({ creator: W.freelancer })
    assert.equal(err(await register(U.client)), "NOT_INVOICE_CREATOR", "creator is a different wallet than the caller's")
    assert.equal(await count("invoices", "create_tx_hash is not null"), 0)
  })

  it("rejects criteria that do not hash to the on-chain commitment", async () => {
    h.chain.creation = creation()
    h.chain.state = fundedState()
    const tampered = [{ ...CRITERIA[0], text: "Logo delivered (easier)" }, CRITERIA[1]]
    const r = await register(U.client, invoiceBody({ criteria: tampered }))
    assert.equal(r.status, 422)
    assert.equal(err(r), "CRITERIA_HASH_MISMATCH")
    const reordered = await register(U.client, invoiceBody({ criteria: [CRITERIA[1], CRITERIA[0]] }))
    assert.equal(err(reordered), "CRITERIA_HASH_MISMATCH", "order is part of the commitment")
    const flipped = await register(U.client, invoiceBody({ criteria: [{ ...CRITERIA[0], mandatory: false }, CRITERIA[1]] }))
    assert.equal(err(flipped), "CRITERIA_HASH_MISMATCH", "the mandatory flag is part of the commitment")
    assert.equal(await count("invoices", "create_tx_hash is not null"), 0)
  })

  it("rejects a transaction that is pending, reverted, unknown, or for a different invoice id", async () => {
    h.chain.state = fundedState()
    h.chain.creation = creation({ status: "pending" })
    assert.equal(err(await register()), "CHAIN_TX_PENDING")
    h.chain.creation = creation({ status: "reverted" })
    assert.equal(err(await register()), "CHAIN_TX_INVALID")
    h.chain.creation = creation({ status: "not_found" })
    assert.equal(err(await register()), "CHAIN_TX_INVALID")
    h.chain.creation = creation({ invoiceId: BigInt(78) })
    assert.equal(err(await register()), "CHAIN_TX_INVALID")
    h.chain.creation = creation({ amount: BigInt(0) })
    assert.equal(err(await register()), "CHAIN_TX_INVALID")
    assert.equal(await count("invoices", "create_tx_hash is not null"), 0)
  })

  it("an unexpected chain failure is a generic 502 that leaks nothing", async () => {
    h.chain.creation = new Error("rpc https://node.internal:8545 key=SECRET failed")
    const r = await register()
    assert.equal(r.status, 502)
    assert.equal(err(r), "CHAIN_ERROR")
    assert.ok(!JSON.stringify(r.json).includes("SECRET") && !JSON.stringify(r.json).includes("node.internal"))
  })

  it("keeps uint256 amounts exact end to end", async () => {
    h.chain.creation = creation({ amount: BigInt(BIG) })
    h.chain.state = fundedState({ amount: BigInt(BIG) })
    const r = await register()
    assert.equal(r.json?.amount, BIG)
    assert.equal((await db.query<{ a: string }>("select amount::text a from invoices where id = $1", [r.json?.id])).rows[0].a, BIG)
  })

  it("criteria hashing is deterministic, NFC-normalized and whitespace-trimmed", () => {
    const a = computeCriteriaHash([{ id: "x", text: "café", mandatory: true }])
    const b = computeCriteriaHash([{ id: "x", text: "  café  ", mandatory: true }])
    assert.equal(a, b)
    assert.match(a, /^0x[0-9a-f]{64}$/)
    assert.notEqual(a, computeCriteriaHash([{ id: "x", text: "café", mandatory: false }]))
  })
})

describe("GET /api/invoices/:id", () => {
  const get = (user: string | null, invoiceId = INV.adv, deps: BackendDeps = h.deps) =>
    http(((req: Request, c: never) => handleGetInvoice(req, c, { id: invoiceId })) as never, ctx(user, deps), { method: "GET" })

  it("returns criteria, submissions and evaluations to the client and the freelancer, but never storage paths", async () => {
    const sub = await seedSubmission()
    await seedEvaluation(sub.id, INV.adv)
    for (const user of [U.client, U.freelancer]) {
      const r = await get(user)
      assert.equal(r.status, 200, user)
      assert.equal((r.json?.criteria as unknown[]).length, 2)
      assert.equal((r.json?.submissions as unknown[]).length, 1)
      assert.equal((r.json?.evaluations as unknown[]).length, 1)
      assert.ok(!JSON.stringify(r.json).includes(sub.path), "storage path is not exposed")
      assert.equal((r.json?.invoice as { amount: string }).amount, "1000")
    }
  })

  it("CROSS-USER ACCESS: an unrelated wallet gets 404 (identical to a nonexistent invoice); an unverified claimant gets 403", async () => {
    const stranger = await get(U.stranger)
    const missing = await get(U.stranger, id(99999))
    assert.equal(stranger.status, 404)
    assert.deepEqual(stranger.json, missing.json, "no existence oracle")
    assert.equal((await get(U.freelancer2)).status, 404)
    assert.equal((await get(U.claimant)).status, 403)
    assert.equal((await get(U.stranger, INV.other)).status, 200, "but they can read their own invoice")
  })

  it("never presents the database cache as verified: without a chain adapter the status is labelled unverified", async () => {
    await db.query("update invoices set onchain_status = 'Settled' where id = $1", [INV.adv])
    try {
      const r = await get(U.client, INV.adv, unavailableDeps(db, h.store))
      assert.equal(r.status, 200)
      const inv = r.json?.invoice as { financialStatusVerified: boolean; onchainStatus: string }
      assert.equal(inv.financialStatusVerified, false)
      assert.deepEqual(r.json?.chain, { verified: false, reason: "INTEGRATION_UNAVAILABLE", cachedOnchainStatus: "Settled", cachedStatusIsProof: false })
    } finally {
      await db.query("update invoices set onchain_status = 'Funded' where id = $1", [INV.adv])
    }
  })

  it("uses the chain's answer when it is available: a stale 'Funded' cache cannot hide a settlement, and vice versa", async () => {
    h.chain.state = fundedState({ onchainStatus: "Settled", advanceAmount: BigInt(900) })
    const r = await get(U.client)
    assert.equal((r.json?.invoice as { onchainStatus: string }).onchainStatus, "Settled")
    assert.equal((r.json?.invoice as { financialStatusVerified: boolean }).financialStatusVerified, true)
    assert.equal((r.json?.invoice as { advanceAmount: string }).advanceAmount, "900")
    assert.equal((r.json?.chain as { verified: boolean }).verified, true)
  })

  it("a chain read failure degrades to 'unverified' instead of failing or guessing", async () => {
    h.chain.state = new Error("rpc timeout")
    const r = await get(U.client)
    assert.equal(r.status, 200)
    assert.equal((r.json?.chain as { verified: boolean; reason: string }).verified, false)
    assert.equal((r.json?.chain as { reason: string }).reason, "CHAIN_ERROR")
  })

  it("derives submissionStatus from the latest submission and its evaluation", async () => {
    assert.equal(((await get(U.client)).json?.invoice as { submissionStatus: string }).submissionStatus, "NotSubmitted")
    const s1 = await seedSubmission()
    assert.equal(((await get(U.client)).json?.invoice as { submissionStatus: string }).submissionStatus, "Submitted")
    await seedEvaluation(s1.id, INV.adv)
    assert.equal(((await get(U.client)).json?.invoice as { submissionStatus: string }).submissionStatus, "Evaluated")
    await seedSubmission()
    assert.equal(((await get(U.client)).json?.invoice as { submissionStatus: string }).submissionStatus, "Submitted", "an older evaluation does not cover newer evidence")
  })
})

describe("POST /api/evaluate", () => {
  const evaluate = (user: string | null, submissionId: string) => http(handleEvaluate, ctx(user, h.deps), { body: { submissionId } })
  const err = (r: { json: Record<string, unknown> | null }) => (r.json?.error as { code: string }).code

  it("stores a structured, audited evaluation from the frozen criteria and the stored evidence", async () => {
    const sub = await seedSubmission()
    const r = await evaluate(U.freelancer, sub.id)
    assert.equal(r.status, 201)
    assert.equal(r.json?.score, 95)
    assert.equal(r.json?.passed, true)
    assert.equal(r.json?.simulated, false)
    assert.equal(r.json?.model, "scripted-model")
    assert.equal(r.json?.promptVersion, "scripted-v1")
    assert.equal(r.json?.criteriaHash, H)
    assert.deepEqual((r.json?.criteriaResults as { criterion: string }[]).map((c) => c.criterion), ["Logo delivered", "Source files included"])
    assert.deepEqual(h.evaluator.lastInput?.criteria.map((c) => c.text), ["Logo delivered", "Source files included"], "the evaluator was handed the FROZEN criteria in order")
    assert.deepEqual(h.evaluator.lastInput?.evidence, bytes.pdf, "and the stored evidence")
    const row = (await db.query<Record<string, unknown>>("select * from evaluations where submission_id = $1", [sub.id])).rows[0]
    assert.equal(row.invoice_uuid, INV.adv)
    assert.equal(row.criteria_hash, H)
    assert.equal(row.state, "completed")
    assert.equal(row.model, "scripted-model")
    assert.equal(row.prompt_version, "scripted-v1")
    assert.ok(row.pass_rule && row.evaluated_at)
    assert.deepEqual((row.criteria_results as { mandatory: boolean }[]).map((c) => c.mandatory), [true, false])
  })

  it("the server decides pass/fail by policy, not the evaluator: a mandatory miss fails even with a high score", async () => {
    h.evaluator.output = (i) => ({
      model: "m", promptVersion: "p", simulated: false, score: 99, summary: "s",
      criteriaResults: i.criteria.map((c, n) => ({ criterion: c.text, passed: n !== 0, reason: "r" })), // mandatory c1 fails
    })
    const sub = await seedSubmission()
    const r = await evaluate(U.freelancer, sub.id)
    assert.equal(r.json?.passed, false)
    assert.equal(decidePassed(PASS_SCORE_THRESHOLD, [{ passed: true, mandatory: true }]), true)
    assert.equal(decidePassed(PASS_SCORE_THRESHOLD - 1, [{ passed: true, mandatory: true }]), false)
    assert.equal(decidePassed(100, [{ passed: false, mandatory: true }, { passed: true, mandatory: false }]), false)
    assert.equal(decidePassed(100, [{ passed: false, mandatory: false }]), true, "an optional miss does not fail")
  })

  it("AUTHORIZATION: only the submitting freelancer; strangers get 404, the client 403, claimants and wallet-less users 403", async () => {
    const sub = await seedSubmission()
    assert.equal((await evaluate(U.stranger, sub.id)).status, 404)
    assert.equal((await evaluate(U.freelancer2, sub.id)).status, 404)
    const client = await evaluate(U.client, sub.id)
    assert.equal(client.status, 403)
    assert.equal(err(client), "FORBIDDEN")
    assert.equal((await evaluate(U.claimant, sub.id)).status, 403)
    assert.equal((await evaluate(U.nowallet, sub.id)).status, 403)
    assert.equal((await evaluate(U.freelancer, id(31337))).status, 404)
    assert.equal(h.evaluator.calls, 0)
    assert.equal(await count("evaluations"), 0)
  })

  it("INVALID EVIDENCE REFERENCE: a submission whose stored object is gone is refused and nothing is recorded", async () => {
    const sub = await seedSubmission()
    h.store.objects.delete(sub.path)
    const r = await evaluate(U.freelancer, sub.id)
    assert.equal(r.status, 409)
    assert.equal(err(r), "UPLOAD_NOT_FOUND")
    assert.equal(await count("evaluations"), 0)
    assert.equal(h.evaluator.calls, 0)
  })

  it("STALE: only the latest submission can be evaluated", async () => {
    const old = await seedSubmission()
    await seedSubmission()
    const r = await evaluate(U.freelancer, old.id)
    assert.equal(r.status, 409)
    assert.equal(err(r), "STALE_SUBMISSION")
    assert.equal(await count("evaluations"), 0)
  })

  it("DUPLICATES: re-requesting returns the stored result without running the evaluator again", async () => {
    const sub = await seedSubmission()
    const first = await evaluate(U.freelancer, sub.id)
    const second = await evaluate(U.freelancer, sub.id)
    assert.equal(first.status, 201)
    assert.equal(second.status, 200)
    assert.equal(second.json?.duplicate, true)
    assert.equal(second.json?.evaluationId, first.json?.evaluationId)
    assert.equal(h.evaluator.calls, 1)
    assert.equal(await count("evaluations"), 1)
  })

  it("two simultaneous requests produce one evaluation", async () => {
    const sub = await seedSubmission()
    const results = await Promise.all([evaluate(U.freelancer, sub.id), evaluate(U.freelancer, sub.id)])
    assert.equal(await count("evaluations", "state = 'completed'"), 1)
    assert.ok(results.some((r) => r.status === 201))
    assert.ok(results.every((r) => [200, 201, 409].includes(r.status)))
  })

  it("with no evaluator configured the endpoint is 503 and records nothing", async () => {
    h.deps.evaluator = disabledEvaluator
    const sub = await seedSubmission()
    const r = await evaluate(U.freelancer, sub.id)
    assert.equal(r.status, 503)
    assert.equal(err(r), "EVALUATOR_UNAVAILABLE")
    assert.equal(await count("evaluations"), 0)
  })

  it("an evaluator failure is recorded as an error, not echoed, and can be retried", async () => {
    const sub = await seedSubmission()
    h.evaluator.output = () => {
      throw new Error("model said: the evidence contains SECRET-CONTENT")
    }
    const failed = await evaluate(U.freelancer, sub.id)
    assert.equal(failed.status, 502)
    assert.equal(err(failed), "EVALUATOR_FAILED")
    assert.ok(!JSON.stringify(failed.json).includes("SECRET-CONTENT"))
    assert.equal(await count("evaluations", "state = 'error'"), 1)
    h.evaluator.output = ScriptedEvaluator.prototype.output as never
    h.evaluator = new ScriptedEvaluator()
    h.deps.evaluator = h.evaluator
    const retry = await evaluate(U.freelancer, sub.id)
    assert.equal(retry.status, 201, "an errored run does not block a retry")
    assert.equal(await count("evaluations", "state = 'completed'"), 1)
  })

  it("rejects evaluator output that does not match the frozen criteria or has an invalid score", async () => {
    const outputs: Array<[string, (i: Parameters<ScriptedEvaluator["output"]>[0]) => ReturnType<ScriptedEvaluator["output"]>]> = [
      ["wrong count", (i) => ({ model: "m", promptVersion: "p", simulated: false, score: 90, summary: "s", criteriaResults: i.criteria.slice(0, 1).map((c) => ({ criterion: c.text, passed: true, reason: "r" })) })],
      ["rewritten criterion text", (i) => ({ model: "m", promptVersion: "p", simulated: false, score: 90, summary: "s", criteriaResults: i.criteria.map(() => ({ criterion: "something else", passed: true, reason: "r" })) })],
      ["score above 100", (i) => ({ model: "m", promptVersion: "p", simulated: false, score: 101, summary: "s", criteriaResults: i.criteria.map((c) => ({ criterion: c.text, passed: true, reason: "r" })) })],
      ["fractional score", (i) => ({ model: "m", promptVersion: "p", simulated: false, score: 90.5, summary: "s", criteriaResults: i.criteria.map((c) => ({ criterion: c.text, passed: true, reason: "r" })) })],
    ]
    for (const [label, out] of outputs) {
      const sub = await seedSubmission()
      h.evaluator.output = out
      const r = await evaluate(U.freelancer, sub.id)
      assert.equal(r.status, 502, label)
      assert.equal(err(r), "EVALUATOR_FAILED", label)
    }
    assert.equal(await count("evaluations", "state = 'completed'"), 0)
  })

  it("a demo-mode evaluator that claims a non-simulated result is refused", async () => {
    h.evaluator.mode = "demo"
    const sub = await seedSubmission()
    const r = await evaluate(U.freelancer, sub.id) // scripted output says simulated:false
    assert.equal(r.status, 502)
  })
})

describe("POST /api/advances", () => {
  const advance = (user: string | null, invoiceId = INV.adv, headers: Record<string, string> = {}) => http(handleAdvance, ctx(user, h.deps), { body: { invoiceId }, headers })
  const err = (r: { json: Record<string, unknown> | null }) => (r.json?.error as { code: string }).code
  /** An eligible invoice: latest submission with a passing real evaluation, funded on-chain, reserve available. */
  async function eligible(invoiceId = INV.adv) {
    const sub = await seedSubmission(invoiceId)
    const ev = await seedEvaluation(sub.id, invoiceId)
    h.chain.state = fundedState({ amount: BigInt((await db.query<{ a: string }>("select amount::text a from invoices where id = $1", [invoiceId])).rows[0].a) })
    h.chain.reserve = BigInt(BIG) * BigInt(10)
    return { sub, ev }
  }

  it("MISSING CHAIN/SIGNER INTEGRATION: 503 INTEGRATION_UNAVAILABLE, no request recorded, nothing pretends to be paid", async () => {
    const sub = await seedSubmission()
    await seedEvaluation(sub.id, INV.adv)
    const d = unavailableDeps(db, h.store)
    const r = await http(handleAdvance, ctx(U.freelancer, d), { body: { invoiceId: INV.adv } })
    assert.equal(r.status, 503)
    assert.equal(err(r), "INTEGRATION_UNAVAILABLE")
    assert.equal(await count("advance_requests"), 0)
    assert.equal(await count("transactions"), 0)
    // chain present but signer missing: still refused
    h.chain.state = fundedState()
    h.chain.reserve = BigInt(10_000)
    h.signer.available = false
    assert.equal((await advance(U.freelancer)).status, 503)
    assert.equal(await count("advance_requests"), 0)
  })

  it("happy path: records a PENDING request for exactly floor(90%), broadcasts once, and never says 'paid'", async () => {
    const { sub, ev } = await eligible()
    const r = await advance(U.freelancer)
    assert.equal(r.status, 202)
    assert.equal(r.json?.status, "pending")
    assert.equal(r.json?.amount, "900")
    assert.equal(r.json?.txHash, h.signer.hash)
    assert.equal(r.json?.duplicate, false)
    assert.equal(h.signer.calls, 1)
    const row = (await db.query<Record<string, unknown>>("select * from advance_requests")).rows[0]
    assert.equal(row.status, "pending")
    assert.equal(row.submission_id, sub.id)
    assert.equal(row.evaluation_id, ev)
    assert.equal(row.requester_user_id, U.freelancer)
    const tx = (await db.query<Record<string, unknown>>("select * from transactions where id = $1", [row.transaction_id])).rows[0]
    assert.equal(tx.status, "pending", "an unconfirmed transaction is never recorded as confirmed")
    assert.equal(tx.action, "approveAdvance")
    assert.equal(tx.tx_hash, h.signer.hash)
    assert.equal(tx.confirmed_at, null)
    assert.equal(await count("advance_requests", "status = 'paid'"), 0)
  })

  it("computes the advance with bigint: exact for huge amounts and floors odd ones", async () => {
    assert.equal(advanceAmountFor(BigInt(999)), BigInt(899))
    assert.equal(advanceAmountFor(BigInt(BIG)), BigInt("900000000000000000000"))
    await eligible(INV.big)
    const big = await advance(U.freelancer, INV.big)
    assert.equal(big.json?.amount, "900000000000000000000")
    await eligible(INV.odd)
    const odd = await advance(U.freelancer, INV.odd)
    assert.equal(odd.json?.amount, "899", JSON.stringify(odd))
  })

  it("AUTHORIZATION: only the freelancer; the client gets 403, strangers 404, unverified/wallet-less 403", async () => {
    await eligible()
    const client = await advance(U.client)
    assert.equal(client.status, 403)
    assert.equal(err(client), "FORBIDDEN")
    assert.equal((await advance(U.stranger)).status, 404)
    assert.equal((await advance(U.freelancer2)).status, 404)
    assert.equal((await advance(U.claimant)).status, 403)
    assert.equal((await advance(U.nowallet)).status, 403)
    assert.equal(h.signer.calls, 0)
    assert.equal(await count("advance_requests"), 0)
  })

  it("DUPLICATES: repeating the request returns the same pending request and broadcasts only once", async () => {
    await eligible()
    const first = await advance(U.freelancer)
    const second = await advance(U.freelancer)
    assert.equal(second.status, 200)
    assert.equal(second.json?.duplicate, true)
    assert.equal(second.json?.requestId, first.json?.requestId)
    assert.equal(h.signer.calls, 1)
    assert.equal(await count("advance_requests"), 1)
  })

  it("DUPLICATES under concurrency: simultaneous requests create one request and one broadcast", async () => {
    await eligible()
    const results = await Promise.all([advance(U.freelancer), advance(U.freelancer), advance(U.freelancer)])
    assert.equal(await count("advance_requests"), 1)
    assert.equal(h.signer.calls, 1)
    assert.equal(new Set(results.map((r) => r.json?.requestId)).size, 1)
  })

  it("an Idempotency-Key returns the same request, and cannot be reused for another invoice", async () => {
    await eligible()
    const key = { "idempotency-key": "click-0001-abcdef" }
    const a = await advance(U.freelancer, INV.adv, key)
    const b = await advance(U.freelancer, INV.adv, key)
    assert.equal(b.json?.requestId, a.json?.requestId)
    assert.equal(b.json?.duplicate, true)
    await eligible(INV.big)
    const c = await advance(U.freelancer, INV.big, key)
    assert.equal(c.status, 400)
  })

  it("STALE EVALUATION: a passing result on an older submission cannot authorize newer evidence", async () => {
    const { sub } = await eligible()
    assert.ok(sub.id)
    await seedSubmission() // newer, unevaluated submission
    const r = await advance(U.freelancer)
    assert.equal(r.status, 409)
    assert.equal(err(r), "STALE_EVALUATION")
    assert.equal(h.signer.calls, 0)
    assert.equal(await count("advance_requests"), 0)
  })

  it("requires a submission, an evaluation of it, and a PASSING one", async () => {
    h.chain.state = fundedState()
    h.chain.reserve = BigInt(10_000)
    assert.equal(err(await advance(U.freelancer)), "NO_SUBMISSION")
    const sub = await seedSubmission()
    assert.equal(err(await advance(U.freelancer)), "NOT_EVALUATED")
    await seedEvaluation(sub.id, INV.adv, { passed: false })
    assert.equal(err(await advance(U.freelancer)), "EVALUATION_FAILED")
    assert.equal(h.signer.calls, 0)
  })

  it("verifies LIVE on-chain state: not funded, already advanced, disputed, settled are all refused; the cache is ignored", async () => {
    await eligible()
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ onchainStatus: "Created" }, "NOT_FUNDED"],
      [{ onchainStatus: "Advanced", advanceAmount: BigInt(900) }, "ALREADY_ADVANCED"],
      [{ onchainStatus: "Funded", advanceAmount: BigInt(900) }, "ALREADY_ADVANCED"],
      [{ onchainStatus: "Disputed" }, "INVOICE_DISPUTED"],
      [{ onchainStatus: "Settled" }, "INVOICE_SETTLED"],
    ]
    for (const [state, code] of cases) {
      h.chain.state = fundedState(state)
      assert.equal(err(await advance(U.freelancer)), code, code)
    }
    // the database cache says Funded throughout; a Settled chain still wins
    assert.equal(h.signer.calls, 0)
    assert.equal(await count("advance_requests"), 0)
  })

  it("checks reserve availability before recording or paying anything", async () => {
    await eligible()
    h.chain.reserve = BigInt(899)
    const r = await advance(U.freelancer)
    assert.equal(r.status, 409)
    assert.equal(err(r), "INSUFFICIENT_RESERVE")
    assert.equal(h.signer.calls, 0)
    assert.equal(await count("advance_requests"), 0)
    h.chain.reserve = BigInt(900)
    assert.equal((await advance(U.freelancer)).status, 202, "exactly enough is enough")
  })

  it("refuses when the on-chain amount disagrees with our records", async () => {
    await eligible()
    h.chain.state = fundedState({ amount: BigInt(2000) })
    assert.equal(err(await advance(U.freelancer)), "INTEGRITY_MISMATCH")
    assert.equal(h.signer.calls, 0)
  })

  it("a signer failure releases the slot so the freelancer can retry, and reports nothing paid", async () => {
    await eligible()
    h.signer.fail = true
    const failed = await advance(U.freelancer)
    assert.equal(failed.status, 502)
    assert.equal(err(failed), "SIGNER_FAILED")
    assert.ok(!JSON.stringify(failed.json).includes("nonce"), "signer internals are not echoed")
    assert.equal(await count("advance_requests", "status = 'failed'"), 1)
    assert.equal(await count("advance_requests", "status in ('pending','paid')"), 0)
    h.signer.fail = false
    const retry = await advance(U.freelancer)
    assert.equal(retry.status, 202)
    assert.equal(await count("advance_requests", "status = 'pending'"), 1)
  })

  it("a chain read failure is a generic 502, and an unreachable reserve read is not treated as 'enough'", async () => {
    await eligible()
    h.chain.reserve = new Error("rpc down")
    const r = await advance(U.freelancer)
    assert.equal(r.status, 502)
    assert.equal(err(r), "CHAIN_ERROR")
    assert.equal(await count("advance_requests"), 0)
  })
})

describe("database error handling", () => {
  const brokenDb = (): BackendDeps => ({
    ...h.deps,
    db: new Proxy(h.deps.db, {
      get: () => async () => {
        throw new Error('connection to server at "10.0.0.5" failed: password authentication failed for user "postgres" SECRET-DB-DETAIL')
      },
    }),
  })

  it("an unexpected database failure is a generic 500 that leaks no details, on every endpoint", async () => {
    const d = brokenDb()
    const results = [
      await http(handleCreateInvoice, ctx(U.client, d), { body: invoiceBody() }),
      await http(handleEvaluate, ctx(U.freelancer, d), { body: { submissionId: id(1) } }),
      await http(handleAdvance, ctx(U.freelancer, d), { body: { invoiceId: INV.adv } }),
      await http(((req: Request, c: never) => handleGetInvoice(req, c, { id: INV.adv })) as never, ctx(U.client, d), { method: "GET" }),
    ]
    for (const r of results) {
      assert.equal(r.status, 500)
      assert.equal((r.json?.error as { code: string }).code, "INTERNAL")
      const text = JSON.stringify(r.json)
      assert.ok(!text.includes("SECRET-DB-DETAIL") && !text.includes("10.0.0.5") && !text.includes("postgres"), text)
    }
  })

  it("the database independently rejects inconsistent evaluation and advance rows (defence in depth)", async () => {
    const sub = await seedSubmission()
    const ev = await seedEvaluation(sub.id, INV.adv)
    const insert = (sql: string, params: unknown[]) =>
      as(db, "service_role", null, async () => {
        try {
          await db.query(sql, params)
          return null
        } catch (e) {
          return (e as Error).message
        }
      })
    const other = await seedSubmission(INV.big)
    assert.match((await insert("insert into evaluations (submission_id, invoice_uuid, criteria_hash, criteria_version, model, prompt_version, pass_rule) values ($1,$2,$3,1,'m','v','r')", [other.id, INV.adv, H])) ?? "NO ERROR", /foreign key/, "evaluation filed under another invoice")
    assert.match((await insert("insert into advance_requests (invoice_uuid, requester_user_id, requester_address, submission_id, evaluation_id, amount, idempotency_key) values ($1,$2,$3,$4,$5,901,'key-00000001')", [INV.adv, U.freelancer, W.freelancer, sub.id, ev])) ?? "NO ERROR", /90/, "amount other than floor(90%)")
    assert.match((await insert("insert into advance_requests (invoice_uuid, requester_user_id, requester_address, submission_id, evaluation_id, amount, idempotency_key) values ($1,$2,$3,$4,$5,900000000000000000000,'key-00000002')", [INV.big, U.freelancer, W.freelancer, sub.id, ev])) ?? "NO ERROR", /foreign key/, "request on another invoice")
  })

  it("a duplicate-key rejection from the database is translated, not surfaced raw", async () => {
    const { mapAdvanceInsertError, mapEvaluationInsertError } = await import("@/lib/backend/db-errors")
    assert.ok(mapAdvanceInsertError("23505", 'duplicate key value violates unique constraint "advance_requests_one_live_uq"') instanceof Error)
    assert.ok(mapEvaluationInsertError(undefined, 'duplicate key value violates unique constraint "evaluations_one_live_per_submission_uq"') instanceof Error)
    assert.equal(mapAdvanceInsertError(undefined, "some other failure"), null)
  })
})

describe("security-sensitive wiring", () => {
  it("the Supabase admin client and signer are only imported by server-only modules", () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name)) {
          const src = fs.readFileSync(p, "utf8")
          if (src.includes('"use client"') && /backend\/server|supabase\/admin|evidence\/server|SERVICE_ROLE/.test(src)) offenders.push(p)
        }
      }
    }
    for (const r of ["app", "components", "hooks", "lib"]) walk(r)
    assert.deepEqual(offenders, [])
    assert.match(fs.readFileSync("lib/backend/server.ts", "utf8"), /^import "server-only"/)
  })

  it("the real-mode adapters come from the chain SDK and configuration (no invented ABI, address or signer)", async () => {
    // Phase 3 replaced the 'unavailable' stubs: the chain reader is the SDK-backed adapter and the signer is built from
    // EVALUATOR_PRIVATE_KEY (an absent/wrong key yields the explicit unavailable signer, never a mock).
    const src = fs.readFileSync("lib/backend/server.ts", "utf8")
    assert.match(src, /getChainAdapter\(.*\): ChainAdapter \{\s*return createChainAdapter\(/)
    assert.match(src, /getAdvanceSigner\(.*\): AdvanceSigner \{\s*return createEvaluatorSignerFromEnv\(/)
    assert.ok(!/0x[0-9a-fA-F]{40}/.test(src), "no hard-coded address")
    assert.doesNotMatch(src, /from "@\/lib\/mocks|MockDuelyRepository/)
    assert.equal(disabledEvaluator.mode, "disabled")
  })
})
