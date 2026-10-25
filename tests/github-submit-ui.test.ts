import { after, before, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import type { PGlite } from "@electric-sql/pglite"
import { createDb } from "./helpers/db"
import { Clock, FakeChain, FakeObjectStore, createPgEvidenceDb } from "./helpers/evidence"
import { ctx, createPgBackendDb, FakeChainAdapter, FakeSigner, ScriptedEvaluator } from "./helpers/backend"
import { handleAdvance, handleEvaluate, handleGetInvoice, handleListInvoices } from "@/lib/backend/handlers"
import { handleSubmissionPost } from "@/lib/evidence/submissions-http"
import type { EvidenceDeps } from "@/lib/evidence/service"
import type { BackendDeps } from "@/lib/backend/ports"
import { validateGithubSubmission, parseCommitSha, parseGithubRepoUrl } from "@/lib/ai/github-submission"
import { ApiDuelyRepository } from "@/lib/frontend/api-repository"
import { checkCommitSha, checkRepositoryUrl, githubLinks, shortSha } from "@/lib/frontend/github-input"
import { DomainError } from "@/lib/frontend/errors"
import { MockDuelyRepository } from "@/lib/mocks/mock-repository"

/** GitHub is mocked; the real network is trapped. The backend is the real handlers over a local Postgres with the real migrations. */
const realFetch = globalThis.fetch
before(() => {
  globalThis.fetch = (() => {
    throw new Error("a test tried to use the network")
  }) as never
})
after(() => {
  globalThis.fetch = realFetch
})

const SHA = "a".repeat(40)
const TREE = "b".repeat(40)
const CANON = "https://github.com/acme/widgets"

describe("form-side validation (mirrors the server, which stays authoritative)", () => {
  it("normalises acceptable repository URLs to the canonical form", () => {
    for (const u of [CANON, `${CANON}/`, `${CANON}.git`, "https://www.github.com/acme/widgets", `  ${CANON}  `, "https://github.com/Acme/Widgets.GIT/"]) {
      const r = checkRepositoryUrl(u)
      assert.ok(r.ok, u)
    }
    assert.deepEqual(checkRepositoryUrl(" https://www.github.com/acme/widgets.git/ "), { ok: true, value: CANON })
  })

  it("gives a specific message for each kind of bad URL", () => {
    const cases: Array<[string, RegExp]> = [
      ["", /Enter the repository URL/],
      ["not a url", /doesn't look like a URL/],
      ["http://github.com/acme/widgets", /https/],
      ["https://gitlab.com/acme/widgets", /github\.com/],
      ["https://github.com.evil.com/acme/widgets", /github\.com/],
      ["https://user:pw@github.com/acme/widgets", /username/],
      ["https://github.com/acme/widgets?tab=readme", /\? or #/],
      ["https://github.com/acme/widgets#readme", /\? or #/],
      ["https://github.com/acme", /owner and repository/],
      ["https://github.com/", /owner and repository/],
      ["https://github.com/acme/widgets/tree/main", /main URL/],
      ["https://github.com/-acme/widgets", /isn't valid/],
      ["https://github.com/acme/..", /owner and repository|isn't valid/],
    ]
    for (const [input, re] of cases) {
      const r = checkRepositoryUrl(input)
      assert.ok(!r.ok && re.test(r.message), `${input} -> ${JSON.stringify(r)}`)
    }
  })

  it("accepts only a full 40-character SHA and lowercases it", () => {
    assert.deepEqual(checkCommitSha(` ${"A".repeat(40)} `), { ok: true, value: SHA })
    const cases: Array<[string, RegExp]> = [
      ["", /Enter the full commit SHA/],
      ["abc1234", /short SHA/],
      ["a".repeat(39), /short SHA/],
      ["a".repeat(41), /longer than/],
      ["g".repeat(40), /0-9 and the letters a-f/],
      ["main", /not a branch or tag/],
      ["v1.0.0", /not a branch or tag/],
    ]
    for (const [input, re] of cases) {
      const r = checkCommitSha(input)
      assert.ok(!r.ok && re.test(r.message), `${input} -> ${JSON.stringify(r)}`)
    }
  })

  it("agrees with the server's own parsers on a wide corpus (so the form never promises what the server rejects)", () => {
    const urls = [
      CANON, `${CANON}/`, `${CANON}.git`, `${CANON}.GIT`, "https://www.github.com/acme/widgets", "http://github.com/acme/widgets", "https://GITHUB.com/acme/widgets",
      "https://github.com/acme", "https://github.com/", "https://github.com/acme/widgets/tree/main", "https://github.com/acme/widgets?x=1", "https://github.com/acme/widgets#a",
      "https://user:pw@github.com/acme/widgets", "https://github.com:443/acme/widgets", "https://gitlab.com/acme/widgets", "https://github.com.evil.com/acme/widgets",
      "https://github.com/-acme/widgets", `https://github.com/${"o".repeat(40)}/w`, `https://github.com/${"o".repeat(39)}/w`, `https://github.com/a/${"r".repeat(101)}`,
      "https://github.com/a/.", "https://github.com/a/..", "https://github.com/a/.github", "https://github.com/a/b c", "git@github.com:acme/widgets.git", "", "x",
    ]
    for (const u of urls) {
      const server = parseGithubRepoUrl(u)
      const form = checkRepositoryUrl(u)
      assert.equal(form.ok, server !== null, `url: ${JSON.stringify(u)}`)
      if (form.ok && server) assert.equal(form.value, `https://github.com/${server.owner}/${server.repo}`, u)
    }
    const shas = [SHA, SHA.toUpperCase(), "a".repeat(39), "a".repeat(41), "g".repeat(40), "main", "HEAD", "", `${SHA} `, ` ${SHA}`, "abc1234", "0123456789abcdef0123456789abcdef01234567"]
    for (const sha of shas) {
      const server = parseCommitSha(sha)
      const form = checkCommitSha(sha)
      assert.equal(form.ok, server !== null, `sha: ${JSON.stringify(sha)}`)
      if (form.ok && server) assert.equal(form.value, server)
    }
  })

  it("only builds links from strict canonical values", () => {
    assert.deepEqual(githubLinks(CANON, SHA), { repo: CANON, commit: `${CANON}/commit/${SHA}`, label: "acme/widgets" })
    for (const [u, s] of [
      [null, SHA], [CANON, null], [undefined, undefined], ["javascript:alert(1)", SHA], [`${CANON}/`, SHA], [`${CANON}.git`, SHA], ["https://evil.com/acme/widgets", SHA],
      [CANON, "main"], [CANON, "a".repeat(39)], [`${CANON}?x=1`, SHA], ["https://github.com/acme/widgets/../../evil", SHA],
    ] as Array<[string | null | undefined, string | null | undefined]>) {
      assert.equal(githubLinks(u, s), null, `${u} ${s}`)
    }
    assert.equal(shortSha(SHA), "aaaaaaa")
  })
})

// ---- the API adapter against the REAL backend handlers --------------------------------------------------------------------

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const U = { freelancer: id(1), client: id(2), stranger: id(3) }
const W = { freelancer: "0x" + "b".repeat(40), client: "0x" + "a".repeat(40), stranger: "0x" + "c".repeat(40), contract: "0x" + "e".repeat(40), token: "0x" + "d".repeat(40) }
const H = "0x" + "1".repeat(64)
const INV = id(401)

type Reply = { status?: number; body?: unknown; throws?: boolean }
let gh: { repo: Reply; commit: Reply; tree: Reply }
let ghCalls: string[]
const ghFetch = (async (input: string | URL | Request) => {
  const p = decodeURIComponent(new URL(String(input)).pathname)
  ghCalls.push(String(input))
  let r: Reply | undefined
  if (p === "/repos/acme/widgets") r = gh.repo
  else if (p === `/repos/acme/widgets/git/commits/${SHA}`) r = gh.commit
  else if (p === `/repos/acme/widgets/git/trees/${TREE}`) r = gh.tree
  if (!r) return new Response("{}", { status: 404 })
  if (r.throws) throw new TypeError("fetch failed")
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 })
}) as unknown as typeof fetch
const freshGh = () => ({
  repo: { body: { full_name: "acme/widgets", private: false, default_branch: "main" } },
  commit: { body: { sha: SHA, tree: { sha: TREE } } },
  tree: { body: { truncated: false, tree: [{ path: "src/a.ts", type: "blob", size: 10 }] } },
})

let db: PGlite
let store: FakeObjectStore
let evDeps: EvidenceDeps
let deps: BackendDeps
let evaluator: ScriptedEvaluator
let requests: Array<{ method: string; path: string; body: unknown }>

before(async () => {
  db = await createDb()
  for (const [k, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, `${k}@t.invalid`])
  for (const [user, addr] of [[U.freelancer, W.freelancer], [U.client, W.client], [U.stranger, W.stranger]] as const) {
    await db.query("insert into user_wallets (user_id, address, verified_at, verification_method) values ($1,$2,now(),'eip191')", [user, addr])
  }
  await db.query(
    `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
     values ($1,1440002,$2,$3,1,$4,$5,1000,$6,2,'canon','Brand identity',$7,'Funded')`,
    [INV, W.contract, W.token, W.client, W.freelancer, H, U.client]
  )
  await db.query("insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ($1,0,'c1','Logo delivered',true), ($1,1,'c2','Source files included',false)", [INV])
})
after(async () => db.close())

beforeEach(async () => {
  for (const t of ["advance_requests", "transactions", "evaluations", "submissions"]) {
    await db.query(`alter table ${t} disable trigger user`)
    await db.query(`delete from ${t}`)
    await db.query(`alter table ${t} enable trigger user`)
  }
  store = new FakeObjectStore(new Clock())
  gh = freshGh()
  ghCalls = []
  requests = []
  evaluator = new ScriptedEvaluator()
  const chain = new FakeChainAdapter()
  chain.available = false
  deps = { db: createPgBackendDb(db), objects: store, chain, signer: new FakeSigner(), evaluator }
  evDeps = {
    db: createPgEvidenceDb(db),
    objects: store,
    chain: new FakeChain(),
    requireChainVerification: false,
    github: (url, sha) => validateGithubSubmission(url, sha, { fetch: ghFetch }),
  }
})

/** What the browser's fetch does against the real routes: same handlers, same schema, session = `user`. */
function shim(getUser: () => string | null): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input), "http://localhost:3000")
    const method = (init?.method ?? "GET").toUpperCase()
    const headers = new Headers(init?.headers as HeadersInit)
    if (method !== "GET") headers.set("origin", "http://localhost:3000")
    const raw = (init?.body as string | undefined) ?? undefined
    requests.push({ method, path: url.pathname, body: raw ? JSON.parse(raw) : undefined })
    const req = new Request(url, { method, headers, body: raw })
    const user = getUser()
    const c = ctx(user, deps)
    if (url.pathname === "/api/auth/session") {
      const wallets = user ? await deps.db.verifiedAddresses(user) : []
      return Response.json({ authenticated: !!user, userId: user, wallets })
    }
    if (url.pathname === "/api/submissions") return handleSubmissionPost(req, { userId: async () => user, deps: () => evDeps })
    if (url.pathname === "/api/invoices" && method === "GET") return handleListInvoices(req, c)
    const m = url.pathname.match(/^\/api\/invoices\/([^/]+)$/)
    if (m) return handleGetInvoice(req, c, { id: decodeURIComponent(m[1]) })
    if (url.pathname === "/api/evaluate") return handleEvaluate(req, c)
    if (url.pathname === "/api/advances") return handleAdvance(req, c)
    return Response.json({ error: { code: "NOT_FOUND", message: "no route" } }, { status: 404 })
  }
}
const repoFor = (user: string | null) =>
  new ApiDuelyRepository({ fetch: shim(() => user), uploadEvidence: (async () => { throw new Error("file upload must not be used") }) as never, storage: null, signIn: async () => undefined, signOut: async () => undefined })

