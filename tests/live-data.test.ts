import { after, before, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import type { PGlite } from "@electric-sql/pglite"
import { createDb } from "./helpers/db"
import { bytes, Clock, createPgEvidenceDb, FakeObjectStore } from "./helpers/evidence"
import { ctx, createPgBackendDb, FakeChainAdapter, FakeSigner, ScriptedEvaluator, TEST_SCOPE, unavailableDeps } from "./helpers/backend"
import { handleAdvance, handleEvaluate, handleGetInvoice, handleListInvoices, handleOperatorInvoices } from "@/lib/backend/handlers"
import { EvidenceError, initUpload, registerSubmission } from "@/lib/evidence/service"
import { EvidenceUploadError } from "@/lib/evidence/upload-client"
import { ApiDuelyRepository, type ApiRepositoryDeps } from "@/lib/frontend/api-repository"
import { TxLog } from "@/lib/frontend/tx-log"
import { connectWallet, readWalletState, requireWallet, switchToExpectedChain } from "@/lib/frontend/wallet-chain"
import type { DuelyRepository } from "@/lib/frontend/repository"
import { figuresFor, buildTimeline, type ApiInvoiceDetail } from "@/lib/frontend/api-mappers"
import { DomainError } from "@/lib/frontend/errors"
import { MockDuelyRepository } from "@/lib/mocks/mock-repository"
import { demoEvaluator } from "@/lib/backend/demo-evaluator"
import type { BackendDeps } from "@/lib/backend/ports"
import type { Address } from "@/lib/frontend/domain"

let db: PGlite
let store: FakeObjectStore
let deps: BackendDeps
let evaluator: ScriptedEvaluator
let chain: FakeChainAdapter

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const U = { freelancer: id(1), client: id(2), stranger: id(3), claimant: id(4), nowallet: id(5), both: id(7) }
const W = {
  freelancer: "0x" + "b".repeat(40),
  client: "0x" + "a".repeat(40),
  stranger: "0x" + "c".repeat(40),
  both: "0x" + "9".repeat(40),
  contract: "0x" + "e".repeat(40),
  token: "0x" + "d".repeat(40),
}
const H = "0x" + "1".repeat(64)
const INV = { main: id(301), other: id(302), fixture: id(303), dupA: id(304), dupB: id(305) }

async function seedInvoice(invId: string, onchainId: number, client: string, freelancer: string, o: { chainId?: number; contract?: string; title?: string } = {}) {
  await db.query(
    `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
     values ($1,$2,$3,$4,$5::numeric,$6,$7,1000,$8,2,'canon',$9,$10,'Funded')`,
    [invId, o.chainId ?? 1440002, o.contract ?? W.contract, W.token, onchainId, client, freelancer, H, o.title ?? "Brand identity", U.client]
  )
  await db.query("insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ($1,0,'c1','Logo delivered',true), ($1,1,'c2','Source files included',false)", [invId])
}

before(async () => {
  db = await createDb()
  for (const [k, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, `${k}@t.invalid`])
  for (const [user, addr] of [[U.freelancer, W.freelancer], [U.client, W.client], [U.stranger, W.stranger], [U.both, W.both]] as const) {
    await db.query("insert into user_wallets (user_id, address, verified_at, verification_method) values ($1,$2,now(),'eip191')", [user, addr])
  }
  await db.query("insert into user_wallets (user_id, address) values ($1,$2)", [U.claimant, W.freelancer]) // unverified claim only
  await seedInvoice(INV.main, 1, W.client, W.freelancer)
  await seedInvoice(INV.other, 2, W.stranger, "0x" + "f".repeat(40), { title: "Someone else's invoice" })
  await seedInvoice(INV.fixture, 3, "0x" + "0".repeat(36) + "c0de", W.freelancer, { chainId: 0, contract: "0x" + "0".repeat(40), title: "Dev fixture" })
})
after(async () => db.close())

beforeEach(async () => {
  for (const t of ["advance_requests", "transactions", "evaluations", "submissions"]) {
    await db.query(`alter table ${t} disable trigger user`)
    await db.query(`delete from ${t}`)
    await db.query(`alter table ${t} enable trigger user`)
  }
  store = new FakeObjectStore(new Clock())
  evaluator = new ScriptedEvaluator()
  chain = new FakeChainAdapter() // available, but every read throws "unavailable" until a test scripts it
  chain.available = false
  deps = { scope: TEST_SCOPE, db: createPgBackendDb(db), objects: store, chain, signer: new FakeSigner(), evaluator }
})

/** What the browser's fetch would do against the real routes: same handlers, same schema, session = `user`. */
function shim(getUser: () => string | null): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input), "http://localhost:3000")
    const method = (init?.method ?? "GET").toUpperCase()
    const headers = new Headers(init?.headers as HeadersInit)
    if (method !== "GET") headers.set("origin", "http://localhost:3000")
    const req = new Request(url, { method, headers, body: (init?.body as string | undefined) ?? undefined })
    const c = ctx(getUser(), deps)
    const user = getUser()
    if (url.pathname === "/api/auth/session") {
      const wallets = user ? await deps.db.verifiedAddresses(user) : []
      return Response.json({ authenticated: !!user, userId: user, wallets })
    }
    if (url.pathname === "/api/invoices" && method === "GET") return handleListInvoices(req, c)
    const m = url.pathname.match(/^\/api\/invoices\/([^/]+)$/)
    if (m) return handleGetInvoice(req, c, { id: decodeURIComponent(m[1]) })
    if (url.pathname === "/api/evaluate") return handleEvaluate(req, c)
    if (url.pathname === "/api/advances") return handleAdvance(req, c)
    if (url.pathname === "/api/operator/invoices") return handleOperatorInvoices(req, c)
    return Response.json({ error: { code: "NOT_FOUND", message: "no route" } }, { status: 404 })
  }
}

