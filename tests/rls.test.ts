import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import type { PGlite } from "@electric-sql/pglite"
import { as, createDb, failure } from "./helpers/db"

let db: PGlite

const U = {
  client: "00000000-0000-0000-0000-00000000c001",
  freelancer: "00000000-0000-0000-0000-00000000f002",
  stranger: "00000000-0000-0000-0000-00000000a003",
  claimant: "00000000-0000-0000-0000-00000000b004", // unverified claim on the client's AND freelancer's wallets
  nowallet: "00000000-0000-0000-0000-00000000d005",
}
const W = {
  client: "0x" + "a".repeat(40),
  freelancer: "0x" + "b".repeat(40),
  stranger: "0x" + "c".repeat(40),
  otherFreelancer: "0x" + "d".repeat(40),
  contract: "0x" + "e".repeat(40),
}
const H = "0x" + "1".repeat(64)
const INV1 = "11111111-1111-1111-1111-111111111111" // client <-> freelancer
const INV2 = "22222222-2222-2222-2222-222222222222" // stranger <-> otherFreelancer (unrelated to INV1)
const SUB1 = "33333333-3333-3333-3333-333333333331"
const SUB2 = "33333333-3333-3333-3333-333333333332"
const EVAL1 = "44444444-4444-4444-4444-444444444441"
const EVAL2 = "44444444-4444-4444-4444-444444444442"
const TX1 = "55555555-5555-5555-5555-555555555551"
const TX2 = "55555555-5555-5555-5555-555555555552"
const TX_LOOSE = "55555555-5555-5555-5555-555555555553" // invoice-less tx sent from the client's wallet

const AUTHED = ["client", "freelancer", "stranger", "claimant", "nowallet"] as const
const TABLES = ["user_wallets", "wallet_challenges", "invoices", "invoice_criteria", "submissions", "evaluations", "advance_requests", "transactions"]

/** ids visible to `uid` in `table` (column `col`). */
async function visible(uid: string, table: string, col = "id"): Promise<string[]> {
  return as(db, "authenticated", uid, async () => {
    const r = await db.query<Record<string, string>>(`select ${col}::text as k from public.${table} order by 1`)
    return r.rows.map((x) => (x as unknown as { k: string }).k)
  })
}

before(async () => {
  db = await createDb()
  for (const [k, id] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `${k}@t.invalid`])
  // Verified wallets, plus an UNVERIFIED claimant on both parties' addresses.
  for (const [user, addr] of [[U.client, W.client], [U.freelancer, W.freelancer], [U.stranger, W.stranger]] as const) {
    await db.query("insert into user_wallets (user_id, address, verified_at, verification_method) values ($1, $2, now(), 'eip191')", [user, addr])
  }
  await db.query("insert into user_wallets (user_id, address) values ($1, $2), ($1, $3)", [U.claimant, W.client, W.freelancer])

  for (const [id, n, client, freelancer] of [[INV1, 1, W.client, W.freelancer], [INV2, 2, W.stranger, W.otherFreelancer]] as const) {
    await db.query(
      `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address,
         amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by)
       values ($1, 1440002, $2, $2, $3, $4, $5, 1000, $6, 1, 'canon', 'T', $7)`,
      [id, W.contract, n, client, freelancer, H, U.client]
    )
    await db.query("insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ($1, 0, 'c1', 'x', true)", [id])
  }
  for (const [sub, inv, addr, path] of [[SUB1, INV1, W.freelancer, "p1"], [SUB2, INV2, W.otherFreelancer, "p2"]] as const) {
    await db.query(
      "insert into submissions (id, invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type) values ($1,$2,$3,$4,$5,'e.pdf',10,'application/pdf')",
      [sub, inv, U.freelancer, addr, path]
    )
  }
  for (const [ev, sub, inv] of [[EVAL1, SUB1, INV1], [EVAL2, SUB2, INV2]] as const) {
    await db.query(
      `insert into evaluations (id, submission_id, invoice_uuid, criteria_hash, criteria_version, model, prompt_version, state, score, passed, criteria_results, summary, pass_rule, evaluated_at)
       values ($1,$2,$3,$4,1,'m','v','completed',90,true,'[]','s','r',now())`,
      [ev, sub, inv, H]
    )
  }
  for (const [tx, inv, from] of [[TX1, INV1, W.client], [TX2, INV2, W.stranger], [TX_LOOSE, null, W.client]] as const) {
    await db.query(
      "insert into transactions (id, invoice_uuid, chain_id, action, status, from_address) values ($1,$2,1440002,'depositReserve','pending',$3)",
      [tx, inv, from]
    )
  }
  await db.query(
    `insert into advance_requests (invoice_uuid, requester_user_id, requester_address, submission_id, evaluation_id, amount, idempotency_key)
     values ($1,$2,$3,$4,$5,900,'key-00000001')`,
    [INV1, U.freelancer, W.freelancer, SUB1, EVAL1]
  )
  await db.query("insert into wallet_challenges (nonce, address, message, expires_at) values ($1, $2, 'm', now() + interval '5 minutes')", ["n".repeat(32), W.client])
  // An evidence object as the server's signed-upload flow would leave it.
  await db.query("insert into storage.objects (bucket_id, name, owner) values ('evidence', $1, $2)", [`${INV1}/${U.freelancer}/seed.pdf`, U.freelancer])
})
after(async () => db.close())

