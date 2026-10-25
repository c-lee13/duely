import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import type { PGlite } from "@electric-sql/pglite"
import { applyMigration, as, createDb, failure, migrationFiles } from "./helpers/db"

/**
 * Migration 9: nullable repository_url + commit_sha on submissions. Runs the REAL migrations on a local Postgres (PGlite)
 * with Supabase's roles and default grants imitated; nothing touches a remote project.
 */
const MIGRATION = "20261024000009_github_submissions.sql"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const U = { freelancer: id(1), client: id(2), stranger: id(3) }
const W = { freelancer: "0x" + "b".repeat(40), client: "0x" + "a".repeat(40), stranger: "0x" + "c".repeat(40), contract: "0x" + "e".repeat(40), token: "0x" + "d".repeat(40) }
const H = "0x" + "1".repeat(64)
const INV = id(401)
const SHA = "a".repeat(40)
const URL = "https://github.com/acme/widgets"

async function seedBase(db: PGlite) {
  for (const [k, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, `${k}@t.invalid`])
  for (const [user, addr] of [[U.freelancer, W.freelancer], [U.client, W.client], [U.stranger, W.stranger]] as const) {
    await db.query("insert into user_wallets (user_id, address, verified_at, verification_method) values ($1,$2,now(),'eip191')", [user, addr])
  }
  await db.query(
    `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
     values ($1,1440002,$2,$3,1,$4,$5,1000,$6,1,'canon','Code job',$7,'Funded')`,
    [INV, W.contract, W.token, W.client, W.freelancer, H, U.client]
  )
  await db.query("insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ($1,0,'c1','Builds a widget.',true)", [INV])
}

