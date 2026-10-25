import assert from "node:assert/strict"
import fs from "node:fs"
import { after, before, describe, it } from "node:test"
import type { PGlite } from "@electric-sql/pglite"
import { createDb } from "./helpers/db"
import { Clock, FakeObjectStore, createPgEvidenceDb } from "./helpers/evidence"
import { ctx, createPgBackendDb, FakeChainAdapter, FakeSigner, http, ScriptedEvaluator } from "./helpers/backend"
import { activeDeploymentScope } from "@/lib/backend/scope"
import { handleAdvance, handleCreateInvoice, handleEvaluate, handleGetInvoice, handleListInvoices } from "@/lib/backend/handlers"
import type { BackendDeps } from "@/lib/backend/ports"
import { getDeployment, getRegisteredToken, setDeploymentOverrideForTests } from "@/lib/chain/deployments"
import { initUpload, type EvidenceDeps } from "@/lib/evidence/service"
import { computeCriteriaHash } from "@/lib/shared/criteria"
import { invoiceInScope, type DeploymentScope } from "@/lib/shared/deployment-scope"

/**
 * dUSD (6 decimals) and RLUSD (18 decimals) are different deployments whose on-chain invoice ids repeat. A server
 * process serves ONE of them; the other's rows must never be listed, resolved, acted on or registered.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const U = { client: id(1), freelancer: id(2), stranger: id(3) }
const W = { client: "0x" + "a".repeat(40), freelancer: "0x" + "b".repeat(40), stranger: "0x" + "c".repeat(40) }
const H = "0x" + "1".repeat(64)
const TX = "0x" + "cd".repeat(32)

const DUSD = { chain: 1449000, contract: "0x328fc0dbf3d1f704b065192f4bfc7583bfa550e0", token: "0x5ff7b6ae08c37868303e7a815308af476421506c" }
const RLUSD = { chain: 1449000, contract: "0x1b972ec6b1b5e0b592010e7484bef0accc382792", token: "0x27b57a9d0b8d24eb97259c4e2279e45255e016f3" }
const scopeOf = (k: string, d: typeof DUSD, decimals: number): DeploymentScope => ({ chainId: d.chain, contractAddress: d.contract, tokenAddress: d.token, key: k, symbol: k.toUpperCase(), decimals })
const SCOPE_DUSD = scopeOf("dusd", DUSD, 6)
const SCOPE_RLUSD = scopeOf("rlusd", RLUSD, 18)

const INV = { dusd1: id(101), rlusd1: id(102), dusdOnly: id(103), fixture: id(104) }

let db: PGlite
let store: FakeObjectStore
let chain: FakeChainAdapter
let signer: FakeSigner
let evaluator: ScriptedEvaluator

async function seed(invId: string, d: { chain: number; contract: string; token: string }, onchainId: number, amount: string) {
  await db.query(
    `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
     values ($1,$2,$3,$4,$5::numeric,$6,$7,$8::numeric,$9,1,'canon','T',$10,'Funded')`,
    [invId, d.chain, d.contract, d.token, onchainId, W.client, W.freelancer, amount, H, U.client]
  )
  await db.query("insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ($1,0,'c1','Logo delivered',true)", [invId])
}

const depsFor = (scope: DeploymentScope): BackendDeps => ({ scope, db: createPgBackendDb(db), objects: store, chain, signer, evaluator })
const body = async (res: Response) => (await res.json()) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

before(async () => {
  db = await createDb()
  for (const [k, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1, $2)", [uid, `${k}@t.invalid`])
  for (const [user, addr] of [[U.client, W.client], [U.freelancer, W.freelancer], [U.stranger, W.stranger]] as const) {
    await db.query("insert into user_wallets (user_id, address, verified_at, verification_method) values ($1,$2,now(),'eip191')", [user, addr])
  }
  // The SAME on-chain id (1) on both deployments, with amounts that only make sense in their own decimals.
  await seed(INV.dusd1, DUSD, 1, "1000000000") //            1,000 dUSD
  await seed(INV.rlusd1, RLUSD, 1, "1000000000000000000") // 1 RLUSD
  await seed(INV.dusdOnly, DUSD, 2, "5000000")
  await seed(INV.fixture, { chain: 0, contract: "0x" + "0".repeat(40), token: "0x" + "0".repeat(40) }, 99, "1000")
  store = new FakeObjectStore(new Clock())
  chain = new FakeChainAdapter()
  signer = new FakeSigner()
  evaluator = new ScriptedEvaluator()
})
after(async () => db.close())

describe("scope predicate", () => {
  it("matches only the exact chain + contract + token, ignoring address case; dev fixtures belong to no deployment", () => {
    const row = { chain_id: 1449000, contract_address: RLUSD.contract.toUpperCase().replace("0X", "0x"), token_address: RLUSD.token }
    assert.equal(invoiceInScope(row, SCOPE_RLUSD), true)
    assert.equal(invoiceInScope(row, SCOPE_DUSD), false)
    assert.equal(invoiceInScope({ ...row, chain_id: 1 }, SCOPE_RLUSD), false)
    assert.equal(invoiceInScope({ ...row, token_address: DUSD.token }, SCOPE_RLUSD), false, "right contract, wrong token")
    assert.equal(invoiceInScope({ chain_id: 0, contract_address: "0x" + "0".repeat(40) }, SCOPE_RLUSD), true)
    assert.equal(invoiceInScope({ chain_id: 1449000, contract_address: RLUSD.contract }, SCOPE_RLUSD), true, "evidence rows carry no token; the contract pins it")
  })
})

describe("the list and by-id reads show only the active deployment", () => {
  for (const [name, scope, mine, other] of [
    ["RLUSD server", SCOPE_RLUSD, INV.rlusd1, [INV.dusd1, INV.dusdOnly]],
    ["dUSD server", SCOPE_DUSD, INV.dusd1, [INV.rlusd1]],
  ] as const) {
    it(`${name}: lists its own invoices, none of the other deployment's`, async () => {
      const res = await handleListInvoices(new Request("http://localhost:3000/x"), ctx(U.client, depsFor(scope)))
      const ids = (await body(res)).invoices.map((i: { id: string }) => i.id)
      assert.ok(ids.includes(mine))
      for (const o of other) assert.ok(!ids.includes(o), `${o} must not be listed`)
      assert.ok(ids.includes(INV.fixture), "dev fixtures stay visible (flagged separately)")
    })
  }

  it("an on-chain id that exists on both deployments resolves to the active deployment's invoice", async () => {
    for (const [scope, want] of [[SCOPE_RLUSD, INV.rlusd1], [SCOPE_DUSD, INV.dusd1]] as const) {
      const res = await handleGetInvoice(new Request("http://localhost:3000/x"), ctx(U.client, depsFor(scope)), { id: "1" })
      assert.equal(res.status, 200)
      assert.equal((await body(res)).invoice.id, want)
    }
  })

  it("an on-chain id that only exists on the OTHER deployment is not found (no cross-deployment fallback)", async () => {
    const res = await handleGetInvoice(new Request("http://localhost:3000/x"), ctx(U.client, depsFor(SCOPE_RLUSD)), { id: "2" })
    assert.equal(res.status, 404)
  })

  it("the other deployment's invoice by UUID is refused to its party with WRONG_DEPLOYMENT, and hidden from strangers", async () => {
    const party = await handleGetInvoice(new Request("http://localhost:3000/x"), ctx(U.client, depsFor(SCOPE_RLUSD)), { id: INV.dusd1 })
    assert.equal(party.status, 409)
    const e = await body(party)
    assert.equal(e.error.code, "WRONG_DEPLOYMENT")
    assert.match(e.error.message, /different deployment/)
    assert.equal(e.invoice, undefined, "no amounts leak in the refusal")
    const stranger = await handleGetInvoice(new Request("http://localhost:3000/x"), ctx(U.stranger, depsFor(SCOPE_RLUSD)), { id: INV.dusd1 })
    assert.equal(stranger.status, 404, "existence is not revealed to non-parties")
  })
})

describe("mutations cannot cross deployments", () => {
  it("an advance request for another deployment's invoice is refused before any chain call or signing", async () => {
    chain.calls = { creation: 0, state: 0, reserve: 0, tx: 0, found: 0 }
    const res = await http(handleAdvance, ctx(U.freelancer, depsFor(SCOPE_RLUSD)), { body: { invoiceId: INV.dusd1 } })
    assert.equal(res.status, 409)
    assert.equal((res.json as any).error.code, "WRONG_DEPLOYMENT") // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual(chain.calls, { creation: 0, state: 0, reserve: 0, tx: 0, found: 0 })
    assert.equal(signer.calls, 0)
  })

  it("an evaluation of another deployment's submission is refused before the evaluator runs", async () => {
    const sub = id(201)
    await db.query(
      "insert into submissions (id, invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type, note, funding_verified_onchain) values ($1,$2,$3,$4,$5,'a.txt',10,'text/plain','',false)",
      [sub, INV.dusd1, U.freelancer, W.freelancer, `${INV.dusd1}/${U.freelancer}/x.txt`]
    )
    const before = evaluator.calls
    const res = await http(handleEvaluate, ctx(U.freelancer, depsFor(SCOPE_RLUSD)), { body: { submissionId: sub } })
    assert.equal(res.status, 409)
    assert.equal((res.json as any).error.code, "WRONG_DEPLOYMENT") // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(evaluator.calls, before)
  })

  it("evidence upload for another deployment's invoice is refused", async () => {
    const ev: EvidenceDeps = { scope: SCOPE_RLUSD, db: createPgEvidenceDb(db), objects: store, chain: { verify: async () => ({ status: "unavailable" }) }, requireChainVerification: false }
    await assert.rejects(
      initUpload(ev, { userId: U.freelancer, invoiceId: INV.dusd1, fileName: "a.txt", fileSize: 10, mimeType: "text/plain" }),
      (e: { code?: string }) => e.code === "WRONG_DEPLOYMENT"
    )
  })

  it("registering an invoice created on the other deployment is refused and nothing is stored", async () => {
    const criteria = [{ id: "c1", text: "Logo delivered", mandatory: true }]
    chain.creation = {
      status: "confirmed", chainId: 1449000, contractAddress: DUSD.contract as `0x${string}`, tokenAddress: DUSD.token as `0x${string}`,
      invoiceId: BigInt(77), creator: W.client as `0x${string}`, freelancer: W.freelancer as `0x${string}`, amount: BigInt(1000),
      criteriaHash: computeCriteriaHash(criteria), blockNumber: BigInt(1),
    }
    chain.state = { onchainStatus: "Created", amount: BigInt(1000), advanceAmount: BigInt(0), blockNumber: BigInt(1) }
    const before = (await db.query<{ n: number }>("select count(*)::int as n from invoices")).rows[0].n
    const res = await http(handleCreateInvoice, ctx(U.client, depsFor(SCOPE_RLUSD)), { body: { invoiceId: "77", txHash: TX, description: "x", criteria } })
    assert.equal(res.status, 409)
    assert.equal((res.json as any).error.code, "WRONG_DEPLOYMENT") // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal((await db.query<{ n: number }>("select count(*)::int as n from invoices")).rows[0].n, before)
    // The same creation IS accepted by the deployment it belongs to.
    const ok = await http(handleCreateInvoice, ctx(U.client, depsFor(SCOPE_DUSD)), { body: { invoiceId: "77", txHash: TX, description: "x", criteria } })
    assert.equal(ok.status, 201)
  })
})

describe("server wiring has no unscoped path", () => {
  it("activeDeploymentScope() follows DUELY_DEPLOYMENT (lower-cased addresses, symbol and decimals of the active token)", () => {
    const dusd = activeDeploymentScope()
    assert.deepEqual({ k: dusd.key, d: dusd.decimals, c: dusd.contractAddress }, { k: "dusd", d: 6, c: DUSD.contract })
    setDeploymentOverrideForTests({ ...getDeployment("dusd"), key: "rlusd", token: getRegisteredToken("rlusd"), invoiceAdvance: { ...getDeployment("dusd").invoiceAdvance, address: "0x1B972ec6B1B5E0b592010e7484beF0accC382792" } })
    try {
      const r = activeDeploymentScope()
      assert.deepEqual({ k: r.key, d: r.decimals, c: r.contractAddress, t: r.tokenAddress }, { k: "rlusd", d: 18, c: RLUSD.contract, t: RLUSD.token })
    } finally {
      setDeploymentOverrideForTests(null)
    }
  })

  it("both production dependency builders set the scope from the active deployment", () => {
    for (const file of ["lib/backend/server.ts", "lib/evidence/server.ts"]) {
      const src = fs.readFileSync(file, "utf8")
      assert.match(src, /const scope = activeDeploymentScope\(\)/, file)
      assert.match(src, /^\s+scope,$/m, `${file} passes the scope into the deps`)
    }
  })

  it("the dependency types make the scope mandatory (a missing scope is a compile error, not a silent unscoped mode)", () => {
    assert.match(fs.readFileSync("lib/backend/ports.ts", "utf8"), /^\s{2}scope: DeploymentScope$/m)
    assert.match(fs.readFileSync("lib/evidence/service.ts", "utf8"), /^\s{2}scope: DeploymentScope$/m)
  })
})
