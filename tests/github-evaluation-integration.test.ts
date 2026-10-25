import { after, before, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import type { PGlite } from "@electric-sql/pglite"
import { createDb } from "./helpers/db"
import { Clock, FakeObjectStore } from "./helpers/evidence"
import { ctx, createPgBackendDb, FakeChainAdapter, FakeSigner, http, ScriptedEvaluator , TEST_SCOPE } from "./helpers/backend"
import { handleAdvance, handleEvaluate } from "@/lib/backend/handlers"
import type { BackendDeps } from "@/lib/backend/ports"
import { createGeminiEvaluator, createGeminiEvaluatorFromEnv, type GeminiLikeClient } from "@/lib/ai/evaluation-service"
import { CODE_REVIEW_PROMPT_VERSION } from "@/lib/ai/code-review"
import { GITHUB_DECLARATION_FILE_NAME, GITHUB_DECLARATION_KIND, parseGithubDeclaration } from "@/lib/ai/github-declaration"
import { PROMPT_VERSION, type GenerateFn } from "@/lib/ai/assessment"
import { buildEvidencePath } from "@/lib/evidence/policy"

/** Neither GitHub nor Gemini is ever reached: both are mocked, and the real network is trapped. */
const realFetch = globalThis.fetch
before(() => {
  globalThis.fetch = (() => {
    throw new Error("a test tried to use the network (a real GitHub or Gemini call?)")
  }) as never
})
after(() => {
  globalThis.fetch = realFetch
})

let db: PGlite
let store: FakeObjectStore
let deps: BackendDeps
let textPrompts: string[]
let codePrompts: string[]
let textReply: () => unknown
let codeReply: () => unknown | Promise<unknown>
let ghCalls: Array<{ url: string; auth: string | null }>
let gh: GitHubState

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const U = { freelancer: id(1), client: id(2), stranger: id(3) }
const W = { freelancer: "0x" + "b".repeat(40), client: "0x" + "a".repeat(40), stranger: "0x" + "c".repeat(40), contract: "0x" + "e".repeat(40), token: "0x" + "d".repeat(40) }
const H = "0x" + "1".repeat(64)
const INV = id(401)
const MODEL = "gemini-test-model"
const SHA = "a".repeat(40)
const TREE = "b".repeat(40)
const REPO_URL = "https://github.com/acme/widgets"

// ---- mock GitHub ----------------------------------------------------------------------------------------------------
type Reply = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string>; throws?: boolean }
interface GitHubState {
  repo: Reply
  commit: Reply
  tree: Reply
  files: Record<string, Reply>
}
const SOURCES: Record<string, string> = {
  "src/hero.tsx": "export const Hero = () => (\n  <h1>Plants, delivered weekly</h1>\n)\n",
  "src/features.tsx": "export const Features = () => (\n  <ul><li>Fresh every week</li></ul>\n)\n",
  "src/contact.tsx": 'export const Contact = () => (\n  <form><input name="email" /></form>\n)\n',
}
const fileBody = (path: string, text: string) => ({ type: "file", path, size: Buffer.byteLength(text), encoding: "base64", content: Buffer.from(text).toString("base64") })
const freshGitHub = (): GitHubState => ({
  repo: { body: { full_name: "acme/widgets", private: false, default_branch: "main" } },
  commit: { body: { sha: SHA, tree: { sha: TREE } } },
  tree: { body: { truncated: false, tree: Object.keys(SOURCES).map((p) => ({ path: p, type: "blob", size: SOURCES[p].length })).concat([{ path: "README.md", type: "blob", size: 5 }]) } },
  files: Object.fromEntries(Object.entries(SOURCES).map(([p, t]) => [p, { body: fileBody(p, t) }])),
})
const ghFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input))
  ghCalls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") })
  const p = decodeURIComponent(url.pathname)
  let r: Reply | undefined
  if (p === "/repos/acme/widgets") r = gh.repo
  else if (p === `/repos/acme/widgets/git/commits/${SHA}`) r = gh.commit
  else if (p === `/repos/acme/widgets/git/trees/${TREE}`) r = gh.tree
  else if (p.startsWith("/repos/acme/widgets/contents/")) r = gh.files[p.replace("/repos/acme/widgets/contents/", "")]
  if (!r) throw new Error(`unexpected GitHub request: ${url}`)
  if (r.throws) throw new TypeError("fetch failed")
  return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers })
}) as unknown as typeof fetch