/** The browser's upload helper, minus the Supabase Storage network hop: same authorize -> upload -> register sequence. */
function uploader(getUser: () => string | null): NonNullable<ApiRepositoryDeps["uploadEvidence"]> {
  return (async ({ invoiceId, file, note }: { invoiceId: string; file: File; note?: string }) => {
    const evDeps = { scope: TEST_SCOPE, db: createPgEvidenceDb(db), objects: store, chain: { verify: async () => ({ status: "unavailable" as const }) }, requireChainVerification: false }
    try {
      const grant = await initUpload(evDeps, { userId: getUser(), invoiceId, fileName: file.name, fileSize: file.size, mimeType: file.type })
      store.upload(grant.uploadToken, new Uint8Array(await file.arrayBuffer()), file.type)
      const { submission, duplicate } = await registerSubmission(evDeps, { userId: getUser(), invoiceId, storagePath: grant.path, fileName: file.name, note })
      return {
      submissionId: submission.id, invoiceId: submission.invoice_uuid, fileName: submission.file_name, fileSize: submission.file_size,
      mimeType: submission.mime_type, createdAt: submission.created_at, fundingVerifiedOnchain: submission.funding_verified_onchain, duplicate, storagePath: grant.path,
      }
    } catch (e) {
      // the real browser helper turns the server's JSON error into this
      if (e instanceof EvidenceError) throw new EvidenceUploadError(e.code, e.message)
      throw e
    }
  }) as never
}

function repoFor(user: string | null, extra: { fresh?: boolean } = {}) {
  void extra
  return new ApiDuelyRepository({ fetch: shim(() => user), uploadEvidence: uploader(() => user), storage: null, signIn: async () => undefined, signOut: async () => undefined })
}

const pdf = () => new File([bytes.pdf], "proof.pdf", { type: "application/pdf" })

// =====================================================================================================================

