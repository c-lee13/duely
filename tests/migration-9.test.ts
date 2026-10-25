import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import type { PGlite } from "@electric-sql/pglite"
import { createDb, failure } from "./helpers/db"
import { LEGACY_TX_ACTIONS, ONCHAIN_INVOICE_STATUSES, TX_ACTIONS } from "@/lib/shared/types"

/**
 * Migration 9 (supabase/migrations/20261025000009_dual_token_alignment.sql) against the REAL schema in PGlite: rows that
 * existed before it survive, the new contract values are accepted, junk is still rejected, and re-running it is harmless.
 */
const MIG = path.resolve(process.cwd(), "supabase/migrations/20261025000009_dual_token_alignment.sql")
const ZERO = "0x" + "0".repeat(40)
const A = (c: string) => "0x" + c.repeat(40)
const H = "0x" + "1".repeat(64)
const USER = "00000000-0000-4000-8000-000000000001"

let db: PGlite

async function insertInvoice(id: string, o: { chain?: number; contract?: string; token?: string; status?: string; invoiceId?: number } = {}) {
  await db.query(
    `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
     values ($1,$2,$3,$4,$5::numeric,$6,$7,1000,$8,1,'canon','T',$9,$10)`,
    [id, o.chain ?? 1449000, o.contract ?? A("e"), o.token ?? A("d"), o.invoiceId ?? 1, A("a"), A("b"), H, USER, o.status ?? "Funded"]
  )
}

before(async () => {
  db = await createDb() // applies migrations 1..9
  await db.query("insert into auth.users (id, email) values ($1, 'u@t.invalid')", [USER])
})
after(async () => db.close())

describe("migration 9: contract alignment", () => {
  it("accepts every contract status, including Cancelled, and rejects anything else", async () => {
    let n = 100
    for (const status of ONCHAIN_INVOICE_STATUSES) {
      assert.equal(await failure(db, `insert into invoices (chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status) values (1449000,$1,$2,${n++},$3,$4,1,$5,1,'c','T',$6,$7)`, [A("e"), A("d"), A("a"), A("b"), H, USER, status]), null, status)
    }
    const bad = await failure(db, `insert into invoices (chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status) values (1449000,$1,$2,${n},$3,$4,1,$5,1,'c','T',$6,'Paid')`, [A("e"), A("d"), A("a"), A("b"), H, USER])
    assert.match(bad ?? "", /invoices_onchain_status_check/)
  })

  it("accepts every contract function name (and the two legacy names) as a transaction action, and rejects others", async () => {
    for (const action of [...TX_ACTIONS, ...LEGACY_TX_ACTIONS]) {
      assert.equal(await failure(db, "insert into transactions (chain_id, action, status, from_address) values (1449000,$1,'pending',$2)", [action, A("a")]), null, action)
    }
    for (const action of ["transfer", "mint", "approve", "Cancelled"]) {
      assert.match((await failure(db, "insert into transactions (chain_id, action, status, from_address) values (1449000,$1,'pending',$2)", [action, A("a")])) ?? "", /transactions_action_check/, action)
    }
  })

  it("the TS action and status lists equal the SDK's view of the compiled contract", async () => {
    const { INVOICE_STATUSES } = await import("@/lib/chain/reads")
    assert.deepEqual([...ONCHAIN_INVOICE_STATUSES], [...INVOICE_STATUSES])
    const { WRITE_REQUIREMENTS } = await import("@/lib/chain/writes")
    const sdkWrites = Object.keys(WRITE_REQUIREMENTS).filter((k) => k !== "approveToken")
    assert.deepEqual([...TX_ACTIONS].sort(), sdkWrites.sort())
  })
})