// ---- mock Gemini ----------------------------------------------------------------------------------------------------
const TEXT_EVIDENCE = `Landing page for Brightleaf.
Hero section: a banner with headline "Plants, delivered weekly" and a green button.
Features section: three cards: Fresh every week, Pet-safe options, Skip or pause anytime.
Contact section: a form with name, email and message fields.
`
const textRows = () => [
  { id: "c1", assessment: "verified", explanation: "Hero shown.", evidence_quote: 'a banner with headline "Plants, delivered weekly"' },
  { id: "c2", assessment: "verified", explanation: "Features shown.", evidence_quote: "three cards: Fresh every week, Pet-safe options, Skip or pause anytime" },
  { id: "c3", assessment: "verified", explanation: "Contact shown.", evidence_quote: "a form with name, email and message fields" },
]
const cite = (path: string, line: number, quote: string) => ({ path, start_line: line, end_line: line, quote })
const codeRow = (rid: string, assessment: string, citations: unknown[], over: Record<string, unknown> = {}) => ({
  id: rid,
  assessment,
  explanation: `${rid} is implemented.`,
  missing_functionality: assessment === "verified" ? null : "Not implemented.",
  uncertainty: null,
  citations,
  ...over,
})
const codeRows = () => [
  codeRow("c1", "verified", [cite("src/hero.tsx", 2, "Plants, delivered weekly")]),
  codeRow("c2", "verified", [cite("src/features.tsx", 2, "Fresh every week")]),
  codeRow("c3", "verified", [cite("src/contact.tsx", 2, '<input name="email" />')]),
]

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

let seq = 0
async function seedSubmission(text: string, fileName: string, mime = "text/plain", fileSize?: number) {
  seq++
  const bytes = new TextEncoder().encode(text)
  const p = buildEvidencePath({ invoiceId: INV, userId: U.freelancer, objectId: id(9000 + seq), ext: mime === "text/markdown" ? "md" : "txt" })
  store.putRaw(p, bytes, mime)
  const sid = id(5000 + seq)
  await db.query(
    `insert into submissions (id, invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, timestamptz '2026-11-01 12:00:00+00' + ($9 || ' minutes')::interval)`,
    [sid, INV, U.freelancer, W.freelancer, p, fileName, fileSize ?? bytes.length, mime, String(seq)]
  )
  return sid
}
const declaration = (over: Record<string, unknown> = {}) => JSON.stringify({ kind: GITHUB_DECLARATION_KIND, repository_url: REPO_URL, commit_sha: SHA, ...over })
const seedGithub = (over: Record<string, unknown> = {}) => seedSubmission(declaration(over), GITHUB_DECLARATION_FILE_NAME)
const seedText = (text = TEXT_EVIDENCE) => seedSubmission(text, "proof")

const count = async (t: string, where = "true") => (await db.query<{ c: number }>(`select count(*)::int c from ${t} where ${where}`)).rows[0].c
const evaluate = (user: string | null, submissionId: string) => http(handleEvaluate, ctx(user, deps), { body: { submissionId } })
const code = (r: { json: Record<string, unknown> | null }) => (r.json?.error as { code: string }).code
const evalRows = async () => (await db.query<Record<string, unknown>>("select * from evaluations order by created_at")).rows
const externalCalls = () => ghCalls.length + codePrompts.length + textPrompts.length

beforeEach(async () => {
  for (const t of ["advance_requests", "transactions", "evaluations", "submissions"]) {
    await db.query(`alter table ${t} disable trigger user`)
    await db.query(`delete from ${t}`)
    await db.query(`alter table ${t} enable trigger user`)
  }
  store = new FakeObjectStore(new Clock())
  textPrompts = []
  codePrompts = []
  ghCalls = []
  gh = freshGitHub()
  textReply = () => ({ assessments: textRows() })
  codeReply = () => ({ assessments: codeRows() })
  const textGen: GenerateFn = async (prompt) => {
    textPrompts.push(prompt)
    return JSON.stringify(textReply())
  }
  const codeGen: GenerateFn = async (prompt) => {
    codePrompts.push(prompt)
    const r = await codeReply()
    return typeof r === "string" ? r : JSON.stringify(r)
  }
  const chain = new FakeChainAdapter()
  chain.available = false
  deps = {
    scope: TEST_SCOPE,
    db: createPgBackendDb(db),
    objects: store,
    chain,
    signer: new FakeSigner(),
    evaluator: createGeminiEvaluator({ generate: textGen, model: MODEL, github: { generate: codeGen, fetch: ghFetch } }),
  }
})