describe("anonymous access", () => {
  for (const t of TABLES) {
    it(`anon cannot read ${t}`, async () => {
      const err = await as(db, "anon", null, () => failure(db, `select * from public.${t} limit 1`))
      assert.match(err ?? "NO ERROR", /permission denied/)
    })
  }
  it("anon cannot write anything", async () => {
    for (const t of TABLES) {
      const err = await as(db, "anon", null, () => failure(db, `delete from public.${t}`))
      assert.match(err ?? "NO ERROR", /permission denied/, t)
    }
  })
})

describe("read boundaries between wallets", () => {
  it("client and freelancer of an invoice see it; an unrelated wallet does not", async () => {
    assert.deepEqual(await visible(U.client, "invoices"), [INV1])
    assert.deepEqual(await visible(U.freelancer, "invoices"), [INV1])
    assert.deepEqual(await visible(U.stranger, "invoices"), [INV2])
    assert.ok(!(await visible(U.stranger, "invoices")).includes(INV1), "stranger must not see another party's invoice")
  })

  it("everything attached to an invoice is visible to its parties and hidden from unrelated wallets", async () => {
    for (const uid of [U.client, U.freelancer]) {
      assert.deepEqual(await visible(uid, "invoice_criteria", "invoice_uuid"), [INV1], `criteria for ${uid}`)
      assert.deepEqual(await visible(uid, "submissions"), [SUB1])
      assert.deepEqual(await visible(uid, "evaluations"), [EVAL1])
      assert.equal((await visible(uid, "advance_requests")).length, 1)
    }
    assert.deepEqual(await visible(U.stranger, "invoice_criteria", "invoice_uuid"), [INV2])
    assert.deepEqual(await visible(U.stranger, "submissions"), [SUB2])
    assert.deepEqual(await visible(U.stranger, "evaluations"), [EVAL2])
    assert.deepEqual(await visible(U.stranger, "advance_requests"), [])
  })

  it("transactions: parties see their invoice's rows; a wallet also sees its own invoice-less rows; strangers see neither", async () => {
    assert.deepEqual(await visible(U.client, "transactions"), [TX1, TX_LOOSE])
    assert.deepEqual(await visible(U.freelancer, "transactions"), [TX1])
    assert.deepEqual(await visible(U.stranger, "transactions"), [TX2])
  })

  it("an UNVERIFIED claim on a party's address grants nothing", async () => {
    for (const t of ["invoices", "invoice_criteria", "submissions", "evaluations", "advance_requests", "transactions"]) {
      assert.deepEqual(await visible(U.claimant, t, t === "invoice_criteria" ? "invoice_uuid" : "id"), [], `claimant sees ${t}`)
    }
  })

  it("a user with no wallet at all sees nothing", async () => {
    for (const t of ["invoices", "submissions", "evaluations", "advance_requests", "transactions"]) {
      assert.deepEqual(await visible(U.nowallet, t), [], t)
    }
  })

  it("verification is what grants access: the same claim starts working once the server verifies it", async () => {
    const u = "00000000-0000-0000-0000-00000000e006"
    await db.query("insert into auth.users (id, email) values ($1, 'late@t.invalid')", [u])
    const addr = "0x" + "9".repeat(40)
    await db.query("insert into user_wallets (user_id, address) values ($1, $2)", [u, addr])
    const inv = "66666666-6666-6666-6666-666666666666"
    await db.query(
      `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by)
       values ($1, 1440002, $2, $2, 3, $3, $4, 5, $5, 1, 'c', 'T', $6)`,
      [inv, W.contract, W.client, addr, H, U.client]
    )
    assert.deepEqual(await visible(u, "invoices"), [], "unverified: nothing")
    await as(db, "service_role", null, () => db.query("select public.bind_verified_wallet($1, $2, $3, 'eip191')", [u, addr, "n".repeat(32)]))
    assert.deepEqual(await visible(u, "invoices"), [inv], "verified: sees the invoice where it is the freelancer")
  })

  it("user_wallets: each user sees only their own rows (verified or not), never anyone else's", async () => {
    assert.deepEqual(await visible(U.client, "user_wallets", "address"), [W.client])
    assert.deepEqual(await visible(U.freelancer, "user_wallets", "address"), [W.freelancer])
    assert.deepEqual(await visible(U.claimant, "user_wallets", "address"), [W.client, W.freelancer].sort())
    assert.deepEqual(await visible(U.nowallet, "user_wallets", "address"), [])
  })

  it("wallet_challenges is unreadable by browsers", async () => {
    for (const uid of Object.values(U)) {
      const err = await as(db, "authenticated", uid, () => failure(db, "select * from public.wallet_challenges"))
      assert.match(err ?? "NO ERROR", /permission denied/)
    }
  })
})