describe("backend: GET /api/invoices (list) and on-chain id lookup", () => {
  const call = async (user: string | null, handler: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>) =>
    (await handler(new Request("http://localhost:3000/api/invoices"), ctx(user, deps))).json() as Promise<Record<string, unknown>>

  it("returns only the caller's invoices, with amounts as strings and the fixture flagged", async () => {
    const freelancer = (await call(U.freelancer, handleListInvoices)) as { invoices: Array<{ id: string; amount: string; isTestFixture: boolean; chainId: number; financialStatusVerified: boolean }> }
    assert.deepEqual(freelancer.invoices.map((i) => i.id).sort(), [INV.main, INV.fixture].sort())
    assert.ok(freelancer.invoices.every((i) => typeof i.amount === "string" && i.financialStatusVerified === false))
    assert.equal(freelancer.invoices.find((i) => i.id === INV.fixture)?.isTestFixture, true)
    assert.equal(freelancer.invoices.find((i) => i.id === INV.main)?.isTestFixture, false)
    const stranger = (await call(U.stranger, handleListInvoices)) as { invoices: Array<{ id: string }> }
    assert.deepEqual(stranger.invoices.map((i) => i.id), [INV.other])
  })

  it("refuses signed-out callers, wallet-less users and unverified claimants", async () => {
    for (const [user, status] of [[null, 401], [U.nowallet, 403], [U.claimant, 403]] as const) {
      const res = await handleListInvoices(new Request("http://localhost:3000/api/invoices"), ctx(user, deps))
      assert.equal(res.status, status, String(user))
    }
  })

  it("resolves an on-chain id ONLY among the caller's own invoices: others get 404, indistinguishable from a missing one", async () => {
    const get = async (user: string, ref: string) => handleGetInvoice(new Request("http://localhost:3000/x"), ctx(user, deps), { id: ref })
    assert.equal((await get(U.client, "1")).status, 200)
    assert.equal((await get(U.freelancer, "1")).status, 200)
    const probe = await get(U.stranger, "1") // invoice 1 exists but belongs to others
    const missing = await get(U.stranger, "999999")
    assert.equal(probe.status, 404)
    assert.deepEqual(await probe.json(), await missing.json(), "no oracle for other people's invoice ids")
    assert.equal((await get(U.stranger, "2")).status, 200, "their own id resolves")
  })

  it("an on-chain id shared with another deployment's invoice resolves to the ACTIVE deployment's invoice, never ambiguously", async () => {
    // Same on-chain id (50) on two contracts, both belonging to the same wallets: only the active deployment's is visible.
    await seedInvoice(INV.dupA, 50, W.both, W.client, { contract: W.contract })
    await seedInvoice(INV.dupB, 50, W.both, W.client, { contract: "0x" + "2".repeat(40) })
    const res = await handleGetInvoice(new Request("http://localhost:3000/x"), ctx(U.both, deps), { id: "50" })
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { invoice: { id: string } }).invoice.id, INV.dupA)
    const other = await handleGetInvoice(new Request("http://localhost:3000/x"), ctx(U.both, deps), { id: INV.dupB })
    assert.equal(other.status, 409, "the other deployment's invoice is refused even by UUID")
    assert.equal(((await other.json()) as { error: { code: string } }).error.code, "WRONG_DEPLOYMENT")
    // clean up so later tests see only the base fixtures
    await db.query("alter table invoice_criteria disable trigger user")
    await db.query("alter table invoices disable trigger user")
    await db.query("delete from invoice_criteria where invoice_uuid in ($1, $2)", [INV.dupA, INV.dupB])
    await db.query("delete from invoices where id in ($1, $2)", [INV.dupA, INV.dupB])
    await db.query("alter table invoice_criteria enable trigger user")
    await db.query("alter table invoices enable trigger user")
  })
})

