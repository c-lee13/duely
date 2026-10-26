import { after, before, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import type { PGlite } from "@electric-sql/pglite"
import { createDb } from "./helpers/db"
import { Clock, FakeChain, FakeObjectStore, createPgEvidenceDb } from "./helpers/evidence"
import { ctx, createPgBackendDb, FakeChainAdapter, FakeSigner, http, ScriptedEvaluator , TEST_SCOPE } from "./helpers/backend"
import { handleSubmissionPost } from "@/lib/evidence/submissions-http"
import { EvidenceError, mapSubmissionInsertError, type EvidenceDeps } from "@/lib/evidence/service"
import { handleAdvance, handleEvaluate, handleGetInvoice } from "@/lib/backend/handlers"
import type { BackendDeps } from "@/lib/backend/ports"
import { createGeminiEvaluator } from "@/lib/ai/evaluation-service"
import { GITHUB_DECLARATION_FILE_NAME, GITHUB_DECLARATION_KIND, serializeGithubDeclaration } from "@/lib/ai/github-declaration"
import { validateGithubSubmission } from "@/lib/ai/github-submission"
import { buildEvidencePath } from "@/lib/evidence/policy"

/** GitHub and Gemini are mocked; the real network is trapped. The database is a local Postgres with the real migrations. */
const realFetch = globalThis.fetch
before(() => {
  globalThis.fetch = (() => {
    throw new Error("a test tried to use the network")
  }) as never
})
after(() => {
  globalThis.fetch = realFetch
})

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const U = { freelancer: id(1), client: id(2), stranger: id(3) }
const W = { freelancer: "0x" + "b".repeat(40), client: "0x" + "a".repeat(40), stranger: "0x" + "c".repeat(40), contract: "0x" + "e".repeat(40), token: "0x" + "d".repeat(40) }
const H = "0x" + "1".repeat(64)
const INV = id(401)
const SHA = "a".repeat(40)
const TREE = "b".repeat(40)
const CANON = "https://github.com/acme/widgets"
const MODEL = "gemini-test-model"

// ---- mock GitHub ----------------------------------------------------------------------------------------------------
type Reply = { status?: number; body?: unknown; raw?: string; throws?: boolean }
interface GitHubState { repo: Reply; commit: Reply; tree: Reply; files: Record<string, Reply> }
const SOURCES: Record<string, string> = {
  "src/hero.tsx": "export const Hero = () => (\n  <h1>Plants, delivered weekly</h1>\n)\n",
  "src/features.tsx": "export const Features = () => (\n  <ul><li>Fresh every week</li></ul>\n)\n",
  "src/contact.tsx": 'export const Contact = () => (\n  <form><input name="email" /></form>\n)\n',
}
const fileBody = (path: string, text: string) => ({ type: "file", path, size: Buffer.byteLength(text), encoding: "base64", content: Buffer.from(text).toString("base64") })
const freshGitHub = (): GitHubState => ({
  repo: { body: { full_name: "acme/widgets", private: false, default_branch: "main" } },
  commit: { body: { sha: SHA, tree: { sha: TREE } } },
  tree: { body: { truncated: false, tree: Object.keys(SOURCES).map((p) => ({ path: p, type: "blob", size: SOURCES[p].length })) } },
  files: Object.fromEntries(Object.entries(SOURCES).map(([p, t]) => [p, { body: fileBody(p, t) }])),
})
let gh: GitHubState
let ghCalls: string[]
const ghFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input))
  ghCalls.push(String(input))
  const p = decodeURIComponent(url.pathname)
  let r: Reply | undefined
  if (p === "/repos/acme/widgets") r = gh.repo
  else if (p === `/repos/acme/widgets/git/commits/${SHA}`) r = gh.commit
  else if (p === `/repos/acme/widgets/git/trees/${TREE}`) r = gh.tree
  else if (p.startsWith("/repos/acme/widgets/contents/")) r = gh.files[p.replace("/repos/acme/widgets/contents/", "")]
  if (!r) return new Response("{}", { status: 404 })
  if (r.throws) throw new TypeError("fetch failed")
  return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200 })
}) as unknown as typeof fetch