describe("browsers cannot write (all financial and evaluation records are server-controlled)", () => {
  const writes: Array<[string, string]> = [
    ["insert invoice", `insert into invoices (chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by) values (1, '${W.contract}', '${W.contract}', 99, '${W.client}', '${W.freelancer}', 1, '${H}', 1, 'c', 'x', '${U.client}')`],
    ["update invoice", "update invoices set title = 'hacked'"],
    ["update invoice cache status", "update invoices set onchain_status = 'Settled'"],
    ["delete invoice", "delete from invoices"],
    ["insert criterion", `insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ('${INV1}', 0, 'z', 'z', false)`],
    ["update criterion", "update invoice_criteria set text = 'easier'"],
    ["delete criterion", "delete from invoice_criteria"],
    ["insert submission", `insert into submissions (invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type) values ('${INV1}', '${U.freelancer}', '${W.freelancer}', 'x', 'e', 1, 'text/plain')`],
    ["update submission", "update submissions set note = 'x'"],
    ["insert evaluation (fake pass)", `insert into evaluations (submission_id, invoice_uuid, criteria_hash, criteria_version, model, prompt_version, state, score, passed, criteria_results, summary, pass_rule, evaluated_at) values ('${SUB1}', '${INV1}', '${H}', 1, 'm', 'v', 'completed', 100, true, '[]', 's', 'r', now())`],
    ["update evaluation", "update evaluations set passed = true, score = 100"],
    ["delete evaluation", "delete from evaluations"],
    ["insert advance request", `insert into advance_requests (invoice_uuid, requester_user_id, requester_address, submission_id, evaluation_id, amount, idempotency_key) values ('${INV1}', '${U.freelancer}', '${W.freelancer}', '${SUB1}', '${EVAL1}', 900, 'key-00000099')`],
    ["update advance request status", "update advance_requests set status = 'paid'"],
    ["insert transaction (fake confirmed)", "insert into transactions (chain_id, action, status, from_address) values (1, 'approveAdvance', 'pending', '" + W.client + "')"],
    ["update transaction", "update transactions set status = 'failed'"],
    ["delete transaction", "delete from transactions"],
    ["self-bind a verified wallet", `insert into user_wallets (user_id, address, verified_at, verification_method) values ('${U.nowallet}', '${W.stranger}', now(), 'eip191')`],
    ["self-verify an existing claim", "update user_wallets set verified_at = now(), verification_method = 'eip191'"],
    ["delete wallet row", "delete from user_wallets"],
    ["mint a challenge", "insert into wallet_challenges (nonce, address, message, expires_at) values ('" + "q".repeat(32) + "', '" + W.client + "', 'm', now() + interval '1 minute')"],
  ]
  for (const uid of AUTHED) {
    it(`authenticated user '${uid}' is denied every write`, async () => {
      for (const [label, sql] of writes) {
        const err = await as(db, "authenticated", U[uid], () => failure(db, sql))
        assert.match(err ?? `NO ERROR (allowed!): ${label}`, /permission denied/, `${uid}: ${label}`)
      }
    })
  }
  it("nothing changed after all those attempts", async () => {
    const r = await db.query<{ t: string; ev: boolean; s: string; n: number }>(
      "select (select title from invoices where id=$1) t, (select passed from evaluations where id=$2) ev, (select status from advance_requests limit 1) s, (select count(*)::int from invoices) n",
      [INV1, EVAL1]
    )
    assert.deepEqual(r.rows[0], { t: "T", ev: true, s: "pending", n: 3 })
  })
})