describe("dev fixture script", () => {
  it("its register_invoice parameters are accepted and produce a row the app flags as a non-blockchain fixture", async () => {
    const { computeCriteriaHash, canonicalCriteriaString } = await import("@/lib/backend/criteria")
    const { tokens } = await import("@/lib/frontend/token")
    const criteria = [{ id: "c1", text: "A final deliverable file is attached", mandatory: true }, { id: "c2", text: "A short note explains what was done", mandatory: false }]
    const ZERO = "0x" + "0".repeat(40)
    const r = await db.query<{ o_id: string; o_created: boolean }>(
      "select * from public.register_invoice($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::date,$14,$15,$16,$17)",
      [0, ZERO, ZERO, "1730000000000", W.freelancer, "0x" + "0".repeat(36) + "c0de", tokens(1000), computeCriteriaHash(criteria), canonicalCriteriaString(criteria), JSON.stringify(criteria), "TEST FIXTURE (not on-chain)", "fixture", null, null, U.freelancer, "Funded", null]
    )
    assert.equal(r.rows[0].o_created, true)
    const view = await repoFor(U.freelancer).getInvoice("1730000000000")
    assert.equal(view.invoice.isTestFixture, true)
    assert.equal(view.invoice.financialStatusVerified, false)
    assert.equal(view.invoice.amount, tokens(1000), "1000 tokens in base units, exact")
    assert.deepEqual([view.invoice.escrowBalance, view.invoice.freelancerReceived], ["0", "0"])
    await db.query("alter table invoice_criteria disable trigger user")
    await db.query("alter table invoices disable trigger user")
    await db.query("delete from invoice_criteria where invoice_uuid = $1", [r.rows[0].o_id])
    await db.query("delete from invoices where id = $1", [r.rows[0].o_id])
    await db.query("alter table invoice_criteria enable trigger user")
    await db.query("alter table invoices enable trigger user")
  })
})

describe("live repository: authorized records are fetched", () => {
  it("maps the freelancer's and the client's invoices into the UI's own types, with ids the UI routes by", async () => {
    const f = repoFor(U.freelancer)
    const session = await f.getSession()
    assert.equal(session.isDemo, false)
    assert.equal(session.wallet, W.freelancer)
    const list = await f.listInvoices("freelancer", session.wallet)
    const main = list.find((i) => i.invoiceId === "1")!
    assert.equal(main.title, "Brand identity")
    assert.equal(main.amount, "1000")
    assert.equal(main.clientName, "0xaaaa…aaaa")
    assert.equal(main.freelancerName, "You")
    assert.equal(main.submissionStatus, "NotSubmitted")
    const c = repoFor(U.client)
    assert.deepEqual((await c.listInvoices("client", W.client)).map((i) => i.invoiceId), ["1"])
    assert.deepEqual(await c.listInvoices("freelancer", W.client), [], "the client is not a freelancer on anything")
  })

  it("loads the full invoice (criteria in order, frozen) by on-chain id or UUID", async () => {
    const f = repoFor(U.freelancer)
    const byOnchain = await f.getInvoice("1")
    assert.deepEqual(byOnchain.invoice.criteria.map((c) => [c.id, c.text, c.mandatory]), [["c1", "Logo delivered", true], ["c2", "Source files included", false]])
    const byUuid = await f.getInvoice(INV.main)
    assert.equal(byUuid.invoice.invoiceId, "1")
  })

  it("never shows a cached status as fact: unverified invoices carry placeholders and an explicit flag", async () => {
    const f = repoFor(U.freelancer)
    const b = await f.getInvoice("1")
    assert.equal(b.invoice.financialStatusVerified, false)
    assert.deepEqual([b.invoice.escrowBalance, b.invoice.freelancerReceived, b.invoice.reserveCredited], ["0", "0", "0"])
    assert.equal(b.chainVerified, false)
    assert.deepEqual(b.transactions, [], "no transaction is ever fabricated")
    assert.equal(b.timeline.every((e) => e.layer === "offchain"), true, "no on-chain event without a chain read")
    const fixture = (await f.listInvoices("freelancer", W.freelancer)).find((i) => i.invoiceId === "3")!
    assert.equal(fixture.isTestFixture, true)
  })

  it("chain-verified figures are derived only from a chain-verified status", () => {
    assert.deepEqual(figuresFor("Funded", "1000", "0", true), { escrowBalance: "1000", freelancerReceived: "0", reserveCredited: "0" })
    assert.deepEqual(figuresFor("Advanced", "1000", "900", true), { escrowBalance: "1000", freelancerReceived: "900", reserveCredited: "0" })
    assert.deepEqual(figuresFor("Settled", "1000", "900", true), { escrowBalance: "0", freelancerReceived: "1000", reserveCredited: "900" })
    assert.deepEqual(figuresFor("Settled", "1000", "900", false), { escrowBalance: "0", freelancerReceived: "0", reserveCredited: "0" }, "unverified Settled shows no payout")
  })
})