const input = (over: Partial<Parameters<ApiDuelyRepository["submitGithubRepository"]>[0]> = {}) => ({ invoiceId: "1", repositoryUrl: CANON, commitSha: SHA, note: "", ...over })

async function ref(repo: ApiDuelyRepository) {
  const list = await repo.listInvoices("freelancer", W.freelancer)
  assert.equal(list.length, 1)
  return list[0].invoiceId
}

describe("ApiDuelyRepository.submitGithubRepository", () => {
  it("sends exactly { type, invoiceId, repositoryUrl, commitSha } and nothing else when there is no note", async () => {
    const repo = repoFor(U.freelancer)
    const invoiceId = await ref(repo)
    await repo.submitGithubRepository(input({ invoiceId }))
    const post = requests.find((r) => r.path === "/api/submissions")
    assert.deepEqual(post?.body, { type: "github", invoiceId: INV, repositoryUrl: CANON, commitSha: SHA })
    assert.equal(post?.method, "POST")
  })

  it("includes the trimmed note only when there is one", async () => {
    const repo = repoFor(U.freelancer)
    const invoiceId = await ref(repo)
    await repo.submitGithubRepository(input({ invoiceId, note: "  see src/a.ts  " }))
    assert.deepEqual(requests.find((r) => r.path === "/api/submissions")?.body, { type: "github", invoiceId: INV, repositoryUrl: CANON, commitSha: SHA, note: "see src/a.ts" })
  })

  it("returns the stored submission with the canonical values the server saved", async () => {
    const repo = repoFor(U.freelancer)
    const invoiceId = await ref(repo)
    const sub = await repo.submitGithubRepository(input({ invoiceId, repositoryUrl: "https://www.github.com/acme/widgets.git/", commitSha: SHA.toUpperCase() }))
    assert.equal(sub.repositoryUrl, CANON)
    assert.equal(sub.commitSha, SHA)
    assert.equal(sub.invoiceId, invoiceId)
    assert.equal(sub.fileName, "duely-github-submission.txt")
    assert.equal(sub.storagePath, "")
  })

  it("notifies open screens, and the refreshed invoice shows the GitHub submission", async () => {
    const repo = repoFor(U.freelancer)
    const invoiceId = await ref(repo)
    let notified = 0
    repo.subscribe(() => notified++)
    const before = await repo.getInvoice(invoiceId)
    assert.equal(before.submissions.length, 0)
    const sub = await repo.submitGithubRepository(input({ invoiceId }))
    assert.ok(notified >= 1, "subscribers are told to refresh")
    const after = await repo.getInvoice(invoiceId)
    assert.equal(after.submissions.length, 1)
    assert.equal(after.submissions[0].submissionId, sub.submissionId)
    assert.equal(after.submissions[0].repositoryUrl, CANON)
    assert.equal(after.submissions[0].commitSha, SHA)
    assert.equal(after.invoice.submissionStatus, "Submitted")
  })

  it("a submission is never shown as a payment: no advance, status and money unchanged", async () => {
    const repo = repoFor(U.freelancer)
    const invoiceId = await ref(repo)
    const before = await repo.getInvoice(invoiceId)
    await repo.submitGithubRepository(input({ invoiceId }))
    const after = await repo.getInvoice(invoiceId)
    assert.equal(after.invoice.onchainStatus, before.invoice.onchainStatus)
    assert.equal(after.invoice.advanceAmount, before.invoice.advanceAmount)
    assert.equal(after.advanceRequests.length, 0)
    assert.equal(after.transactions.length, 0)
    assert.equal(requests.filter((r) => r.path === "/api/advances").length, 0, "submitting never requests an advance")
    assert.equal(requests.filter((r) => r.path === "/api/evaluate").length, 0, "evaluation is a separate, explicit call")
    assert.equal((deps.signer as FakeSigner).calls, 0)
    assert.equal((await db.query<{ c: number }>("select count(*)::int c from advance_requests")).rows[0].c, 0)
  })

  it("even after a passing evaluation, the advance still needs its own request (and is refused with no chain/signer)", async () => {
    const repo = repoFor(U.freelancer)
    const invoiceId = await ref(repo)
    const sub = await repo.submitGithubRepository(input({ invoiceId }))
    const ev = await repo.requestEvaluation(sub.submissionId)
    assert.equal(ev.passed, true)
    assert.equal(requests.filter((r) => r.path === "/api/advances").length, 0)
    await assert.rejects(repo.requestAdvance(invoiceId), (e: unknown) => e instanceof DomainError && e.code === "INTEGRATION_UNAVAILABLE")
    assert.equal((deps.signer as FakeSigner).calls, 0)
  })

  it("the file-upload path is untouched and never used for GitHub", async () => {
    const repo = repoFor(U.freelancer)
    const invoiceId = await ref(repo)
    await repo.submitGithubRepository(input({ invoiceId })) // the uploader throws if it were called
    assert.equal(requests.filter((r) => r.path === "/api/evidence/upload-url").length, 0)
  })

  it("maps API errors to clear domain errors with the server's message", async () => {
    const repo = repoFor(U.freelancer)
    const invoiceId = await ref(repo)
    const fails = async (setup: () => void, code: string, re: RegExp) => {
      gh = freshGh()
      setup()
      await assert.rejects(repo.submitGithubRepository(input({ invoiceId })), (e: unknown) => e instanceof DomainError && e.code === code && re.test(e.message))
      assert.equal((await db.query<{ c: number }>("select count(*)::int c from submissions")).rows[0].c, 0)
    }
    await fails(() => { gh.repo = { status: 404 } }, "INVALID_INPUT", /wasn't found|isn't public/i)
    await fails(() => { gh.repo = { body: { full_name: "acme/widgets", private: true } } }, "INVALID_INPUT", /public/i)
    await fails(() => { gh.commit = { status: 404 } }, "INVALID_INPUT", /commit/i)
    await fails(() => { gh.repo = { status: 429 } }, "INTEGRATION_UNAVAILABLE", /rate limit/i)
    await fails(() => { gh.tree = { status: 500 } }, "INTEGRATION_UNAVAILABLE", /unexpected status|reached/i)
    await fails(() => { gh.commit = { throws: true } }, "INTEGRATION_UNAVAILABLE", /reach/i)
  })

  it("surfaces backend validation of the shape (the form should have caught it first)", async () => {
    const repo = repoFor(U.freelancer)
    const invoiceId = await ref(repo)
    await assert.rejects(repo.submitGithubRepository(input({ invoiceId, commitSha: "main" })), (e: unknown) => e instanceof DomainError && e.code === "INVALID_INPUT")
    await assert.rejects(repo.submitGithubRepository(input({ invoiceId, repositoryUrl: "https://example.com/a/b" })), (e: unknown) => e instanceof DomainError && e.code === "INVALID_INPUT")
  })

  it("a signed-out visitor, the client and a stranger cannot submit", async () => {
    const asFreelancer = repoFor(U.freelancer)
    const invoiceId = await ref(asFreelancer)
    await assert.rejects(repoFor(null).submitGithubRepository(input({ invoiceId })), (e: unknown) => e instanceof DomainError && e.code === "UNAUTHENTICATED")
    const asClient = repoFor(U.client)
    const clientList = await asClient.listInvoices("client", W.client)
    await assert.rejects(asClient.submitGithubRepository(input({ invoiceId: clientList[0].invoiceId })), (e: unknown) => e instanceof DomainError && e.code === "FORBIDDEN")
    const asStranger = repoFor(U.stranger)
    await assert.rejects(asStranger.submitGithubRepository(input({ invoiceId })), (e: unknown) => e instanceof DomainError)
    assert.equal((await db.query<{ c: number }>("select count(*)::int c from submissions")).rows[0].c, 0)
    assert.equal(ghCalls.length, 0, "authorization is checked before GitHub is contacted")
  })

  it("a retry returns the same submission rather than creating another", async () => {
    const repo = repoFor(U.freelancer)
    const invoiceId = await ref(repo)
    const a = await repo.submitGithubRepository(input({ invoiceId }))
    const b = await repo.submitGithubRepository(input({ invoiceId }))
    assert.equal(a.submissionId, b.submissionId)
    assert.equal((await db.query<{ c: number }>("select count(*)::int c from submissions")).rows[0].c, 1)
  })
})

