import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import type { PGlite } from "@electric-sql/pglite"
import { createDb } from "./helpers/db"
import { createPgBackendDb, ctx, FakeChainAdapter, FakeSigner, ScriptedEvaluator, TEST_SCOPE } from "./helpers/backend"
import { FakeObjectStore, Clock } from "./helpers/evidence"
import { handleGetInvoice, handleListInvoices } from "@/lib/backend/handlers"
import { ApiDuelyRepository } from "@/lib/frontend/api-repository"
import { DomainError } from "@/lib/frontend/errors"
import type { BackendDeps } from "@/lib/backend/ports"

// One wallet (ME) is the CLIENT on invoice 1 and the FREELANCER on invoice 2. Nothing about roles lives on the account: each invoice
// names its own two different wallets, and the server derives the caller's role per invoice from their VERIFIED wallet.
let db: PGlite
let deps: BackendDeps

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const USER = { me: id(1), other: id(2) }
const W = { me: "0x" + "9".repeat(40), freelancerOfMine: "0x" + "b".repeat(40), clientOfMine: "0x" + "a".repeat(40), contract: "0x" + "e".repeat(40), token: "0x" + "d".repeat(40) }
const H = "0x" + "1".repeat(64)
const INV = { asClient: id(301), asFreelancer: id(302) }

const insert = (invUuid: string, onchainId: number, client: string, freelancer: string, title: string) =>
  db.query(
    `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
     values ($1,1440002,$2,$3,$4::numeric,$5,$6,1000,$7,1,'canon',$8,$9,'Funded')`,
    [invUuid, W.contract, W.token, onchainId, client, freelancer, H, title, USER.me]
  )

before(async () => {
  db = await createDb()
  for (const uid of Object.values(USER)) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, `${uid}@t.invalid`])
  await db.query("insert into user_wallets (user_id, address, verified_at, verification_method) values ($1,$2,now(),'eip191')", [USER.me, W.me])
  await insert(INV.asClient, 1, W.me, W.freelancerOfMine, "I am the client here")
  await insert(INV.asFreelancer, 2, W.clientOfMine, W.me, "I am the freelancer here")
  for (const i of [INV.asClient, INV.asFreelancer]) await db.query("insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ($1,0,'c1','Delivered',true)", [i])
  const chain = new FakeChainAdapter()
  chain.available = false
  deps = { scope: TEST_SCOPE, db: createPgBackendDb(db), objects: new FakeObjectStore(new Clock()), chain, signer: new FakeSigner(), evaluator: new ScriptedEvaluator() }
})
after(async () => db.close())

function shim(): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input), "http://localhost:3000")
    const req = new Request(url, { method: (init?.method ?? "GET").toUpperCase() })
    const c = ctx(USER.me, deps)
    if (url.pathname === "/api/auth/session") return Response.json({ authenticated: true, userId: USER.me, wallets: [W.me] })
    if (url.pathname === "/api/invoices") return handleListInvoices(req, c)
    const m = url.pathname.match(/^\/api\/invoices\/([^/]+)$/)
    if (m) return handleGetInvoice(req, c, { id: decodeURIComponent(m[1]) })
    return Response.json({ error: { code: "NOT_FOUND", message: "no route" } }, { status: 404 })
  }
}
const repo = () => new ApiDuelyRepository({ fetch: shim(), storage: null, signIn: async () => undefined, signOut: async () => undefined })

describe("one verified wallet, both dashboards", () => {
  it("lists the wallet's invoices under Client and Freelancer separately", async () => {
    const r = repo()
    assert.deepEqual((await r.listInvoices("client", W.me)).map((i) => i.invoiceId), ["1"])
    assert.deepEqual((await r.listInvoices("freelancer", W.me)).map((i) => i.invoiceId), ["2"])
  })

  it("the Client / Freelancer switch changes the view role without another sign-in", async () => {
    const r = repo()
    assert.equal((await r.getSession()).role, "client")
    r.live.setViewRole("freelancer")
    const s = await r.getSession()
    assert.equal(s.role, "freelancer")
    assert.equal(s.wallet, W.me)
    r.live.setViewRole("client")
    assert.equal((await r.getSession()).role, "client")
  })

  it("the server resolves the caller's role per invoice from the invoice itself", async () => {
    const get = async (ref: string) => (await (await handleGetInvoice(new Request("http://localhost:3000/x"), ctx(USER.me, deps), { id: ref })).json()) as { invoice: { client: string; freelancer: string } }
    const a = await get(INV.asClient)
    assert.equal(a.invoice.client, W.me)
    assert.notEqual(a.invoice.freelancer, W.me)
    const b = await get(INV.asFreelancer)
    assert.equal(b.invoice.freelancer, W.me)
    assert.notEqual(b.invoice.client, W.me)
  })

  it("the view role grants nothing: a switched view still sees only invoices the wallet is a party to", async () => {
    const r = repo()
    r.live.setViewRole("platform")
    assert.equal((await r.getSession()).role, "platform")
    const res = await r.listInvoices("platform", W.me).then(() => "ok", (e) => (e instanceof DomainError ? e.code : "error"))
    assert.notEqual(res, "ok", "the operator list is refused without the on-chain operator role")
  })
})

describe("same wallet on both sides of ONE invoice stays impossible (escrow and reserve protection)", () => {
  it("the database refuses to store such an invoice", async () => {
    await assert.rejects(insert(id(399), 99, W.me, W.me, "self-dealing"), /check|constraint/i)
  })

  it("the repository refuses to start one before any wallet transaction", () => {
    assert.match(fs.readFileSync("lib/frontend/api-repository.ts", "utf8"), /input\.freelancer\.toLowerCase\(\) === ctx\.account\) throw new DomainError\("INVALID_INPUT"/)
  })

  it("the contract and schema checks are still in place", () => {
    assert.match(fs.readFileSync("contracts/src/InvoiceAdvance.sol", "utf8"), /if \(freelancer == msg\.sender\) revert InvalidInvoiceParties\(\);/)
    assert.match(fs.readFileSync("supabase/migrations/20261024000001_core_schema.sql", "utf8"), /check \(client_address <> freelancer_address\)/)
  })

  it("the create-invoice page explains why and points to the dashboard switcher", () => {
    const page = fs.readFileSync("app/(app)/client/invoices/new/page.tsx", "utf8")
    assert.match(page, /Use a different wallet for the freelancer[\s\S]*switch between the Client and Freelancer dashboards/)
  })
})