const cite = (path: string, line: number, quote: string) => ({ path, start_line: line, end_line: line, quote })
const row = (rid: string, citations: unknown[]) => ({ id: rid, assessment: "verified", explanation: `${rid} done.`, missing_functionality: null, uncertainty: null, citations })
const codeRows = () => [
  row("c1", [cite("src/hero.tsx", 2, "Plants, delivered weekly")]),
  row("c2", [cite("src/features.tsx", 2, "Fresh every week")]),
  row("c3", [cite("src/contact.tsx", 2, '<input name="email" />')]),
]
const TEXT_EVIDENCE = `Hero section: a banner with headline "Plants, delivered weekly".\nFeatures section: three cards: Fresh every week.\nContact section: a form with name, email and message fields.\n`
const textRows = () => [
  { id: "c1", assessment: "verified", explanation: "x", evidence_quote: 'a banner with headline "Plants, delivered weekly"' },
  { id: "c2", assessment: "verified", explanation: "x", evidence_quote: "three cards: Fresh every week" },
  { id: "c3", assessment: "verified", explanation: "x", evidence_quote: "a form with name, email and message fields" },
]

let db: PGlite
let store: FakeObjectStore
let evDeps: EvidenceDeps
let deps: BackendDeps
let validatorCalls: Array<[string, string]>
let codePrompts: number
let textPrompts: number

before(async () => {
  db = await createDb()
  for (const [k, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, `${k}@t.invalid`])
  for (const [user, addr] of [[U.freelancer, W.freelancer], [U.client, W.client], [U.stranger, W.stranger]] as const) {
    await db.query("insert into user_wallets (user_id, address, verified_at, verification_method) values ($1,$2,now(),'eip191')", [user, addr])
  }
  await db.query(
    `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
     values ($1,1440002,$2,$3,1,$4,$5,1000,$6,3,'canon','Landing page',$7,'Funded')`,
    [INV, W.contract, W.token, W.client, W.freelancer, H, U.client]
  )
  await db.query(
    "insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ($1,0,'c1','Includes a hero section.',true), ($1,1,'c2','Includes a features section.',false), ($1,2,'c3','Includes a contact section.',true)",
    [INV]
  )
})
after(async () => db.close())

beforeEach(async () => {
  for (const t of ["advance_requests", "transactions", "evaluations", "submissions"]) {
    await db.query(`alter table ${t} disable trigger user`)
    await db.query(`delete from ${t}`)
    await db.query(`alter table ${t} enable trigger user`)
  }
  await db.query("update invoices set onchain_status = 'Funded' where id = $1", [INV]).catch(async () => {
    await db.query("alter table invoices disable trigger user")
    await db.query("update invoices set onchain_status = 'Funded' where id = $1", [INV])
    await db.query("alter table invoices enable trigger user")
  })
  store = new FakeObjectStore(new Clock())
  gh = freshGitHub()
  ghCalls = []
  validatorCalls = []
  codePrompts = 0
  textPrompts = 0
  evDeps = {
    scope: TEST_SCOPE,
    db: createPgEvidenceDb(db),
    objects: store,
    chain: new FakeChain(),
    requireChainVerification: false,
    github: async (url, sha) => {
      validatorCalls.push([url, sha])
      return validateGithubSubmission(url, sha, { fetch: ghFetch })
    },
  }
  const chain = new FakeChainAdapter()
  chain.available = false
  deps = {
    scope: TEST_SCOPE,
    db: createPgBackendDb(db),
    objects: store,
    chain,
    signer: new FakeSigner(),
    evaluator: createGeminiEvaluator({
      model: MODEL,
      generate: async () => {
        textPrompts++
        return JSON.stringify({ assessments: textRows() })
      },
      github: {
        fetch: ghFetch,
        generate: async () => {
          codePrompts++
          return JSON.stringify({ assessments: codeRows() })
        },
      },
    }),
  }
})

const post = async (user: string | null, body: unknown, opts: { origin?: string | null } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (opts.origin !== null) headers.origin = opts.origin ?? "http://localhost:3000"
  const res = await handleSubmissionPost(new Request("http://localhost:3000/api/submissions", { method: "POST", headers, body: JSON.stringify(body) }), { userId: async () => user, deps: () => evDeps })
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}
const githubBody = (over: Record<string, unknown> = {}) => ({ type: "github", invoiceId: INV, repositoryUrl: CANON, commitSha: SHA, ...over })
const code = (r: { json: Record<string, unknown> | null }) => (r.json?.error as { code: string }).code
const count = async (t: string, where = "true") => (await db.query<{ c: number }>(`select count(*)::int c from ${t} where ${where}`)).rows[0].c
const subRows = async () => (await db.query<Record<string, unknown>>("select * from submissions order by created_at")).rows
const evaluate = (user: string | null, submissionId: string) => http(handleEvaluate, ctx(user, deps), { body: { submissionId } })