// ---- the mock adapter --------------------------------------------------------------------------------------------------------

describe("MockDuelyRepository.submitGithubRepository (demo mode)", () => {
  const fresh = async () => {
    const m = new MockDuelyRepository()
    m.demo!.reset()
    m.demo!.switchRole("freelancer")
    const session = await m.getSession()
    const list = await m.listInvoices("freelancer", session.wallet)
    const target = list.find((i) => i.onchainStatus === "Funded" && i.submissionStatus === "NotSubmitted")
    assert.ok(target, "the seed has a funded, not-yet-submitted invoice")
    return { m, invoiceId: target.invoiceId }
  }

  it("records a simulated GitHub submission without any network and without moving money", async () => {
    const { m, invoiceId } = await fresh()
    globalThis.fetch = (() => {
      throw new Error("mock mode must not use the network")
    }) as never
    const before = await m.getInvoice(invoiceId)
    const sub = await m.submitGithubRepository({ invoiceId, repositoryUrl: "https://www.github.com/acme/widgets.git", commitSha: SHA.toUpperCase(), note: " hi " })
    assert.equal(sub.repositoryUrl, CANON)
    assert.equal(sub.commitSha, SHA)
    assert.equal(sub.note, "hi")
    const after = await m.getInvoice(invoiceId)
    assert.equal(after.submissions[0].repositoryUrl, CANON)
    assert.equal(after.invoice.submissionStatus, "Submitted")
    assert.equal(after.invoice.onchainStatus, before.invoice.onchainStatus)
    assert.equal(after.invoice.advanceAmount, before.invoice.advanceAmount)
    assert.equal(after.advanceRequests.length, before.advanceRequests.length)
    assert.ok(after.timeline.some((e) => /GitHub repository/.test(e.description) && /simulated/i.test(e.description)))
    assert.ok(after.timeline.every((e) => e.simulated !== false), "mock timeline stays labelled simulated")
  })

  it("the simulated evaluation then follows the chosen outcome", async () => {
    const { m, invoiceId } = await fresh()
    const sub = await m.submitGithubRepository({ invoiceId, repositoryUrl: CANON, commitSha: SHA, note: "", simulatedOutcome: "fail" })
    const ev = await m.requestEvaluation(sub.submissionId)
    assert.equal(ev.passed, false)
  })

  it("rejects bad input with the same specific messages as the form", async () => {
    const { m, invoiceId } = await fresh()
    await assert.rejects(m.submitGithubRepository({ invoiceId, repositoryUrl: "https://example.com/a/b", commitSha: SHA, note: "" }), (e: unknown) => e instanceof DomainError && /github\.com/.test(e.message))
    await assert.rejects(m.submitGithubRepository({ invoiceId, repositoryUrl: CANON, commitSha: "abc1234", note: "" }), (e: unknown) => e instanceof DomainError && /short SHA/.test(e.message))
    assert.equal((await m.getInvoice(invoiceId)).submissions.length, 0)
  })

  it("keeps the usual rules: only the freelancer, only on a funded invoice", async () => {
    const { m, invoiceId } = await fresh()
    m.demo!.switchRole("client")
    await assert.rejects(m.submitGithubRepository({ invoiceId, repositoryUrl: CANON, commitSha: SHA, note: "" }), DomainError)
    m.demo!.switchRole("freelancer")
    const list = await m.listInvoices("freelancer", (await m.getSession()).wallet)
    const created = list.find((i) => i.onchainStatus === "Created")
    assert.ok(created)
    await assert.rejects(m.submitGithubRepository({ invoiceId: created.invoiceId, repositoryUrl: CANON, commitSha: SHA, note: "" }), (e: unknown) => e instanceof DomainError && e.code === "INVALID_STATUS")
  })
})