let n = 0
/** Inserts a submission as the service role; extra columns go in `extra`. Returns the error message or null. */
async function insertSubmission(db: PGlite, extra: Record<string, unknown> = {}, invoice = INV) {
  n++
  const cols: Record<string, unknown> = {
    id: id(5000 + n),
    invoice_uuid: invoice,
    freelancer_user_id: U.freelancer,
    freelancer_address: W.freelancer,
    storage_path: `${invoice}/${U.freelancer}/${id(9000 + n)}.txt`,
    file_name: "duely-github-submission.txt",
    file_size: 120,
    mime_type: "text/plain",
    ...extra,
  }
  const keys = Object.keys(cols)
  const err = await failure(db, `insert into submissions (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(cols))
  return { err, id: cols.id as string }
}

let db: PGlite
before(async () => {
  db = await createDb()
  await seedBase(db)
})
after(async () => db.close())

describe("migration 9 is additive", () => {
  it("is the next migration, in sequence, and only adds", () => {
    const files = migrationFiles()
    assert.equal(files.at(-1), MIGRATION)
    assert.equal(files.length, 9)
    const sql = fs.readFileSync(path.resolve("supabase/migrations", MIGRATION), "utf8").replace(/--.*$/gm, "")
    assert.doesNotMatch(sql, /\bdrop\s+(table|column|constraint|policy|trigger|function)\b|\btruncate\b|\bdelete\s+from\b|\bupdate\s+public\.|\balter\s+column\b|\brename\b|\bdisable\s+(trigger|row)/i)
    assert.doesNotMatch(sql, /\bgrant\b/i, "no new privileges are granted")
    assert.match(sql, /add column repository_url text,\s*add column commit_sha\s+text;/)
  })

  it("adds two nullable text columns with no default", async () => {
    const cols = (await db.query<{ column_name: string; is_nullable: string; data_type: string; column_default: string | null }>(
      "select column_name, is_nullable, data_type, column_default from information_schema.columns where table_schema='public' and table_name='submissions' and column_name in ('repository_url','commit_sha') order by column_name"
    )).rows
    assert.deepEqual(cols.map((c) => [c.column_name, c.is_nullable, c.data_type, c.column_default]), [
      ["commit_sha", "YES", "text", null],
      ["repository_url", "YES", "text", null],
    ])
  })

  it("preserves submissions that existed before the migration, unchanged and with NULL in the new columns", async () => {
    const legacy = await createDb("20261024000008_backend_api_support.sql")
    try {
      await seedBase(legacy)
      const first = await insertSubmission(legacy)
      assert.equal(first.err, null)
      await legacy.query("insert into submissions (id, invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type, note) values ($1,$2,$3,$4,$5,'report.md',2048,'text/markdown','my note')", [
        id(6001), INV, U.freelancer, W.freelancer, `${INV}/${U.freelancer}/${id(9500)}.md`,
      ])
      const before = (await legacy.query<Record<string, unknown>>("select * from submissions order by id")).rows
      assert.equal(before.length, 2)
      assert.ok(!("repository_url" in before[0]))

      await applyMigration(legacy, MIGRATION)

      const after = (await legacy.query<Record<string, unknown>>("select * from submissions order by id")).rows
      assert.equal(after.length, 2)
      for (let i = 0; i < 2; i++) {
        const { repository_url, commit_sha, ...rest } = after[i]
        assert.equal(repository_url, null)
        assert.equal(commit_sha, null)
        assert.deepEqual(rest, before[i], "every pre-existing column value is unchanged")
      }
    } finally {
      await legacy.close()
    }
  })

  it("file-based submissions are still accepted exactly as before (no GitHub fields)", async () => {
    const r = await insertSubmission(db)
    assert.equal(r.err, null)
    const row = (await db.query<{ repository_url: string | null; commit_sha: string | null }>("select repository_url, commit_sha from submissions where id = $1", [r.id])).rows[0]
    assert.deepEqual(row, { repository_url: null, commit_sha: null })
  })
})

describe("repository_url and commit_sha constraints", () => {
  const accepts = async (extra: Record<string, unknown>) => assert.equal((await insertSubmission(db, extra)).err, null, JSON.stringify(extra))
  const rejects = async (extra: Record<string, unknown>, constraint: string) => {
    const { err } = await insertSubmission(db, extra)
    assert.ok(err, `expected rejection: ${JSON.stringify(extra)}`)
    assert.match(err, new RegExp(constraint), JSON.stringify(extra))
  }

  it("accepts a canonical URL with a full lower-case SHA", async () => {
    await accepts({ repository_url: URL, commit_sha: SHA })
    await accepts({ repository_url: "https://github.com/a/b", commit_sha: "0123456789abcdef0123456789abcdef01234567" })
    await accepts({ repository_url: "https://github.com/some-org/repo.name_v2-x", commit_sha: SHA })
    await accepts({ repository_url: `https://github.com/${"o".repeat(39)}/${"r".repeat(100)}`, commit_sha: SHA })
    await accepts({ repository_url: "https://github.com/acme/.github", commit_sha: SHA })
  })

  it("rejects every non-canonical or non-GitHub repository URL", async () => {
    const bad = [
      "http://github.com/acme/widgets",
      "https://www.github.com/acme/widgets",
      "https://github.com/acme/widgets/",
      "https://github.com/acme/widgets.git",
      "https://github.com/acme/widgets.GIT",
      "https://github.com/acme/widgets/tree/main",
      "https://github.com/acme/widgets?tab=readme",
      "https://github.com/acme/widgets#readme",
      "https://github.com/acme/widgets\n",
      " https://github.com/acme/widgets",
      "https://github.com/acme/wid gets",
      "https://GITHUB.com/acme/widgets",
      "https://github.com.evil.com/acme/widgets",
      "https://evil.com/github.com/acme/widgets",
      "https://gitlab.com/acme/widgets",
      "https://user:pw@github.com/acme/widgets",
      "https://github.com:443/acme/widgets",
      "https://github.com/acme",
      "https://github.com/",
      "https://github.com//widgets",
      "https://github.com/-acme/widgets",
      `https://github.com/${"o".repeat(40)}/widgets`,
      `https://github.com/acme/${"r".repeat(101)}`,
      "https://github.com/acme/.",
      "https://github.com/acme/..",
      "https://github.com/acme/wïdgets",
      "git@github.com:acme/widgets.git",
      "github.com/acme/widgets",
      "",
    ]
    for (const repository_url of bad) await rejects({ repository_url, commit_sha: SHA }, "submissions_repository_url_format")
  })

  it("rejects every commit reference that is not a full lower-case 40-hex SHA", async () => {
    const bad = ["abc1234", "a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40), "main", "HEAD", "refs/heads/main", `${"a".repeat(39)}\n`, ` ${"a".repeat(39)}`, "", "a".repeat(64)]
    for (const commit_sha of bad) await rejects({ repository_url: URL, commit_sha }, "submissions_commit_sha_format")
  })

  it("requires both fields together, or neither", async () => {
    await rejects({ repository_url: URL }, "submissions_github_fields_together")
    await rejects({ commit_sha: SHA }, "submissions_github_fields_together")
    await accepts({ repository_url: null, commit_sha: null })
    await rejects({ repository_url: URL, commit_sha: null }, "submissions_github_fields_together")
    await rejects({ repository_url: null, commit_sha: SHA }, "submissions_github_fields_together")
  })

  it("existing constraints still apply to GitHub submissions", async () => {
    const gh = { repository_url: URL, commit_sha: SHA }
    assert.match((await insertSubmission(db, { ...gh, mime_type: "application/x-msdownload" })).err ?? "", /submissions_mime_type_allowed/)
    assert.match((await insertSubmission(db, { ...gh, file_size: 0 })).err ?? "", /file_size/)
    const dup = await insertSubmission(db, gh)
    assert.equal(dup.err, null)
    const same = await failure(db, "insert into submissions (id, invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type, repository_url, commit_sha) select $1, invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type, repository_url, commit_sha from submissions where id = $2", [id(7777), dup.id])
    assert.match(same ?? "", /storage_path/, "an object still backs only one submission")
  })

  it("the invoice's frozen-criteria guard still applies", async () => {
    const other = id(402)
    await db.query(
      `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
       values ($1,1440002,$2,$3,2,$4,$5,1000,$6,2,'canon','Incomplete',$7,'Funded')`,
      [other, W.contract, W.token, W.client, W.freelancer, "0x" + "2".repeat(64), U.client]
    )
    await db.query("insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ($1,0,'c1','One of two.',true)", [other])
    const { err } = await insertSubmission(db, { repository_url: URL, commit_sha: SHA }, other)
    assert.match(err ?? "", /criteria are incomplete/)
  })

  it("the submitter must still be the invoice's freelancer address", async () => {
    const { err } = await insertSubmission(db, { repository_url: URL, commit_sha: SHA, freelancer_address: W.stranger })
    assert.match(err ?? "", /foreign key|violates/i)
  })
})