describe("privileges on helpers", () => {
  it("the private helper schema and its functions are not usable by anon", async () => {
    const err = await as(db, "anon", null, () => failure(db, "select private.my_verified_addresses()"))
    assert.match(err ?? "NO ERROR", /permission denied/)
  })
  it("no public-schema function is executable by anon or authenticated (wallet functions are service-role only)", async () => {
    const r = await db.query<{ proname: string; a: boolean; u: boolean; s: boolean }>(
      `select p.proname, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u,
              has_function_privilege('service_role', p.oid, 'execute') s
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`
    )
    assert.ok(r.rows.length >= 4)
    for (const f of r.rows) assert.equal(f.a || f.u, false, `${f.proname} must not be executable by anon/authenticated`)
    for (const n of ["create_wallet_challenge", "consume_wallet_challenge", "find_verified_wallet_owner", "bind_verified_wallet"]) {
      assert.equal(r.rows.find((f) => f.proname === n)?.s, true, `${n} must be executable by service_role`)
    }
  })
  it("RLS is enabled and forced on every table and policies exist only for SELECT", async () => {
    const t = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r'"
    )
    assert.equal(t.rows.length, 8)
    for (const r of t.rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, r.relname)
    const p = await db.query<{ cmd: string }>("select distinct cmd from pg_policies where schemaname = 'public'")
    assert.deepEqual(p.rows.map((x) => x.cmd), ["SELECT"])
  })
})

describe("evidence storage", () => {
  const insert = async (uid: string, name: string, bucket = "evidence") =>
    as(db, "authenticated", uid, async () => {
      try {
        await db.query("insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [bucket, name, uid])
        return null
      } catch (e) {
        return (e as Error).message
      }
    })

  it("the bucket is private with a size limit and allow-listed types", async () => {
    const r = await db.query<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }>("select public, file_size_limit, allowed_mime_types from storage.buckets where id='evidence'")
    assert.equal(r.rows[0].public, false)
    assert.equal(Number(r.rows[0].file_size_limit), 26214400)
    assert.ok(r.rows[0].allowed_mime_types.includes("application/pdf") && !r.rows[0].allowed_mime_types.includes("text/html"))
  })

  it("browsers cannot create evidence objects directly, not even the invoice's own freelancer (uploads use server-minted signed URLs)", async () => {
    const names = [
      [U.freelancer, `${INV1}/${U.freelancer}/e.pdf`],
      [U.freelancer, `${INV1}/${U.client}/e.pdf`],
      [U.client, `${INV1}/${U.client}/e.pdf`],
      [U.stranger, `${INV1}/${U.stranger}/e.pdf`],
      [U.claimant, `${INV1}/${U.claimant}/e.pdf`],
      [U.nowallet, `${INV1}/${U.nowallet}/e.pdf`],
      [U.freelancer, `${INV2}/${U.freelancer}/e.pdf`],
      [U.freelancer, `${INV1}/${U.freelancer}/sub/e.pdf`],
      [U.freelancer, "e.pdf"],
    ] as const
    for (const [uid, name] of names) {
      assert.match((await insert(uid, name)) ?? `NO ERROR (allowed!): ${uid} ${name}`, /row-level security/, `${uid} -> ${name}`)
    }
    assert.match((await insert(U.freelancer, `${INV1}/${U.freelancer}/e.pdf`, "public")) ?? "NO ERROR", /row-level security/, "other bucket")
    const policies = await db.query<{ policyname: string }>("select policyname from pg_policies where schemaname='storage' order by 1")
    assert.deepEqual(policies.rows.map((p) => p.policyname), ["evidence_select_party"])
  })

  it("only the invoice's parties can read evidence", async () => {
    const count = (uid: string) =>
      as(db, "authenticated", uid, async () => (await db.query<{ c: number }>("select count(*)::int c from storage.objects where bucket_id='evidence'")).rows[0].c)
    assert.equal(await count(U.client), 1)
    assert.equal(await count(U.freelancer), 1)
    assert.equal(await count(U.stranger), 0)
    assert.equal(await count(U.claimant), 0)
    assert.equal(await count(U.nowallet), 0)
  })

  it("evidence is write-once: nobody can overwrite or delete it", async () => {
    for (const uid of [U.freelancer, U.client]) {
      const changed = await as(db, "authenticated", uid, async () => {
        const u = await db.query("update storage.objects set name = name || 'x' where bucket_id = 'evidence'")
        const d = await db.query("delete from storage.objects where bucket_id = 'evidence'")
        return (u.affectedRows ?? 0) + (d.affectedRows ?? 0)
      })
      assert.equal(changed, 0, `${uid} must not change objects`)
    }
    const left = await db.query<{ c: number }>("select count(*)::int c from storage.objects where bucket_id='evidence'")
    assert.equal(left.rows[0].c, 1)
  })

  it("anon cannot touch storage objects", async () => {
    const err = await as(db, "anon", null, () => failure(db, "select * from storage.objects"))
    assert.match(err ?? "NO ERROR", /permission denied/)
  })
})