describe("POST /api/submissions: GitHub submissions", () => {
  it("validates, canonicalises, and stores the repository and commit in the new columns; the user uploads nothing", async () => {
    const r = await post(U.freelancer, githubBody({ repositoryUrl: "https://github.com/acme/widgets/", commitSha: SHA.toUpperCase().replace(/A/g, "A") }))
    // the URL spelling above is non-canonical (trailing slash): the validator accepts it, the database stores the canonical form
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.equal(r.json?.repositoryUrl, CANON)
    assert.equal(r.json?.commitSha, SHA)
    assert.equal(r.json?.fileName, GITHUB_DECLARATION_FILE_NAME)
    assert.equal(r.json?.mimeType, "text/plain")
    assert.equal(r.json?.duplicate, false)
    const [s] = await subRows()
    assert.equal(s.repository_url, CANON)
    assert.equal(s.commit_sha, SHA)
    assert.equal(s.freelancer_user_id, U.freelancer)
    assert.equal(s.freelancer_address, W.freelancer)
    assert.equal(s.mime_type, "text/plain")
    assert.equal(s.funding_verified_onchain, false)
  })

  it("the server writes the canonical declaration object itself, under a path it generated", async () => {
    await post(U.freelancer, githubBody())
    assert.equal(store.puts.length, 1)
    const [put] = store.puts
    assert.match(put.path, new RegExp(`^${INV}/${U.freelancer}/[0-9a-f-]{36}\\.txt$`))
    assert.equal(put.mime, "text/plain")
    const bytes = store.objects.get(put.path)!.bytes
    assert.equal(new TextDecoder().decode(bytes), serializeGithubDeclaration(CANON, SHA))
    assert.equal(JSON.parse(new TextDecoder().decode(bytes)).kind, GITHUB_DECLARATION_KIND)
    assert.equal((await subRows())[0].file_size, bytes.length)
  })

  it("contacts GitHub for metadata only: never file contents", async () => {
    await post(U.freelancer, githubBody())
    assert.equal(validatorCalls.length, 1)
    assert.ok(ghCalls.length >= 3)
    for (const c of ghCalls) assert.doesNotMatch(c, /\/contents\/|zipball|tarball|archive|raw\.githubusercontent/)
  })

  it("normalises spellings and the SHA's case before storing", async () => {
    const r = await post(U.freelancer, githubBody({ repositoryUrl: " https://www.github.com/acme/widgets.git ", commitSha: ` ${SHA.toUpperCase()} ` }))
    assert.equal(r.status, 201, JSON.stringify(r.json))
    const [s] = await subRows()
    assert.equal(s.repository_url, CANON)
    assert.equal(s.commit_sha, SHA)
  })

  it("a retry of the same request returns the same submission (200, duplicate) and creates nothing", async () => {
    const first = await post(U.freelancer, githubBody())
    const again = await post(U.freelancer, githubBody())
    assert.equal(again.status, 200)
    assert.equal(again.json?.duplicate, true)
    assert.equal(again.json?.submissionId, first.json?.submissionId)
    assert.equal(await count("submissions"), 1)
    assert.equal(store.puts.length, 1)
  })

  it("a different commit makes a new latest submission", async () => {
    await post(U.freelancer, githubBody())
    const sha2 = "c".repeat(40)
    const orig = gh.commit
    gh.commit = { body: { sha: sha2, tree: { sha: TREE } } }
    // route the second commit through the mock by swapping the expected sha path
    const savedFetch = evDeps.github
    evDeps.github = (url, sha) => validateGithubSubmission(url, sha, { fetch: (async (i: string | URL | Request) => ghFetch(String(i).replace(sha2, SHA))) as typeof fetch })
    const r = await post(U.freelancer, githubBody({ commitSha: sha2 }))
    evDeps.github = savedFetch
    gh.commit = orig
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.equal(await count("submissions"), 2)
  })

  it("an optional note is stored (trimmed, capped)", async () => {
    await post(U.freelancer, githubBody({ note: "  main branch tip  " }))
    assert.equal((await subRows())[0].note, "main branch tip")
  })
})