describe("explicit GitHub declaration (never inferred)", () => {
  const meta = { fileName: GITHUB_DECLARATION_FILE_NAME, mimeType: "text/plain", fileSize: 200 }
  const bytes = (s: string) => new TextEncoder().encode(s)

  it("parses the strict declaration file", () => {
    assert.deepEqual(parseGithubDeclaration(meta, bytes(declaration())), { kind: "github", repositoryUrl: REPO_URL, commitSha: SHA })
  })

  it("is 'none' for every other file, even one whose content is a valid declaration", () => {
    for (const fileName of ["proof", "proof.txt", "notes.md", "duely-github-submission.json", "Duely-GitHub-Submission.txt", "x/duely-github-submission.txt"]) {
      assert.deepEqual(parseGithubDeclaration({ ...meta, fileName }, bytes(declaration())), { kind: "none" }, fileName)
    }
    assert.deepEqual(parseGithubDeclaration({ fileName: "report.txt", mimeType: "text/plain", fileSize: 99 }, bytes(`See ${REPO_URL} at commit ${SHA}`)), { kind: "none" })
  })

  it("a file with the reserved name that is not exactly the declaration is invalid, never plain text", () => {
    const bad = [
      "not json",
      "",
      declaration({ extra: 1 }),
      declaration({ kind: "other" }),
      JSON.stringify({ kind: GITHUB_DECLARATION_KIND, repository_url: REPO_URL }),
      JSON.stringify([{ kind: GITHUB_DECLARATION_KIND }]),
      `Repo: ${REPO_URL}\n${declaration()}`,
      declaration() + "\n// trailing",
    ]
    for (const b of bad) assert.equal(parseGithubDeclaration(meta, bytes(b)).kind, "invalid", b.slice(0, 40))
    assert.equal(parseGithubDeclaration({ ...meta, mimeType: "text/markdown" }, bytes(declaration())).kind, "invalid")
    assert.equal(parseGithubDeclaration({ ...meta, fileSize: 5000 }, bytes(declaration())).kind, "invalid")
    assert.equal(parseGithubDeclaration(meta, new Uint8Array([0xff, 0xfe])).kind, "invalid")
  })
})

describe("GitHub evaluation path (mocked GitHub + mocked Gemini)", () => {
  it("validates, retrieves the exact commit, reviews, scores deterministically, and persists the result", async () => {
    const sub = await seedGithub()
    const r = await evaluate(U.freelancer, sub)
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.equal(codePrompts.length, 1, "exactly one Gemini call")
    assert.equal(textPrompts.length, 0)

    // frozen criteria from the database + source from the validated commit reached the model
    for (const needle of ['id="c1"', "Includes a hero section.", "L2|   <h1>Plants, delivered weekly</h1>", "src/contact.tsx"]) assert.ok(codePrompts[0].includes(needle), needle)

    // every source request is pinned to the exact validated commit; only metadata + contents endpoints
    const contents = ghCalls.filter((c) => c.url.includes("/contents/"))
    assert.equal(contents.length, 3)
    for (const c of contents) assert.equal(new URL(c.url).searchParams.get("ref"), SHA)
    for (const c of ghCalls) assert.doesNotMatch(c.url, /zipball|tarball|archive|raw\.githubusercontent|\/main|HEAD/)

    assert.equal(r.json?.score, 100)
    assert.equal(r.json?.passed, true)
    assert.equal(r.json?.simulated, false)
    assert.equal(r.json?.model, MODEL)
    assert.equal(r.json?.promptVersion, CODE_REVIEW_PROMPT_VERSION)

    const [row] = await evalRows()
    assert.equal(row.state, "completed")
    assert.equal(row.simulated, false)
    assert.equal(row.model, MODEL)
    assert.equal(row.prompt_version, "gemini-code-review-v1")
    assert.equal(row.score, 100)
    assert.equal(row.passed, true)
    assert.equal(row.criteria_hash, H)
    assert.match(String(row.summary), new RegExp(`^Pass \\(100/100\\) for acme/widgets@${SHA}`))
    const results = row.criteria_results as Array<Record<string, unknown>>
    assert.equal(results.length, 3)
    assert.deepEqual(results[0].evidence, [{ path: "src/hero.tsx", startLine: 2, endLine: 2, quote: "Plants, delivered weekly" }])
    assert.deepEqual(results[0].source, { kind: "github", repository: "acme/widgets", commitSha: SHA })
    assert.deepEqual(results.map((x) => [x.assessment, x.weight, x.points, x.mandatory]), [["verified", 34, 34, true], ["verified", 33, 33, false], ["verified", 33, 33, true]])
  })

  it("keeps the response format identical to the text path", async () => {
    const textSub = await seedText()
    const t = await evaluate(U.freelancer, textSub)
    const ghSub = await seedGithub()
    const g = await evaluate(U.freelancer, ghSub)
    assert.equal(t.status, 201)
    assert.equal(g.status, 201)
    assert.deepEqual(Object.keys(g.json ?? {}).sort(), Object.keys(t.json ?? {}).sort())
    const item = (j: Record<string, unknown> | null) => Object.keys((j?.criteriaResults as Array<Record<string, unknown>>)[0]).sort()
    assert.deepEqual(item(g.json), ["criterion", "passed", "reason"])
    assert.deepEqual(item(g.json), item(t.json))
  })

  it("mixed assessments use the existing scoring rules (partial mandatory -> not a Pass)", async () => {
    codeReply = () => ({
      assessments: [codeRow("c1", "partial", [cite("src/hero.tsx", 2, "Plants, delivered weekly")]), codeRows()[1], codeRows()[2]],
    })
    const r = await evaluate(U.freelancer, await seedGithub())
    assert.equal(r.status, 201)
    assert.equal(r.json?.score, 83)
    assert.equal(r.json?.passed, false, "a mandatory criterion is only partial")
    const [row] = await evalRows()
    assert.match(String(row.summary), /^Needs Review \(83\/100\)/)
    assert.match(JSON.stringify(row.criteria_results), /Missing: Not implemented\./)
  })

  it("a fabricated line reference is dropped and the claim downgraded", async () => {
    codeReply = () => ({ assessments: [codeRow("c1", "verified", [cite("src/hero.tsx", 3, "Plants, delivered weekly")]), codeRows()[1], codeRows()[2]] })
    const r = await evaluate(U.freelancer, await seedGithub())
    assert.equal(r.status, 201)
    assert.equal(r.json?.passed, false)
    assert.equal(r.json?.score, 66)
    const [row] = await evalRows()
    const first = (row.criteria_results as Array<Record<string, unknown>>)[0]
    assert.equal(first.assessment, "unsupported")
    assert.deepEqual(first.evidence, [])
    assert.match(String(row.summary), /could not be verified/)
  })
})