describe("migration 9: deployment isolation", () => {
  it("a real invoice needs a real contract and token; only chain_id 0 fixtures may use zero addresses", async () => {
    const noContract = await failure(db, "insert into invoices (chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by) values (1449000,$1,$2,900,$3,$4,1,$5,1,'c','T',$6)", [ZERO, A("d"), A("a"), A("b"), H, USER])
    assert.match(noContract ?? "", /invoices_real_deployment_check/)
    const noToken = await failure(db, "insert into invoices (chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by) values (1449000,$1,$2,901,$3,$4,1,$5,1,'c','T',$6)", [A("e"), ZERO, A("a"), A("b"), H, USER])
    assert.match(noToken ?? "", /invoices_real_deployment_check/)
    const fixture = await failure(db, "insert into invoices (chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by) values (0,$1,$1,902,$2,$3,1,$4,1,'c','T',$5)", [ZERO, A("a"), A("b"), H, USER])
    assert.equal(fixture, null)
  })

  it("the same on-chain id can exist on two deployments (dUSD and RLUSD), each isolated by its own contract", async () => {
    const dusd = "0x328fc0dbf3d1f704b065192f4bfc7583bfa550e0"
    const rlusd = "0x1b972ec6b1b5e0b592010e7484bef0accc382792"
    await insertInvoice("00000000-0000-4000-8000-0000000000d1", { contract: dusd, token: "0x5ff7b6ae08c37868303e7a815308af476421506c", invoiceId: 1 })
    await insertInvoice("00000000-0000-4000-8000-0000000000d2", { contract: rlusd, token: "0x27b57a9d0b8d24eb97259c4e2279e45255e016f3", invoiceId: 1 })
    const rows = await db.query<{ n: number }>("select count(*)::int as n from invoices where invoice_id = 1 and contract_address in ($1,$2)", [dusd, rlusd])
    assert.equal(rows.rows[0].n, 2)
    assert.match((await failure(db, "insert into invoices (chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by) values (1449000,$1,$2,1,$3,$4,1,$5,1,'c','T',$6)", [rlusd, A("d"), A("a"), A("b"), H, USER])) ?? "", /duplicate key|unique/i, "(chain, contract, id) stays unique")
  })

  it("the deployment index exists", async () => {
    const r = await db.query<{ indexname: string }>("select indexname from pg_indexes where tablename = 'invoices' and indexname = 'invoices_deployment_idx'")
    assert.equal(r.rows.length, 1)
  })
})

describe("migration 9: safe to apply to a database that already has rows", () => {
  it("is idempotent, and keeps rows that existed before it", async () => {
    const before = (await db.query<{ n: number }>("select count(*)::int as n from invoices")).rows[0].n
    const sql = fs.readFileSync(MIG, "utf8")
    await db.exec(sql) // second run
    await db.exec(sql) // third run
    const after = (await db.query<{ n: number }>("select count(*)::int as n from invoices")).rows[0].n
    assert.equal(after, before)
    assert.ok(before > 0)
  })

  it("applies cleanly on top of migrations 1-8 that already hold legacy data (old statuses and legacy action names)", async () => {
    const legacy = await (async () => {
      const { PGlite } = await import("@electric-sql/pglite")
      return new PGlite()
    })()
    try {
      // Build a database at migration 8 exactly like createDb(), then add legacy rows, then apply 9.
      const dir = path.resolve(process.cwd(), "supabase/migrations")
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
      const nine = files.pop()!
      assert.match(nine, /000009_dual_token_alignment/)
      const full = await createDb()
      await full.close()
      // createDb() already applied 9; replay on a fresh instance up to 8 using its bootstrap by reading helper source.
      const helper = fs.readFileSync(path.resolve(process.cwd(), "tests/helpers/db.ts"), "utf8")
      const bootstrap = /await db\.exec\(`([\s\S]*?)`\)/.exec(helper)![1]
      await legacy.exec(bootstrap)
      for (const f of files) await legacy.exec(fs.readFileSync(path.join(dir, f), "utf8"))
      await legacy.query("insert into auth.users (id, email) values ($1, 'u@t.invalid')", [USER])
      await legacy.query(
        `insert into invoices (chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
         values (1449000,$1,$2,7,$3,$4,1000,$5,1,'c','Legacy',$6,'Settled'), (0,$7,$7,8,$3,$4,1000,$5,1,'c','Fixture',$6,'Funded')`,
        [A("e"), A("d"), A("a"), A("b"), H, USER, ZERO]
      )
      await legacy.query("insert into transactions (chain_id, action, status, from_address) values (1449000,'approveWork','pending',$1), (1449000,'disputeInvoice','pending',$1)", [A("a")])
      await legacy.exec(fs.readFileSync(MIG, "utf8"))
      assert.equal((await legacy.query<{ n: number }>("select count(*)::int as n from invoices")).rows[0].n, 2)
      assert.equal((await legacy.query<{ n: number }>("select count(*)::int as n from transactions")).rows[0].n, 2)
      assert.equal((await legacy.query<{ s: string }>("select onchain_status as s from invoices where invoice_id = 7")).rows[0].s, "Settled")
      assert.equal(await failure(legacy, "update invoices set onchain_status = 'Cancelled' where invoice_id = 7"), null)
    } finally {
      await legacy.close()
    }
  })
})