describe("input shape is explicit", () => {
  it("rejects GitHub fields mixed with a file, a file body with GitHub fields, and unknown fields", async () => {
    const path = buildEvidencePath({ invoiceId: INV, userId: U.freelancer, objectId: id(9100), ext: "txt" })
    const bad = [
      githubBody({ storagePath: path }),
      githubBody({ fileName: "x.txt" }),
      githubBody({ score: 100 }),
      githubBody({ type: "git" }),
      githubBody({ repositoryUrl: undefined }),
      githubBody({ commitSha: undefined }),
      githubBody({ repositoryUrl: "" }),
      githubBody({ commitSha: 12 }),
      githubBody({ invoiceId: "nope" }),
      { invoiceId: INV, storagePath: path, repositoryUrl: CANON },
      { invoiceId: INV, storagePath: path, commitSha: SHA },
      { invoiceId: INV, storagePath: path, type: "github" },
      { invoiceId: INV },
      {},
    ]
    for (const b of bad) {
      const r = await post(U.freelancer, b)
      assert.equal(r.status, 400, JSON.stringify(b))
    }
    assert.equal(validatorCalls.length, 0)
    assert.equal(await count("submissions"), 0)
  })

  it("rejects a cross-origin POST", async () => {
    assert.equal((await post(U.freelancer, githubBody(), { origin: "https://evil.example" })).status, 403)
    assert.equal((await post(U.freelancer, githubBody(), { origin: null })).status, 403)
    assert.equal(validatorCalls.length, 0)
  })

  it("invalid URL or SHA shapes -> 400 INVALID_INPUT, with no row and no object", async () => {
    for (const over of [{ repositoryUrl: "https://example.com/acme/widgets" }, { repositoryUrl: "https://github.com/acme" }, { commitSha: "main" }, { commitSha: "abc1234" }, { commitSha: "g".repeat(40) }]) {
      const r = await post(U.freelancer, githubBody(over))
      assert.equal(r.status, 400, JSON.stringify(over))
      assert.equal(code(r), "INVALID_INPUT")
    }
    assert.equal(await count("submissions"), 0)
    assert.equal(store.puts.length, 0)
    assert.equal(ghCalls.length, 0, "shape errors are caught before any GitHub request")
  })
})

describe("file and text submissions are preserved", () => {
  it("a file submission works exactly as before and reports null GitHub fields", async () => {
    const path = buildEvidencePath({ invoiceId: INV, userId: U.freelancer, objectId: id(9200), ext: "txt" })
    store.putRaw(path, new TextEncoder().encode(TEXT_EVIDENCE), "text/plain")
    const r = await post(U.freelancer, { invoiceId: INV, storagePath: path, fileName: "proof.txt" })
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.equal(r.json?.fileName, "proof.txt")
    assert.equal(r.json?.repositoryUrl, null)
    assert.equal(r.json?.commitSha, null)
    const [s] = await subRows()
    assert.equal(s.repository_url, null)
    assert.equal(s.commit_sha, null)
    assert.equal(validatorCalls.length, 0)
    // explicit file type is accepted too
    const path2 = buildEvidencePath({ invoiceId: INV, userId: U.freelancer, objectId: id(9201), ext: "txt" })
    store.putRaw(path2, new TextEncoder().encode(TEXT_EVIDENCE), "text/plain")
    assert.equal((await post(U.freelancer, { type: "file", invoiceId: INV, storagePath: path2 })).status, 201)
    // and a retry is idempotent
    assert.equal((await post(U.freelancer, { invoiceId: INV, storagePath: path, fileName: "proof.txt" })).json?.duplicate, true)
  })
})