describe("GitHub fields cannot be altered after the fact", () => {
  const github = async () => (await insertSubmission(db, { repository_url: URL, commit_sha: SHA })).id
  const row = async (sid: string) => (await db.query<Record<string, unknown>>("select repository_url, commit_sha, note from submissions where id = $1", [sid])).rows[0]

  it("rejects every UPDATE of repository_url or commit_sha: re-point, set late, clear", async () => {
    const withGithub = await github()
    const without = (await insertSubmission(db)).id
    const attempts: Array<[string, string, unknown[]]> = [
      ["re-point the commit", "update submissions set commit_sha = $2 where id = $1", [withGithub, "b".repeat(40)]],
      ["re-point the repository", "update submissions set repository_url = $2 where id = $1", [withGithub, "https://github.com/evil/widgets"]],
      ["clear both", "update submissions set repository_url = null, commit_sha = null where id = $1", [withGithub]],
      ["clear one", "update submissions set commit_sha = null where id = $1", [withGithub]],
      ["no-op rewrite", "update submissions set commit_sha = commit_sha where id = $1", [withGithub]],
      ["attach to a file submission", "update submissions set repository_url = $2, commit_sha = $3 where id = $1", [without, URL, SHA]],
    ]
    for (const [label, sql, params] of attempts) {
      const err = await failure(db, sql, params)
      assert.ok(err, `expected rejection: ${label}`)
      assert.match(err, /immutable|cannot be changed/, label)
    }
    assert.deepEqual(await row(withGithub), { repository_url: URL, commit_sha: SHA, note: "" })
    assert.deepEqual(await row(without), { repository_url: null, commit_sha: null, note: "" })
  })

  it("rows stay immutable and undeletable in general (existing rule intact)", async () => {
    const sid = await github()
    assert.match((await failure(db, "update submissions set note = 'x' where id = $1", [sid])) ?? "", /immutable/)
    assert.match((await failure(db, "delete from submissions where id = $1", [sid])) ?? "", /immutable/)
  })

  it("after an evaluation exists, the evidence cannot be re-pointed and the evaluation is unaffected", async () => {
    const sid = await github()
    await db.query(
      `insert into evaluations (submission_id, invoice_uuid, criteria_hash, criteria_version, model, prompt_version, pass_rule, state)
       values ($1,$2,$3,1,'m','p','rule','running')`,
      [sid, INV, H]
    )
    const evalBefore = (await db.query("select * from evaluations where submission_id = $1", [sid])).rows
    assert.ok(await failure(db, "update submissions set commit_sha = $2 where id = $1", [sid, "c".repeat(40)]))
    assert.ok(await failure(db, "update submissions set repository_url = $2 where id = $1", [sid, "https://github.com/other/repo"]))
    assert.deepEqual(await row(sid), { repository_url: URL, commit_sha: SHA, note: "" })
    assert.deepEqual((await db.query("select * from evaluations where submission_id = $1", [sid])).rows, evalBefore)
  })

  it("the dedicated column guard holds on its own, even if the general immutability trigger were relaxed", async () => {
    const sid = await github()
    await db.exec("alter table submissions disable trigger submissions_immutable")
    try {
      const err = await failure(db, "update submissions set commit_sha = $2 where id = $1", [sid, "d".repeat(40)])
      assert.match(err ?? "", /cannot be changed once a submission exists/)
      const err2 = await failure(db, "update submissions set repository_url = $2 where id = $1", [sid, "https://github.com/x/y"])
      assert.match(err2 ?? "", /cannot be changed once a submission exists/)
      // The guard is column-specific: with the general trigger relaxed, other columns are not its business.
      assert.equal(await failure(db, "update submissions set note = 'allowed here' where id = $1", [sid]), null)
      assert.deepEqual(await row(sid), { repository_url: URL, commit_sha: SHA, note: "allowed here" })
    } finally {
      await db.exec("alter table submissions enable trigger submissions_immutable")
    }
    assert.match((await failure(db, "update submissions set note = 'x' where id = $1", [sid])) ?? "", /immutable/)
  })

  it("the guard function is not callable by browser roles", async () => {
    for (const role of ["anon", "authenticated", "public"]) {
      const r = await db.query<{ ok: boolean }>("select has_function_privilege($1, 'public.submissions_github_fields_guard()', 'execute') ok", [role])
      assert.equal(r.rows[0].ok, false, role)
    }
  })
})