describe("live repository: unauthorized users cannot reach other invoices", () => {
  it("a stranger lists only their own invoice and gets NOT_FOUND for anyone else's, by on-chain id and by UUID", async () => {
    const s = repoFor(U.stranger)
    assert.deepEqual((await s.listInvoices("client", W.stranger)).map((i) => i.invoiceId), ["2"])
    await assert.rejects(s.getInvoice("1"), (e: unknown) => e instanceof DomainError && e.code === "NOT_FOUND")
    await assert.rejects(s.getInvoice(INV.main), (e: unknown) => e instanceof DomainError && e.code === "NOT_FOUND")
    await assert.rejects(s.getInvoice("../../etc/passwd"), (e: unknown) => e instanceof DomainError && e.code === "NOT_FOUND")
  })

  it("signed-out and unverified-claimant callers get no data and no session", async () => {
    const signedOut = repoFor(null)
    await assert.rejects(signedOut.getSession(), (e: unknown) => e instanceof DomainError && e.code === "UNAUTHENTICATED")
    await assert.rejects(signedOut.listInvoices("client", ""), (e: unknown) => e instanceof DomainError && e.code === "UNAUTHENTICATED")
    assert.deepEqual(await signedOut.live.getAuth(), { authenticated: false, wallets: [] })
    const claimant = repoFor(U.claimant)
    await assert.rejects(claimant.getSession(), (e: unknown) => e instanceof DomainError && e.code === "FORBIDDEN")
    await assert.rejects(claimant.getInvoice("1"), (e: unknown) => e instanceof DomainError && e.code === "FORBIDDEN")
  })

  it("the view role is a UI preference only: picking 'client' or 'platform' never widens what the server returns", async () => {
    const f = repoFor(U.freelancer)
    f.live.setViewRole("client")
    assert.deepEqual(await f.listInvoices("client", W.freelancer), [], "freelancer-only user has nothing as a client")
    f.live.setViewRole("platform")
    // The platform view is authorized by the ON-CHAIN operator role: with no chain the server cannot verify it, with a chain this
    // user does not hold it. Either way it refuses, and never returns anything.
    await assert.rejects(f.listInvoices("platform", W.freelancer), (e: unknown) => e instanceof DomainError && ["FORBIDDEN", "INTEGRATION_UNAVAILABLE"].includes(e.code))
    assert.equal((await f.getSession()).role, "platform")
    await assert.rejects(f.getInvoice("2"), (e: unknown) => e instanceof DomainError && e.code === "NOT_FOUND")
  })

  it("the freelancer's own wallet is the identity: an argument claiming another wallet changes nothing", async () => {
    const f = repoFor(U.freelancer)
    const forged = await f.listInvoices("freelancer", W.stranger)
    assert.deepEqual(forged.map((i) => i.invoiceId).sort(), ["1", "3"], "the `wallet` argument is ignored; the server session decides")
  })
})