describe("incomplete or truncated source can never be an automatic Pass", () => {
  it("a truncated repository tree", async () => {
    gh.tree = { body: { ...(gh.tree.body as object), truncated: true } }
    const r = await evaluate(U.freelancer, await seedGithub())
    assert.equal(r.status, 201)
    assert.equal(r.json?.passed, false)
    const [row] = await evalRows()
    assert.equal(row.passed, false)
    assert.match(String(row.summary), /Automatic approval blocked/)
    assert.match(String(row.summary), /incomplete/i)
    assert.match(codePrompts[0], /only PART of the submission/)
  })

  it("a source file that could not be retrieved", async () => {
    gh.files["src/features.tsx"] = { status: 404 }
    const r = await evaluate(U.freelancer, await seedGithub())
    assert.equal(r.status, 201)
    assert.equal(r.json?.passed, false)
    const [row] = await evalRows()
    assert.equal(row.passed, false)
    assert.match(String(row.summary), /not read/)
    assert.doesNotMatch(codePrompts[0], /Features/)
  })

  it("a binary or oversized file in the listing", async () => {
    gh.files["src/contact.tsx"] = { body: { ...fileBody("src/contact.tsx", "x"), content: Buffer.from([0x61, 0x00, 0x62]).toString("base64"), size: 3 } }
    const r = await evaluate(U.freelancer, await seedGithub())
    assert.equal(r.json?.passed, false)
    assert.equal((await evalRows())[0].passed, false)
  })

  it("more source files than the retrieval limit allows", async () => {
    const paths = Array.from({ length: 70 }, (_, i) => `src/m${i}.ts`)
    gh.tree = { body: { truncated: false, tree: paths.map((p) => ({ path: p, type: "blob", size: 10 })) } }
    for (const p of paths) gh.files[p] = { body: fileBody(p, `export const v = 1\n`) }
    codeReply = () => ({ assessments: [codeRow("c1", "verified", [cite("src/m0.ts", 1, "export const v")]), codeRow("c2", "verified", [cite("src/m1.ts", 1, "export const v")]), codeRow("c3", "verified", [cite("src/m2.ts", 1, "export const v")])] })
    const r = await evaluate(U.freelancer, await seedGithub())
    assert.equal(r.status, 201)
    assert.equal(r.json?.passed, false)
    assert.match(String((await evalRows())[0].summary), /Automatic approval blocked/)
  })

  it("the evaluator itself reports the block (defence in depth beside the capped score)", async () => {
    gh.tree = { body: { ...(gh.tree.body as object), truncated: true } }
    const out = await deps.evaluator.evaluate({
      invoiceId: INV,
      criteriaHash: H as never,
      criteriaVersion: 1,
      criteria: [
        { id: "c1", text: "Includes a hero section.", mandatory: true },
        { id: "c2", text: "Includes a features section.", mandatory: false },
        { id: "c3", text: "Includes a contact section.", mandatory: true },
      ],
      submission: { id: id(1), fileName: GITHUB_DECLARATION_FILE_NAME, mimeType: "text/plain", fileSize: declaration().length },
      evidence: new TextEncoder().encode(declaration()),
    })
    assert.ok(out.passBlocked && out.passBlocked.length > 0)
    assert.match(out.passBlocked.join(" "), /incomplete/i)
    assert.deepEqual(out.source, { kind: "github", repository: "acme/widgets", commitSha: SHA })
    const complete = freshGitHub()
    gh = complete
    const ok = await deps.evaluator.evaluate({
      invoiceId: INV, criteriaHash: H as never, criteriaVersion: 1,
      criteria: [{ id: "c1", text: "Includes a hero section.", mandatory: true }, { id: "c2", text: "Includes a features section.", mandatory: false }, { id: "c3", text: "Includes a contact section.", mandatory: true }],
      submission: { id: id(1), fileName: GITHUB_DECLARATION_FILE_NAME, mimeType: "text/plain", fileSize: declaration().length },
      evidence: new TextEncoder().encode(declaration()),
    })
    assert.equal(ok.passBlocked, undefined)
  })

  it("the server vetoes a pass from ANY evaluator that reports blocked evidence, whatever its score", async () => {
    const scripted = new ScriptedEvaluator()
    scripted.output = (i) => ({
      model: "scripted",
      promptVersion: "scripted-v1",
      simulated: false,
      score: 100,
      criteriaResults: i.criteria.map((c) => ({ criterion: c.text, passed: true, reason: "ok" })),
      summary: "Looks perfect.",
      passBlocked: ["source incomplete"],
    })
    deps = { ...deps, evaluator: scripted }
    const r = await evaluate(U.freelancer, await seedText())
    assert.equal(r.status, 201)
    assert.equal(r.json?.score, 100)
    assert.equal(r.json?.passed, false)
    assert.equal((await evalRows())[0].passed, false)

    // and an evaluator with no block is unaffected
    scripted.output = (i) => ({ model: "scripted", promptVersion: "v", simulated: false, score: 100, criteriaResults: i.criteria.map((c) => ({ criterion: c.text, passed: true, reason: "ok" })), summary: "ok", passBlocked: [] })
    assert.equal((await evaluate(U.freelancer, await seedText())).json?.passed, true)
  })
})