describe("scripted-demo auto-evaluation inside POST /api/submissions", () => {
  const postWith = async (autoEvaluate: (u: string | null, id: string) => Promise<unknown | null>, body: unknown) => {
    const res = await handleSubmissionPost(
      new Request("http://localhost:3000/api/submissions", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify(body) }),
      { userId: async () => U.freelancer, deps: () => evDeps, autoEvaluate }
    )
    return { status: res.status, json: (await res.json()) as Record<string, unknown> }
  }
  const filePath = (n: number) => {
    const path = buildEvidencePath({ invoiceId: INV, userId: U.freelancer, objectId: id(n), ext: "txt" })
    store.putRaw(path, new TextEncoder().encode(TEXT_EVIDENCE), "text/plain")
    return path
  }

  it("saves the submission and returns the persisted evaluation in the same response, in one call", async () => {
    const r = await postWith(
      async (userId, submissionId) => (await http(handleEvaluate, ctx(userId, deps), { body: { submissionId } })).json,
      { invoiceId: INV, storagePath: filePath(9300), fileName: "proof.txt" }
    )
    assert.equal(r.status, 201, JSON.stringify(r.json))
    const ev = r.json.evaluation as { submissionId: string; evaluationId: string }
    assert.equal(ev.submissionId, r.json.submissionId)
    assert.equal(await count("evaluations", "state = 'completed'"), 1) // persisted, so /api/advances can rely on it
  })

  it("never fails the submission when the evaluation can't be produced", async () => {
    const r = await postWith(async () => { throw new Error("boom") }, { invoiceId: INV, storagePath: filePath(9301), fileName: "proof.txt" })
    assert.equal(r.status, 201)
    assert.equal(r.json.evaluation, undefined)
    assert.equal(await count("submissions"), 1)
  })

  it("is not used for GitHub submissions", async () => {
    let called = 0
    const r = await postWith(async () => (called++, {}), githubBody())
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.equal(called, 0)
  })
})

describe("authentication, ownership and invoice state come before any GitHub call", () => {
  const nothingHappened = async () => {
    assert.equal(validatorCalls.length, 0)
    assert.equal(ghCalls.length, 0)
    assert.equal(store.puts.length, 0)
    assert.equal(await count("submissions"), 0)
  }

  it("signed out -> 401; client -> 403; stranger -> 404", async () => {
    assert.equal((await post(null, githubBody())).status, 401)
    assert.equal((await post(U.client, githubBody())).status, 403)
    assert.equal((await post(U.stranger, githubBody())).status, 404)
    assert.equal((await post(U.freelancer, githubBody({ invoiceId: id(9999) }))).status, 404)
    await nothingHappened()
  })

  it("an invoice that is not funded or is closed -> 409", async () => {
    await db.query("alter table invoices disable trigger user")
    try {
      await db.query("update invoices set onchain_status = 'Created' where id = $1", [INV])
      const created = await post(U.freelancer, githubBody())
      assert.equal(created.status, 409)
      assert.equal(code(created), "NOT_FUNDED")
      await db.query("update invoices set onchain_status = 'Disputed' where id = $1", [INV])
      const disputed = await post(U.freelancer, githubBody())
      assert.equal(disputed.status, 409)
      assert.equal(code(disputed), "INVOICE_CLOSED")
      await db.query("update invoices set onchain_status = 'Settled' where id = $1", [INV])
      assert.equal((await post(U.freelancer, githubBody())).status, 409)
    } finally {
      await db.query("update invoices set onchain_status = 'Funded' where id = $1", [INV])
      await db.query("alter table invoices enable trigger user")
    }
    await nothingHappened()
  })

  it("chain verification required but unavailable -> 503, nothing contacted", async () => {
    evDeps.requireChainVerification = true
    const r = await post(U.freelancer, githubBody())
    assert.equal(r.status, 503)
    await nothingHappened()
  })

  it("the per-invoice submission limit applies", async () => {
    for (let i = 0; i < 10; i++) {
      await db.query(
        `insert into submissions (invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type) values ($1,$2,$3,$4,'a.txt',1,'text/plain')`,
        [INV, U.freelancer, W.freelancer, buildEvidencePath({ invoiceId: INV, userId: U.freelancer, objectId: id(9300 + i), ext: "txt" })]
      )
    }
    const r = await post(U.freelancer, githubBody())
    assert.equal(r.status, 409)
    assert.equal(code(r), "SUBMISSION_LIMIT")
    assert.equal(validatorCalls.length, 0)
  })

  it("GitHub support not configured -> 503, nothing contacted", async () => {
    evDeps = { ...evDeps, github: undefined }
    const r = await post(U.freelancer, githubBody())
    assert.equal(r.status, 503)
    assert.equal(code(r), "GITHUB_SUBMISSIONS_UNAVAILABLE")
    await nothingHappened()
  })
})