describe("live repository: writes persist and survive a refresh", () => {
  it("evidence upload + evaluation are stored, and a brand-new repository (a page refresh) reads them back", async () => {
    deps.evaluator = evaluator
    const before = repoFor(U.freelancer)
    const sub = await before.submitEvidence({ invoiceId: "1", fileName: "proof.pdf", fileSize: bytes.pdf.length, mimeType: "application/pdf", note: "see section 2", file: pdf() })
    assert.equal(sub.invoiceId, "1")
    const ev = await before.requestEvaluation(sub.submissionId)
    assert.equal(ev.score, 95)
    assert.equal(ev.simulated, false)
    // rows really are in the database
    assert.equal((await db.query<{ c: number }>("select count(*)::int c from submissions")).rows[0].c, 1)
    assert.equal((await db.query<{ c: number }>("select count(*)::int c from evaluations where state='completed'")).rows[0].c, 1)

    const afterRefresh = repoFor(U.freelancer) // no memory of the previous instance
    const bundle = await afterRefresh.getInvoice("1")
    assert.equal(bundle.submissions.length, 1)
    assert.equal(bundle.submissions[0].note, "see section 2")
    assert.equal(bundle.submissions[0].storagePath, "", "storage paths are never sent to the browser")
    assert.equal(bundle.evaluations[0].score, 95)
    assert.deepEqual(bundle.evaluations[0].mandatory, [true, false])
    assert.equal(bundle.invoice.submissionStatus, "Evaluated")
    assert.ok(bundle.timeline.some((e) => e.kind === "evaluated"))
    const list = await afterRefresh.listInvoices("freelancer", W.freelancer)
    assert.equal(list.find((i) => i.invoiceId === "1")?.submissionStatus, "Evaluated")
    // and the client sees the same evidence and evaluation
    const clientView = await repoFor(U.client).getInvoice("1")
    assert.equal(clientView.submissions.length, 1)
    assert.equal(clientView.evaluations.length, 1)
  })

  it("a simulated (demo-evaluator) evaluation keeps its simulated flag all the way to the UI model", async () => {
    deps.evaluator = demoEvaluator
    const r = repoFor(U.freelancer)
    const sub = await r.submitEvidence({ invoiceId: "1", fileName: "proof.pdf", fileSize: 12, mimeType: "application/pdf", note: "", file: pdf() })
    const ev = await r.requestEvaluation(sub.submissionId)
    assert.equal(ev.simulated, true)
    assert.equal((await repoFor(U.freelancer).getInvoice("1")).evaluations[0].simulated, true)
  })

  it("subscribers are notified after a mutation so open screens reload from the server", async () => {
    deps.evaluator = evaluator
    const r = repoFor(U.freelancer)
    let pings = 0
    r.subscribe(() => pings++)
    await r.submitEvidence({ invoiceId: "1", fileName: "proof.pdf", fileSize: 12, mimeType: "application/pdf", note: "", file: pdf() })
    assert.ok(pings >= 1)
  })

  it("the client cannot upload evidence or request evaluation for an invoice (server refuses, UI error is mapped)", async () => {
    const c = repoFor(U.client)
    await assert.rejects(c.submitEvidence({ invoiceId: "1", fileName: "proof.pdf", fileSize: 12, mimeType: "application/pdf", note: "", file: pdf() }), (e: unknown) => e instanceof DomainError && e.code === "FORBIDDEN")
    assert.equal((await db.query<{ c: number }>("select count(*)::int c from submissions")).rows[0].c, 0)
  })

  it("evaluation with no evaluator configured is reported as an unavailable integration, not a result", async () => {
    deps.evaluator = unavailableDeps(db, store).evaluator // disabled
    const r = repoFor(U.freelancer)
    const sub = await r.submitEvidence({ invoiceId: "1", fileName: "proof.pdf", fileSize: 12, mimeType: "application/pdf", note: "", file: pdf() })
    await assert.rejects(r.requestEvaluation(sub.submissionId), (e: unknown) => e instanceof DomainError && e.code === "INTEGRATION_UNAVAILABLE")
    assert.equal((await db.query<{ c: number }>("select count(*)::int c from evaluations")).rows[0].c, 0)
  })
})