describe("text and Markdown evaluation is preserved", () => {
  it("evaluates text evidence exactly as before, without touching GitHub or the code-review model", async () => {
    const r = await evaluate(U.freelancer, await seedText())
    assert.equal(r.status, 201)
    assert.equal(r.json?.score, 100)
    assert.equal(r.json?.promptVersion, PROMPT_VERSION)
    assert.equal(textPrompts.length, 1)
    assert.equal(codePrompts.length, 0)
    assert.equal(ghCalls.length, 0)
    const [row] = await evalRows()
    assert.match(String(row.summary), /^Pass \(100\/100\)\. /)
    assert.equal(JSON.stringify(row.criteria_results).includes("source"), false, "no GitHub fields on text results")
  })

  it("evaluates Markdown the same way", async () => {
    const r = await evaluate(U.freelancer, await seedSubmission(TEXT_EVIDENCE, "report.md", "text/markdown"))
    assert.equal(r.status, 201)
    assert.equal(ghCalls.length, 0)
  })

  it("text that merely mentions a repository URL and a full SHA is NOT a GitHub submission", async () => {
    const text = `${TEXT_EVIDENCE}\nCode: ${REPO_URL}\nCommit: ${SHA}\n`
    const r = await evaluate(U.freelancer, await seedText(text))
    assert.equal(r.status, 201)
    assert.equal(ghCalls.length, 0)
    assert.equal(codePrompts.length, 0)
    assert.equal(textPrompts.length, 1)
  })

  it("a valid declaration inside a differently named file is just text", async () => {
    const r = await evaluate(U.freelancer, await seedSubmission(declaration(), "notes.txt"))
    assert.equal(ghCalls.length, 0)
    assert.equal(codePrompts.length, 0)
    assert.equal(textPrompts.length, 1)
    assert.ok([201, 502].includes(r.status))
  })

  it("non-text evidence is still refused with 422 and nothing external is called", async () => {
    const r = await evaluate(U.freelancer, await seedSubmission("%PDF-1.4", "scan.pdf", "application/pdf"))
    assert.equal(r.status, 422)
    assert.equal(code(r), "EVIDENCE_NOT_EVALUABLE")
    assert.equal(externalCalls(), 0)
  })
})