describe("RLS and ownership are unchanged", () => {
  let sid: string
  before(async () => {
    sid = (await insertSubmission(db, { repository_url: URL, commit_sha: SHA })).id
  })

  it("invoice parties can read the new columns; strangers and anon cannot", async () => {
    for (const [who, uid] of [["freelancer", U.freelancer], ["client", U.client]] as const) {
      const rows = await as(db, "authenticated", uid, async () => (await db.query<{ repository_url: string; commit_sha: string }>("select repository_url, commit_sha from submissions where id = $1", [sid])).rows)
      assert.deepEqual(rows, [{ repository_url: URL, commit_sha: SHA }], who)
    }
    const stranger = await as(db, "authenticated", U.stranger, async () => (await db.query("select repository_url from submissions where id = $1", [sid])).rows)
    assert.equal(stranger.length, 0)
    assert.ok(await as(db, "anon", null, () => failure(db, "select repository_url from submissions")))
  })

  it("browsers still cannot insert, update or delete submissions, with or without GitHub fields", async () => {
    for (const [uid, label] of [[U.freelancer, "freelancer"], [U.client, "client"], [U.stranger, "stranger"]] as const) {
      const ins = await as(db, "authenticated", uid, () =>
        failure(db, "insert into submissions (invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type, repository_url, commit_sha) values ($1,$2,$3,'p/q/r.txt','f',1,'text/plain',$4,$5)", [INV, uid, W.freelancer, URL, SHA])
      )
      assert.match(ins ?? "", /permission denied/i, `insert ${label}`)
      const upd = await as(db, "authenticated", uid, () => failure(db, "update submissions set commit_sha = $1 where id = $2", ["e".repeat(40), sid]))
      assert.match(upd ?? "", /permission denied/i, `update ${label}`)
      const del = await as(db, "authenticated", uid, () => failure(db, "delete from submissions where id = $1", [sid]))
      assert.match(del ?? "", /permission denied/i, `delete ${label}`)
    }
  })

  it("privileges and policies on submissions are exactly what they were: SELECT only, one party policy, RLS forced", async () => {
    const grants = (await db.query<{ grantee: string; privilege_type: string }>(
      "select grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='submissions' and grantee in ('anon','authenticated') order by 1,2"
    )).rows
    assert.deepEqual(grants, [{ grantee: "authenticated", privilege_type: "SELECT" }])
    const colGrants = (await db.query("select 1 from information_schema.column_privileges where table_schema='public' and table_name='submissions' and column_name in ('repository_url','commit_sha') and grantee in ('anon','authenticated') and privilege_type <> 'SELECT'")).rows
    assert.equal(colGrants.length, 0)
    const policies = (await db.query<{ policyname: string; cmd: string }>("select policyname, cmd from pg_policies where schemaname='public' and tablename='submissions'")).rows
    assert.deepEqual(policies, [{ policyname: "submissions_select_party", cmd: "SELECT" }])
    const rls = (await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.submissions'::regclass")).rows[0]
    assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true })
  })

  it("the submission → evaluation relationship is intact", async () => {
    const fks = (await db.query<{ conname: string }>("select conname from pg_constraint where conrelid = 'public.evaluations'::regclass and contype = 'f' order by conname")).rows.map((r) => r.conname)
    assert.ok(fks.length >= 2)
    const bad = await failure(db, "insert into evaluations (submission_id, invoice_uuid, criteria_hash, criteria_version, model, prompt_version, pass_rule) values ($1,$2,$3,1,'m','p','r')", [id(99999), INV, H])
    assert.match(bad ?? "", /foreign key|violates/i)
  })
})