describe("GitHub failures leave nothing behind", () => {
  const rejected = async (status: number, errCode: string) => {
    const r = await post(U.freelancer, githubBody())
    assert.equal(r.status, status, JSON.stringify(r.json))
    assert.equal(code(r), errCode)
    assert.equal(await count("submissions"), 0)
    assert.equal(store.puts.length, 0)
  }

  it("repository not found, private, or commit missing -> 422 GITHUB_REJECTED", async () => {
    gh.repo = { status: 404 }
    await rejected(422, "GITHUB_REJECTED")
    gh = freshGitHub()
    gh.repo = { body: { full_name: "acme/widgets", private: true } }
    await rejected(422, "GITHUB_REJECTED")
    gh = freshGitHub()
    gh.commit = { status: 404 }
    await rejected(422, "GITHUB_REJECTED")
  })

  it("rate limit, outage or malformed responses -> 503 GITHUB_UNAVAILABLE", async () => {
    gh.repo = { status: 429 }
    await rejected(503, "GITHUB_UNAVAILABLE")
    gh = freshGitHub()
    gh.tree = { status: 500 }
    await rejected(503, "GITHUB_UNAVAILABLE")
    gh = freshGitHub()
    gh.commit = { throws: true }
    await rejected(503, "GITHUB_UNAVAILABLE")
    gh = freshGitHub()
    gh.repo = { raw: "<html>" }
    await rejected(503, "GITHUB_UNAVAILABLE")
  })

  it("a validator that throws -> 503", async () => {
    evDeps.github = async () => {
      throw new Error("boom SECRET-DETAIL")
    }
    const r = await post(U.freelancer, githubBody())
    assert.equal(r.status, 503)
    assert.doesNotMatch(JSON.stringify(r.json), /SECRET-DETAIL/)
  })

  it("if the database insert fails, the server-written object is removed", async () => {
    const realInsert = evDeps.db.insertSubmission
    evDeps.db.insertSubmission = async () => {
      throw new EvidenceError("CRITERIA_INCOMPLETE", "x")
    }
    const r = await post(U.freelancer, githubBody())
    evDeps.db.insertSubmission = realInsert
    assert.equal(r.status, 409)
    assert.equal(store.puts.length, 1)
    assert.equal(store.objects.size, 0, "no orphan object")
    assert.equal(await count("submissions"), 0)
  })

  it("if writing the object fails, no row is created", async () => {
    store.failPut = true
    const r = await post(U.freelancer, githubBody())
    assert.equal(r.status, 500)
    assert.equal(await count("submissions"), 0)
  })

  it("a database that has not had migration 9 applied reports a clear 503, not a 500", () => {
    for (const [c, m] of [["PGRST204", "Could not find the 'repository_url' column of 'submissions' in the schema cache"], ["42703", 'column "commit_sha" of relation "submissions" does not exist']] as const) {
      const e = mapSubmissionInsertError(c, m)
      assert.ok(e instanceof EvidenceError)
      assert.equal(e.code, "GITHUB_SUBMISSIONS_UNAVAILABLE")
      assert.equal(e.status, 503)
    }
    const check = mapSubmissionInsertError("23514", 'new row for relation "submissions" violates check constraint "submissions_commit_sha_format"')
    assert.ok(check instanceof EvidenceError && check.code === "INVALID_INPUT")
    assert.equal(mapSubmissionInsertError(undefined, "something else"), null)
  })
})

describe("submissions stay immutable and RLS is untouched", () => {
  it("the stored repository and commit cannot be changed afterwards", async () => {
    await post(U.freelancer, githubBody())
    for (const sql of ["update submissions set commit_sha = '" + "b".repeat(40) + "'", "update submissions set repository_url = 'https://github.com/evil/repo'", "update submissions set repository_url = null, commit_sha = null"]) {
      await assert.rejects(db.query(sql), /immutable|cannot be changed/)
    }
    assert.equal((await subRows())[0].commit_sha, SHA)
  })

  it("the invoice detail exposes the canonical values to its parties only", async () => {
    await post(U.freelancer, githubBody())
    const get = async (user: string | null) => {
      const res = await handleGetInvoice(new Request("http://localhost:3000/api/invoices/x"), ctx(user, deps), { id: INV })
      return { status: res.status, json: (await res.json()) as { submissions?: Array<Record<string, unknown>> } }
    }
    for (const who of [U.freelancer, U.client]) {
      const r = await get(who)
      assert.equal(r.status, 200)
      assert.equal(r.json.submissions?.[0].repositoryUrl, CANON)
      assert.equal(r.json.submissions?.[0].commitSha, SHA)
      assert.equal("storagePath" in (r.json.submissions?.[0] ?? {}), false, "storage paths are still never exposed")
    }
    assert.equal((await get(U.stranger)).status, 404)
    assert.equal((await get(null)).status, 401)
  })
})

