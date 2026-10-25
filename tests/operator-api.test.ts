import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import type { PGlite } from "@electric-sql/pglite"
import { createDb } from "./helpers/db"
import { Clock, FakeObjectStore } from "./helpers/evidence"
import { ctx, createPgBackendDb, FakeChainAdapter, FakeSigner, ScriptedEvaluator, TEST_SCOPE, unavailableDeps } from "./helpers/backend"
import { handleOperatorInvoices } from "@/lib/backend/handlers"
import type { BackendDeps, ChainInvoiceState } from "@/lib/backend/ports"

/** GET /api/operator/invoices: authorized by the ON-CHAIN operator role; statuses come from the chain, never the cache. */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const U = { operator: id(1), client: id(2), nowallet: id(3) }
const W = { operator: "0x" + "9".repeat(40), client: "0x" + "a".repeat(40), freelancer: "0x" + "b".repeat(40) }
const H = "0x" + "1".repeat(64)

let db: PGlite
let chain: FakeChainAdapter
let deps: BackendDeps
const states = new Map<string, ChainInvoiceState | Error>()

async function seed(uuid: string, onchainId: number, o: { chain?: number; contract?: string; cache?: string } = {}) {
  await db.query(
    `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
     values ($1,$2,$3,$4,$5::numeric,$6,$7,1000,$8,1,'c',$9,$10,$11)`,
    [uuid, o.chain ?? 1440002, o.contract ?? TEST_SCOPE.contractAddress, TEST_SCOPE.tokenAddress, onchainId, W.client, W.freelancer, H, `Invoice ${onchainId}`, U.client, o.cache ?? "Funded"]
  )
  await db.query("insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ($1,0,'c1','x',true)", [uuid])
}
const state = (onchainStatus: ChainInvoiceState["onchainStatus"], advanceAmount = BigInt(0)): ChainInvoiceState => ({ onchainStatus, amount: BigInt(1000), advanceAmount, blockNumber: BigInt(5) })
const call = async (user: string | null) => {
  const res = await handleOperatorInvoices(new Request("http://localhost:3000/x"), ctx(user, deps))
  return { status: res.status, json: (await res.json()) as { operator?: string; invoices?: { id: string; onchainStatus: string; financialStatusVerified: boolean }[]; error?: { code: string } } }
}

before(async () => {
  db = await createDb()
  for (const [k, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, `${k}@t.invalid`])
  for (const [user, addr] of [[U.operator, W.operator], [U.client, W.client]] as const) {
    await db.query("insert into user_wallets (user_id, address, verified_at, verification_method) values ($1,$2,now(),'eip191')", [user, addr])
  }
  await seed(id(101), 1, { cache: "Funded" }) // chain says Advanced: the CACHE is stale
  await seed(id(102), 2, { cache: "Advanced" }) // chain says Disputed
  await seed(id(103), 3, { cache: "Disputed" }) // chain says Settled: must NOT be listed
  await seed(id(104), 4) // chain read fails: must be left out, not guessed
  await seed(id(105), 5, { contract: "0x" + "7".repeat(40) }) // another deployment
  await seed(id(106), 6, { chain: 0, contract: "0x" + "0".repeat(40) }) // dev fixture
  states.set("1", state("Advanced", BigInt(900)))
  states.set("2", state("Disputed", BigInt(900)))
  states.set("3", state("Settled", BigInt(900)))
  states.set("4", new Error("rpc down"))
  chain = new FakeChainAdapter()
  chain.roles.operator.add(W.operator)
  chain.getInvoiceState = async (ref) => {
    const s = states.get(String(ref?.invoiceId))
    if (!s) throw new Error("unexpected ref")
    if (s instanceof Error) throw s
    return s
  }
  deps = { scope: TEST_SCOPE, db: createPgBackendDb(db), objects: new FakeObjectStore(new Clock()), chain, signer: new FakeSigner(), evaluator: new ScriptedEvaluator() }
})
after(async () => db.close())

describe("operator overview", () => {
  it("lists only Advanced/Disputed invoices of THIS deployment, with statuses read from the chain (not the cache)", async () => {
    const r = await call(U.operator)
    assert.equal(r.status, 200)
    assert.equal(r.json.operator, W.operator)
    const byId = new Map(r.json.invoices!.map((i) => [i.id, i]))
    assert.deepEqual([...byId.keys()].sort(), [id(101), id(102)].sort())
    assert.equal(byId.get(id(101))?.onchainStatus, "Advanced", "the stale 'Funded' cache is overridden by the chain")
    assert.equal(byId.get(id(102))?.onchainStatus, "Disputed")
    assert.ok(r.json.invoices!.every((i) => i.financialStatusVerified === true))
  })

  it("leaves out invoices whose chain read failed, other deployments, dev fixtures and settled ones", async () => {
    const ids = (await call(U.operator)).json.invoices!.map((i) => i.id)
    for (const excluded of [id(103), id(104), id(105), id(106)]) assert.ok(!ids.includes(excluded), excluded)
  })

  it("is authorized by the ON-CHAIN role: a client wallet, a signed-out caller and a wallet-less user are refused", async () => {
    assert.equal((await call(U.client)).status, 403)
    assert.equal((await call(null)).status, 401)
    assert.equal((await call(U.nowallet)).status, 403)
    // a database flag can't grant it: only the chain's hasRole answers
    chain.roles.operator.delete(W.operator)
    assert.equal((await call(U.operator)).status, 403)
    chain.roles.operator.add(W.operator)
  })

  it("answers 503 (never an empty list) when the chain can't be used to verify the role", async () => {
    const r = await handleOperatorInvoices(new Request("http://localhost:3000/x"), ctx(U.operator, unavailableDeps(db, new FakeObjectStore(new Clock()))))
    assert.equal(r.status, 503)
  })

  it("a role-check RPC failure is a 502, not a pass", async () => {
    const original = chain.hasRole.bind(chain)
    chain.hasRole = async () => {
      throw new Error("rpc down")
    }
    assert.equal((await call(U.operator)).status, 502)
    chain.hasRole = original
  })
})