describe("blocked workflows fail honestly and never fake a blockchain result", () => {
  it("without a browser wallet, every wallet transaction fails NO_WALLET (never a simulated success) and nothing is recorded", async () => {
    const r = new ApiDuelyRepository({
      fetch: shim(() => U.client),
      storage: null,
      txLog: new TxLog(null),
      wallet: { require: (o) => requireWallet({ ...o, provider: null }), state: () => readWalletState(null), connect: () => connectWallet(null), switchNetwork: () => switchToExpectedChain(null), watch: () => () => undefined },
    })
    const input = { title: "t", freelancer: W.freelancer as `0x${string}`, amount: "1000", description: "d", criteria: [{ text: "c", mandatory: true }] }
    for (const call of [() => r.createInvoice(input), () => r.fundInvoice("1"), () => r.approveInvoice("1"), () => r.disputeInvoice("1"), () => r.depositReserve("1000"), () => r.resolveDispute("1", true)] as Array<() => Promise<unknown>>) {
      await assert.rejects(call(), (e: unknown) => e instanceof DomainError && e.code === "NO_WALLET")
    }
    assert.deepEqual(await r.listTransactions(), [], "no transaction history exists to show")
    assert.equal((await db.query<{ c: number }>("select count(*)::int c from transactions")).rows[0].c, 0)
  })

  it("balances need the operator role: a client is refused rather than shown invented numbers", async () => {
    const r = repoFor(U.client)
    await assert.rejects(r.getBalances(), (e: unknown) => e instanceof DomainError && ["FORBIDDEN", "INTEGRATION_UNAVAILABLE"].includes(e.code))
  })

  it("requesting an advance answers INTEGRATION_UNAVAILABLE (no chain, no signer) and records nothing", async () => {
    const f = repoFor(U.freelancer)
    deps.evaluator = evaluator
    const sub = await f.submitEvidence({ invoiceId: "1", fileName: "proof.pdf", fileSize: 12, mimeType: "application/pdf", note: "", file: pdf() })
    await f.requestEvaluation(sub.submissionId)
    await assert.rejects(f.requestAdvance("1"), (e: unknown) => e instanceof DomainError && e.code === "INTEGRATION_UNAVAILABLE")
    assert.equal((await db.query<{ c: number }>("select count(*)::int c from advance_requests")).rows[0].c, 0)
    assert.equal((await db.query<{ c: number }>("select count(*)::int c from transactions")).rows[0].c, 0)
  })

  it("with a (fake) chain and signer, an accepted advance is shown as PENDING, never paid", async () => {
    chain.available = true
    chain.state = { onchainStatus: "Funded", amount: BigInt(1000), advanceAmount: BigInt(0), blockNumber: BigInt(9) }
    chain.reserve = BigInt(5000)
    deps.evaluator = evaluator
    const f = repoFor(U.freelancer)
    const sub = await f.submitEvidence({ invoiceId: "1", fileName: "proof.pdf", fileSize: 12, mimeType: "application/pdf", note: "", file: pdf() })
    await f.requestEvaluation(sub.submissionId)
    const r = await f.requestAdvance("1")
    assert.equal(r.status, "pending")
    const bundle = await repoFor(U.freelancer).getInvoice("1")
    assert.equal(bundle.advanceRequests[0].status, "pending")
    assert.equal(bundle.chainVerified, true)
    assert.equal(bundle.invoice.financialStatusVerified, true)
    assert.equal(bundle.invoice.freelancerReceived, "0", "pending advance is not received money")
    assert.ok(!bundle.timeline.some((e) => e.kind === "advance_paid"))
    assert.ok(bundle.timeline.some((e) => e.kind === "advance_requested"))
  })

  it("a network failure is reported as an unavailable server, not as empty data", async () => {
    const r = new ApiDuelyRepository({ fetch: (async () => { throw new TypeError("fetch failed") }) as never, storage: null })
    await assert.rejects(r.getSession(), (e: unknown) => e instanceof DomainError && e.code === "INTEGRATION_UNAVAILABLE")
  })
})