describe("evaluation recognises stored GitHub metadata", () => {
  it("evaluates a submission created through the API, end to end, and persists the result", async () => {
    const sub = (await post(U.freelancer, githubBody())).json?.submissionId as string
    ghCalls = []
    const r = await evaluate(U.freelancer, sub)
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.equal(codePrompts, 1)
    assert.equal(textPrompts, 0)
    assert.equal(r.json?.passed, true)
    assert.equal(r.json?.promptVersion, "gemini-code-review-v1")
    const ev = (await db.query<Record<string, unknown>>("select * from evaluations where submission_id = $1", [sub])).rows[0]
    assert.equal(ev.state, "completed")
    assert.match(String(ev.summary), new RegExp(`acme/widgets@${SHA}`))
    const first = (ev.criteria_results as Array<Record<string, unknown>>)[0]
    assert.deepEqual(first.source, { kind: "github", repository: "acme/widgets", commitSha: SHA })
    assert.ok(Array.isArray(first.evidence) && (first.evidence as unknown[]).length === 1)
    for (const c of ghCalls.filter((u) => u.includes("/contents/"))) assert.equal(new URL(c).searchParams.get("ref"), SHA)
  })

  it("the stored columns are authoritative: the evidence file is not even read", async () => {
    const sub = (await post(U.freelancer, githubBody())).json?.submissionId as string
    const path = (await subRows())[0].storage_path as string
    store.objects.delete(path) // the declaration object is gone; evaluation must not depend on it
    const r = await evaluate(U.freelancer, sub)
    assert.equal(r.status, 201, JSON.stringify(r.json))
  })

  it("a conflicting evidence file cannot redirect the review to another repository", async () => {
    const sub = (await post(U.freelancer, githubBody())).json?.submissionId as string
    const path = (await subRows())[0].storage_path as string
    store.objects.set(path, { bytes: new TextEncoder().encode(serializeGithubDeclaration("https://github.com/evil/other", "d".repeat(40))), mime: "text/plain", size: 100 })
    ghCalls = []
    const r = await evaluate(U.freelancer, sub)
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.ok(ghCalls.length > 0 && ghCalls.every((c) => c.includes("/repos/acme/widgets")), "only the stored repository is contacted")
  })

  it("legacy declaration-file submissions (no stored columns) still work", async () => {
    const path = buildEvidencePath({ invoiceId: INV, userId: U.freelancer, objectId: id(9400), ext: "txt" })
    const bytes = new TextEncoder().encode(serializeGithubDeclaration(CANON, SHA))
    store.putRaw(path, bytes, "text/plain")
    const reg = await post(U.freelancer, { invoiceId: INV, storagePath: path, fileName: GITHUB_DECLARATION_FILE_NAME })
    assert.equal(reg.status, 201)
    assert.equal(reg.json?.repositoryUrl, null)
    const r = await evaluate(U.freelancer, reg.json?.submissionId as string)
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.equal(codePrompts, 1)
  })

  it("text evidence still goes to the text path and never to GitHub", async () => {
    const path = buildEvidencePath({ invoiceId: INV, userId: U.freelancer, objectId: id(9401), ext: "txt" })
    store.putRaw(path, new TextEncoder().encode(TEXT_EVIDENCE), "text/plain")
    const reg = await post(U.freelancer, { invoiceId: INV, storagePath: path, fileName: "proof.txt" })
    ghCalls = []
    const r = await evaluate(U.freelancer, reg.json?.submissionId as string)
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.equal(textPrompts, 1)
    assert.equal(codePrompts, 0)
    assert.equal(ghCalls.length, 0)
  })

  it("an incomplete source retrieval still can never Pass", async () => {
    const sub = (await post(U.freelancer, githubBody())).json?.submissionId as string
    gh.tree = { body: { ...(gh.tree.body as object), truncated: true } }
    const r = await evaluate(U.freelancer, sub)
    assert.equal(r.status, 201)
    assert.equal(r.json?.passed, false)
  })

  it("half-set GitHub details are refused, not guessed", async () => {
    const evaluator = deps.evaluator
    const out = evaluator.evaluate({
      invoiceId: INV,
      criteriaHash: H as never,
      criteriaVersion: 1,
      criteria: [{ id: "c1", text: "t", mandatory: true }],
      submission: { id: id(1), fileName: "x", mimeType: "text/plain", fileSize: 1, github: { repositoryUrl: CANON, commitSha: null } },
      evidence: new Uint8Array(0),
    })
    await assert.rejects(out, /incomplete/)
    assert.equal(ghCalls.length, 0)
  })

  it("the development (demo) evaluator refuses GitHub submissions instead of judging empty evidence", async () => {
    const sub = (await post(U.freelancer, githubBody())).json?.submissionId as string
    deps = { ...deps, evaluator: { mode: "demo", evaluate: async () => { throw new Error("must not run") } } }
    const r = await evaluate(U.freelancer, sub)
    assert.equal(r.status, 422)
    assert.equal(code(r), "EVIDENCE_NOT_EVALUABLE")
  })

  it("evaluation checks still run first: stranger, client and stale submissions never reach GitHub", async () => {
    const old = (await post(U.freelancer, githubBody())).json?.submissionId as string
    const path = buildEvidencePath({ invoiceId: INV, userId: U.freelancer, objectId: id(9500), ext: "txt" })
    store.putRaw(path, new TextEncoder().encode(TEXT_EVIDENCE), "text/plain")
    await new Promise((r) => setTimeout(r, 5))
    await post(U.freelancer, { invoiceId: INV, storagePath: path })
    ghCalls = []
    assert.equal((await evaluate(null, old)).status, 401)
    assert.equal((await evaluate(U.stranger, old)).status, 404)
    assert.equal((await evaluate(U.client, old)).status, 403)
    const stale = await evaluate(U.freelancer, old)
    assert.equal(stale.status, 409)
    assert.equal(code(stale), "STALE_SUBMISSION")
    assert.equal(ghCalls.length + codePrompts, 0)
  })
})