describe("authorization, ownership and state checks come before any external call", () => {
  it("signed-out, stranger and client callers are refused", async () => {
    const sub = await seedGithub()
    assert.equal((await evaluate(null, sub)).status, 401)
    assert.equal((await evaluate(U.stranger, sub)).status, 404)
    assert.equal((await evaluate(U.client, sub)).status, 403)
    assert.equal(externalCalls(), 0)
    assert.equal((await evalRows()).length, 0)
  })

  it("a malformed or unknown submission id is refused", async () => {
    assert.equal((await evaluate(U.freelancer, "not-a-uuid")).status, 400)
    assert.equal((await evaluate(U.freelancer, id(7777))).status, 404)
    assert.equal(externalCalls(), 0)
  })

  it("only the latest submission is evaluated", async () => {
    const old = await seedGithub()
    await seedGithub()
    const r = await evaluate(U.freelancer, old)
    assert.equal(r.status, 409)
    assert.equal(code(r), "STALE_SUBMISSION")
    assert.equal(externalCalls(), 0)
  })

  it("a browser-supplied score, verdict, repository or commit is rejected at the door", async () => {
    const sub = await seedGithub()
    for (const extra of [{ score: 100 }, { passed: true }, { repositoryUrl: REPO_URL }, { commitSha: SHA }]) {
      const r = await http(handleEvaluate, ctx(U.freelancer, deps), { body: { submissionId: sub, ...extra } })
      assert.equal(r.status, 400, JSON.stringify(extra))
    }
    assert.equal(externalCalls(), 0)
  })

  it("a completed evaluation is returned unchanged with no further GitHub or Gemini calls", async () => {
    const sub = await seedGithub()
    const first = await evaluate(U.freelancer, sub)
    const calls = externalCalls()
    const second = await evaluate(U.freelancer, sub)
    assert.equal(second.json?.id, first.json?.id)
    assert.equal(externalCalls(), calls)
    assert.equal((await evalRows()).length, 1)
  })

  it("two simultaneous requests produce one completed evaluation", async () => {
    const sub = await seedGithub()
    await Promise.all([evaluate(U.freelancer, sub), evaluate(U.freelancer, sub)])
    assert.equal(await count("evaluations", "state = 'completed'"), 1)
  })

  it("a disabled evaluator still answers 503 without reading anything external", async () => {
    deps = { ...deps, evaluator: { mode: "disabled", evaluate: async () => { throw new Error("must not run") } } }
    const r = await evaluate(U.freelancer, await seedGithub())
    assert.equal(r.status, 503)
    assert.equal(code(r), "EVALUATOR_UNAVAILABLE")
    assert.equal(externalCalls(), 0)
  })
})