// ---- the UI source ------------------------------------------------------------------------------------------------------------

describe("freelancer UI", () => {
  const form = fs.readFileSync("components/duely/github-submission-form.tsx", "utf8")
  const page = fs.readFileSync("app/(app)/freelancer/invoices/[id]/page.tsx", "utf8")

  it("offers both options and keeps the file-upload flow", () => {
    assert.match(page, /File upload/)
    assert.match(page, /GitHub repository/)
    assert.match(page, /repo\.submitEvidence\(/)
    assert.match(page, /<GithubSubmissionForm /)
    assert.match(page, /hidden=\{kind !== "file"\}/, "both forms stay mounted")
  })

  it("collects the repository URL and the commit SHA, validates, and shows loading/error/success states", () => {
    assert.match(form, /id="repo-url"/)
    assert.match(form, /id="commit-sha"/)
    assert.match(form, /checkRepositoryUrl\(url\)/)
    assert.match(form, /checkCommitSha\(sha\)/)
    assert.match(form, /aria-invalid/)
    assert.match(form, /role="alert"/)
    assert.match(form, /Loader2/)
    assert.match(form, /Checking repository…/)
    assert.match(form, /submit\.error/)
    assert.match(form, /Repository submitted/)
  })

  it("submits through the repository method with the canonical form values, never raw fetch", () => {
    assert.match(form, /repo\.submitGithubRepository\(\{\s*invoiceId,\s*repositoryUrl: urlCheck\.value,\s*commitSha: shaCheck\.value,\s*note,/)
    assert.doesNotMatch(form, /\bfetch\(|XMLHttpRequest|api\/submissions/)
  })

  it("never presents a submission as a payment or triggers one", () => {
    assert.match(form, /This is not a payment/)
    assert.match(form, /No payment has been made/)
    assert.doesNotMatch(form, /requestAdvance|approveInvoice|disputeInvoice|depositReserve|fundInvoice/)
    assert.doesNotMatch(form, /Advance paid|paid \(|Payment (sent|complete)/i)
    assert.match(page, /Submitted, not paid/)
  })

  it("imports no server or AI module and renders no raw HTML; external links are safe", () => {
    for (const src of [form, page]) {
      assert.doesNotMatch(src, /@\/lib\/ai\/|@\/lib\/evidence\/(server|service)|@\/lib\/backend\/|server-only|dangerouslySetInnerHTML/)
    }
    assert.match(page, /target="_blank" rel="noopener noreferrer"/)
    assert.match(page, /githubLinks\(latest\.repositoryUrl, latest\.commitSha\)/, "links only come from strictly validated values")
  })

  it("is mobile-first and accessible: full-width controls, labels, descriptions, 16px+ inputs", () => {
    assert.match(form, /<Label htmlFor="repo-url">/)
    assert.match(form, /<Label htmlFor="commit-sha">/)
    assert.match(form, /aria-describedby=/)
    assert.match(form, /w-full sm:w-auto/)
    assert.match(form, /autoCapitalize="none"/)
    assert.match(form, /spellCheck=\{false\}/)
    assert.match(page, /grid grid-cols-2/)
    assert.match(page, /aria-pressed=\{kind === k\}/)
  })
})