describe("payments and advance restrictions are untouched", () => {
  it("submitting and evaluating a GitHub repository creates no advance request or transaction and never touches the signer", async () => {
    const sub = (await post(U.freelancer, githubBody())).json?.submissionId as string
    const r = await evaluate(U.freelancer, sub)
    assert.equal(r.json?.passed, true)
    assert.equal(await count("advance_requests"), 0)
    assert.equal(await count("transactions"), 0)
    assert.equal((deps.signer as FakeSigner).calls, 0)
    assert.deepEqual((deps.chain as FakeChainAdapter).calls, { creation: 0, state: 0, reserve: 0, tx: 0, found: 0 })
    const adv = await http(handleAdvance, ctx(U.freelancer, deps), { body: { invoiceId: INV } })
    assert.equal(adv.status, 503, "an advance still needs its own request, a chain and a signer")
    assert.equal(await count("advance_requests"), 0)
  })

  it("a scripted evaluator that vetoes a pass still blocks it for GitHub submissions", async () => {
    const sub = (await post(U.freelancer, githubBody())).json?.submissionId as string
    const scripted = new ScriptedEvaluator()
    scripted.output = (i) => ({ model: "m", promptVersion: "v", simulated: false, score: 100, criteriaResults: i.criteria.map((c) => ({ criterion: c.text, passed: true, reason: "ok" })), summary: "ok", passBlocked: ["incomplete"] })
    deps = { ...deps, evaluator: scripted }
    const r = await evaluate(U.freelancer, sub)
    assert.equal(r.json?.passed, false)
    assert.equal(scripted.lastInput?.submission.github?.commitSha, SHA)
    assert.equal(scripted.lastInput?.evidence.length, 0)
  })
})

describe("isolation", () => {
  it("submission validation fetches and runs no repository code", () => {
    for (const f of ["lib/evidence/service.ts", "lib/evidence/submissions-http.ts", "lib/evidence/server.ts"]) {
      const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      assert.doesNotMatch(src, /child_process|\beval\(|new Function|(?<![.\w])exec(Sync|File)?\(|spawn|git clone|npm install|retrieveGithubSource|zipball|tarball/, f)
    }
  })

  it("the token is read only in server wiring and is never put in a response", () => {
    const svc = fs.readFileSync("lib/evidence/service.ts", "utf8")
    assert.doesNotMatch(svc, /GITHUB_TOKEN|process\.env/)
    assert.match(fs.readFileSync("lib/evidence/server.ts", "utf8"), /process\.env\.GITHUB_TOKEN/)
  })

  it("no frontend component, scoring, code-review or contract file changed to support this", () => {
    for (const f of ["lib/ai/scoring.ts", "lib/ai/code-review.ts", "lib/ai/code-review-scoring.ts"]) {
      assert.doesNotMatch(fs.readFileSync(f, "utf8"), /registerGithubSubmission|submissions-http/, f)
    }
  })
})