describe("failures are recorded, reported with the existing codes, and retryable", () => {
  const failsWith = async (status: number, errCode: string, sub?: string) => {
    const r = await evaluate(U.freelancer, sub ?? (await seedGithub()))
    assert.equal(r.status, status, JSON.stringify(r.json))
    assert.equal(code(r), errCode)
    const rows = await evalRows()
    assert.equal(rows.at(-1)?.state, "error")
    assert.equal(rows.filter((x) => x.state === "completed").length, 0)
    assert.ok(!rows.at(-1)?.score)
    return r
  }

  it("invalid declaration files -> 422 EVIDENCE_NOT_EVALUABLE, nothing external called", async () => {
    for (const content of ["not json", declaration({ extra: true }), declaration({ kind: "x" })]) {
      await failsWith(422, "EVIDENCE_NOT_EVALUABLE", await seedSubmission(content, GITHUB_DECLARATION_FILE_NAME))
    }
    assert.equal(externalCalls(), 0)
  })

  it("submitter-fixable GitHub problems -> 422 EVIDENCE_NOT_EVALUABLE", async () => {
    gh.repo = { status: 404 }
    await failsWith(422, "EVIDENCE_NOT_EVALUABLE")
    gh = freshGitHub()
    gh.repo = { body: { full_name: "acme/widgets", private: true } }
    await failsWith(422, "EVIDENCE_NOT_EVALUABLE")
    gh = freshGitHub()
    gh.commit = { status: 404 }
    await failsWith(422, "EVIDENCE_NOT_EVALUABLE")
    gh = freshGitHub()
    await failsWith(422, "EVIDENCE_NOT_EVALUABLE", await seedGithub({ commit_sha: "main" }))
    await failsWith(422, "EVIDENCE_NOT_EVALUABLE", await seedGithub({ repository_url: "https://example.com/acme/widgets" }))
    assert.equal(codePrompts.length, 0)
  })

  it("a commit with no source files -> 422", async () => {
    gh.tree = { body: { truncated: false, tree: [{ path: "README.md", type: "blob", size: 5 }] } }
    await failsWith(422, "EVIDENCE_NOT_EVALUABLE")
    assert.equal(codePrompts.length, 0)
  })

  it("GitHub rate limit, outage or bad payload -> 502 EVALUATOR_FAILED", async () => {
    gh.repo = { status: 429 }
    await failsWith(502, "EVALUATOR_FAILED")
    gh = freshGitHub()
    gh.tree = { status: 500 }
    await failsWith(502, "EVALUATOR_FAILED")
    gh = freshGitHub()
    gh.commit = { throws: true }
    await failsWith(502, "EVALUATOR_FAILED")
    gh = freshGitHub()
    gh.repo = { raw: "<html>" }
    await failsWith(502, "EVALUATOR_FAILED")
    assert.equal(codePrompts.length, 0)
  })

  it("every source file rate-limited -> 502 (not 'nothing to evaluate')", async () => {
    for (const p of Object.keys(SOURCES)) gh.files[p] = { status: 429 }
    await failsWith(502, "EVALUATOR_FAILED")
    assert.equal(codePrompts.length, 0)
  })

  it("malformed Gemini output, a Gemini-supplied score, or an API failure -> 502, and a retry then works", async () => {
    const sub = await seedGithub()
    codeReply = () => "this is not json"
    await failsWith(502, "EVALUATOR_FAILED", sub)
    codeReply = () => ({ assessments: codeRows(), score: 100 })
    await failsWith(502, "EVALUATOR_FAILED", sub)
    codeReply = () => ({ assessments: codeRows().map((r) => ({ ...r, verdict: "Pass" })) })
    await failsWith(502, "EVALUATOR_FAILED", sub)
    codeReply = () => {
      throw new Error("503 upstream SECRET-PROVIDER-DETAIL")
    }
    const r = await failsWith(502, "EVALUATOR_FAILED", sub)
    assert.doesNotMatch(JSON.stringify(r.json), /SECRET-PROVIDER-DETAIL/)
    assert.doesNotMatch(String((await evalRows()).at(-1)?.error_message), /SECRET-PROVIDER-DETAIL/)

    codeReply = () => ({ assessments: codeRows() })
    const ok = await evaluate(U.freelancer, sub)
    assert.equal(ok.status, 201)
    const rows = await evalRows()
    assert.equal(rows.filter((x) => x.state === "completed").length, 1)
    assert.equal(rows.filter((x) => x.state === "error").length, 4)
  })

  it("wrong criterion ids from Gemini -> 502", async () => {
    codeReply = () => ({ assessments: codeRows().map((r) => ({ ...r, id: r.id === "c2" ? "ghost" : r.id })) })
    await failsWith(502, "EVALUATOR_FAILED")
  })

  it("a GitHub submission with no GitHub support configured -> 422, nothing called", async () => {
    deps = { ...deps, evaluator: createGeminiEvaluator({ generate: async () => "{}", model: MODEL }) }
    await failsWith(422, "EVIDENCE_NOT_EVALUABLE")
    assert.equal(externalCalls(), 0)
  })
})

describe("evaluations never trigger payments or touch advance and dispute rules", () => {
  it("a passing GitHub evaluation creates no advance request or transaction and never touches the signer or chain", async () => {
    const signer = deps.signer as FakeSigner
    const chain = deps.chain as FakeChainAdapter
    const r = await evaluate(U.freelancer, await seedGithub())
    assert.equal(r.json?.passed, true)
    assert.equal(await count("advance_requests"), 0)
    assert.equal(await count("transactions"), 0)
    assert.equal(signer.calls, 0)
    assert.deepEqual(chain.calls, { creation: 0, state: 0, reserve: 0, tx: 0, found: 0 })
  })

  it("an advance still needs its own explicit request, and is refused with no chain or signer", async () => {
    await evaluate(U.freelancer, await seedGithub())
    const adv = await http(handleAdvance, ctx(U.freelancer, deps), { body: { invoiceId: INV } })
    assert.equal(adv.status, 503)
    assert.equal(await count("advance_requests"), 0)
    assert.equal((deps.signer as FakeSigner).calls, 0)
  })
})