describe("mock and live modes are independent", () => {
  it("the live adapter and its helpers never read or write browser storage for data or identity", () => {
    for (const f of ["lib/frontend/api-repository.ts", "lib/frontend/api-mappers.ts", "components/duely/live-auth.tsx"]) {
      const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
      assert.ok(!/localStorage/.test(src), `${f} must not use localStorage`)
    }
  })

  it("the live adapter works with localStorage and sessionStorage unavailable, and the view role is the only thing it would persist", async () => {
    const trap = { get: () => { throw new Error("storage must not be touched") } }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, ...trap })
    try {
      const r = repoFor(U.freelancer)
      assert.equal((await r.getSession()).wallet, W.freelancer)
      assert.ok((await r.listInvoices("freelancer", "")).length >= 1)
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage
    }
    const saved: Record<string, string> = {}
    const r2 = new ApiDuelyRepository({ fetch: shim(() => U.freelancer), storage: { getItem: (k) => saved[k] ?? null, setItem: (k, v) => { saved[k] = v } } })
    r2.live.setViewRole("freelancer")
    assert.deepEqual(Object.keys(saved), ["duely.live-view-role"], "only a UI preference is stored")
    const r3 = new ApiDuelyRepository({ fetch: shim(() => null), storage: { getItem: (k) => saved[k] ?? null, setItem: () => undefined } })
    assert.equal((await r3.live.getAuth()).authenticated, false, "a stored view role proves nothing: the server says signed out")
  })

  it("the mock repository runs a full flow with the network unavailable, and exposes demo controls only", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => { throw new Error("mock mode must not use the network") }) as never
    try {
      const m = new MockDuelyRepository()
      assert.equal(m.mode, "mock")
      assert.ok(m.demo)
      assert.equal((m as DuelyRepository).live, undefined)
      m.demo!.reset()
      m.demo!.switchRole("client")
      const s = await m.getSession()
      assert.equal(s.isDemo, true)
      const list = await m.listInvoices("client", s.wallet)
      assert.ok(list.length > 0, "seeded demo invoices")
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("the live adapter has no demo controls, and mock data never leaks into it", async () => {
    const r = repoFor(U.freelancer)
    assert.equal((r as DuelyRepository).demo, undefined)
    assert.ok(r.live)
    const titles = (await r.listInvoices("freelancer", "")).map((i) => i.title)
    assert.ok(!titles.some((t) => /pitch deck|simulated|demo/i.test(t)), "only database rows")
  })

  it("API mode is chosen only by NEXT_PUBLIC_DATA_MODE=api; the default is mock", () => {
    const src = fs.readFileSync("lib/frontend/data-mode.ts", "utf8")
    assert.match(src, /NEXT_PUBLIC_DATA_MODE === "api" \? "api" : "mock"/)
    const repoSrc = fs.readFileSync("lib/frontend/create-repository.ts", "utf8")
    assert.match(repoSrc, /DATA_MODE !== "api"\s*(?:\)\s*)?return new MockDuelyRepository\(\)/)
    assert.match(repoSrc, /new ApiDuelyRepository\(/)
  })

  it("timeline building adds no on-chain events and labels fixtures", () => {
    const detail = {
      invoice: { id: "u", chainId: 0, isTestFixture: true, createdAt: "2026-01-01T00:00:00Z", invoiceId: "3", client: "0x1" as Address, freelancer: "0x2" as Address, amount: "1", advanceAmount: "0", criteriaHash: H as `0x${string}`, onchainStatus: "Funded", submissionStatus: "NotSubmitted", description: "", title: "t", financialStatusVerified: false },
      chain: { verified: false }, criteria: [], criteriaVersion: 1, dueDate: null, submissions: [], evaluations: [], advanceRequests: [],
    } as unknown as ApiInvoiceDetail
    const t = buildTimeline(detail)
    assert.equal(t.length, 1)
    assert.match(t[0].description, /does not exist on any blockchain/)
    assert.equal(t[0].layer, "offchain")
  })
})