describe("secrets", () => {
  const TOKEN = "ghp_CANARYTOKEN0123456789"
  const fakeClient = (): { client: GeminiLikeClient; schemas: unknown[] } => {
    const schemas: unknown[] = []
    return {
      schemas,
      client: {
        models: {
          async generateContent(args) {
            schemas.push(args.config.responseSchema)
            return { text: JSON.stringify(/L1\|/.test(args.contents) ? { assessments: codeRows() } : { assessments: textRows() }) }
          },
        },
      },
    }
  }
  const env = { GEMINI_API_KEY: "gemini-canary-key", GEMINI_EVALUATION_MODEL: MODEL, GITHUB_TOKEN: TOKEN }

  it("the GitHub token goes only in request headers, and the code-review schema is used for code", async () => {
    const f = fakeClient()
    deps = { ...deps, evaluator: createGeminiEvaluatorFromEnv(env, f.client, { fetch: ghFetch }) }
    const r = await evaluate(U.freelancer, await seedGithub())
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.ok(ghCalls.length >= 6 && ghCalls.every((c) => c.auth === `Bearer ${TOKEN}`))
    assert.match(JSON.stringify(f.schemas[0]), /citations/)
    const everything = JSON.stringify([r.json, await evalRows(), ghCalls.map((c) => c.url)])
    assert.doesNotMatch(everything, /CANARYTOKEN|gemini-canary-key/)
  })

  it("no token is sent when none is configured", async () => {
    const f = fakeClient()
    deps = { ...deps, evaluator: createGeminiEvaluatorFromEnv({ ...env, GITHUB_TOKEN: "" }, f.client, { fetch: ghFetch }) }
    await evaluate(U.freelancer, await seedGithub())
    assert.ok(ghCalls.length > 0 && ghCalls.every((c) => c.auth === null))
  })

  it("the token never appears in stored or returned errors, even when GitHub echoes it", async () => {
    gh.repo = { status: 500, raw: `boom ${TOKEN}` }
    deps = { ...deps, evaluator: createGeminiEvaluatorFromEnv(env, fakeClient().client, { fetch: ghFetch }) }
    const r = await evaluate(U.freelancer, await seedGithub())
    assert.equal(r.status, 502)
    assert.doesNotMatch(JSON.stringify([r.json, await evalRows()]), /CANARYTOKEN/)
  })

  it("text evaluation through the env factory still uses the classification schema", async () => {
    const f = fakeClient()
    deps = { ...deps, evaluator: createGeminiEvaluatorFromEnv(env, f.client, { fetch: ghFetch }) }
    const r = await evaluate(U.freelancer, await seedText())
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.doesNotMatch(JSON.stringify(f.schemas[0]), /citations/)
    assert.equal(ghCalls.length, 0)
  })

  it("missing Gemini settings still disable the evaluator (503), GitHub token or not", async () => {
    deps = { ...deps, evaluator: createGeminiEvaluatorFromEnv({ GITHUB_TOKEN: TOKEN }, fakeClient().client, { fetch: ghFetch }) }
    const r = await evaluate(U.freelancer, await seedGithub())
    assert.equal(r.status, 503)
    assert.equal(ghCalls.length, 0)
  })
})

describe("isolation", () => {
  it("nothing in the evaluation path runs, installs or clones submitted code, and the frontend/chain are untouched", () => {
    for (const f of ["lib/ai/evaluation-service.ts", "lib/ai/github-declaration.ts", "lib/ai/github-source.ts", "lib/ai/github-submission.ts", "lib/ai/code-review.ts", "lib/ai/code-review-scoring.ts"]) {
      const code = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      assert.doesNotMatch(code, /child_process|\beval\(|new Function|(?<![.\w])exec(Sync|File)?\(|spawn|node:fs|git clone|npm install|\bvm\./, f)
    }
    const svc = fs.readFileSync("lib/ai/evaluation-service.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    assert.doesNotMatch(svc, /signer|AdvanceSigner|viem|advance_requests/i)
  })

  it("mock/frontend code never imports the GitHub evaluation modules", () => {
    for (const dir of ["components", "app", "hooks", "lib/frontend"]) {
      const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]))
      for (const f of walk(dir).filter((p) => /\.(ts|tsx)$/.test(p))) {
        assert.doesNotMatch(fs.readFileSync(f, "utf8"), /^\s*(import|export)\b[^\n]*from "(@\/lib\/ai\/|\.{1,2}\/(.*\/)?ai\/)/m, f)
      }
    }
  })
})
