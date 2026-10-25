import { beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { DRAFT_RATE, handleDraftRequirements, resetDraftRateLimit, type DraftHandlerContext } from "@/lib/backend/requirements-draft-handler"
import { createGeminiRequirementsDrafter } from "@/lib/ai/requirements-draft-service"
import { requestAgreementDraft } from "@/lib/frontend/draft-api"
import type { RequirementsDraft } from "@/lib/ai/requirements-draft"
import type { AgreementDraft } from "@/lib/frontend/draft-types"

// Gemini is always a fake client here: no network, no key.
const DESCRIPTION = "I need a web app where users can sign in with Google and track their tasks."
const MODEL_JSON = {
  project_summary: "A task tracker.",
  scope: { in_scope: [{ text: "Google sign-in", origin: "requested", source_quote: "sign in with Google" }], out_of_scope: [] },
  deliverables: [{ title: "Web app", description: "Deployed app", origin: "suggested", source_quote: null }],
  acceptance_criteria: [{ text: "A user can sign in with Google", mandatory: true, verification: "manual_check", origin: "requested", source_quote: "sign in with Google" }],
  clarification_questions: [{ question: "Which hosting platform?", topic: "hosting_deployment", why_it_matters: "Deployment" }],
  commercial_mentions: [],
}
const ENV = { GEMINI_API_KEY: "test-key-not-real-0000", GEMINI_EVALUATION_MODEL: "test-model" }

function fakeClient(text: string | Error, calls: unknown[] = []) {
  return { models: { generateContent: async (a: unknown) => (calls.push(a), text instanceof Error ? Promise.reject(text) : { text }) } }
}

function ctx(over: Partial<DraftHandlerContext> & { client?: ReturnType<typeof fakeClient>; env?: Record<string, string> } = {}): DraftHandlerContext {
  const drafter = createGeminiRequirementsDrafter(over.env ?? ENV, over.client ?? fakeClient(JSON.stringify(MODEL_JSON)))
  return { userId: async () => "user-1", verifiedAddresses: async () => ["0xabc"], drafter: () => drafter, ...over }
}

async function post(c: DraftHandlerContext, body: unknown, opts: { origin?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (opts.origin !== null) headers.origin = opts.origin ?? "http://localhost:3000"
  const res = await handleDraftRequirements(new Request("http://localhost:3000/api/agreements/draft", { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) }), c)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as Record<string, any>, cache: res.headers.get("cache-control") }
}

beforeEach(() => resetDraftRateLimit())

describe("POST /api/agreements/draft", () => {
  it("returns a labelled draft for an authenticated client, with the original description untouched", async () => {
    const calls: unknown[] = []
    const r = await post(ctx({ client: fakeClient(JSON.stringify(MODEL_JSON), calls) }), { description: DESCRIPTION })
    assert.equal(r.status, 200)
    assert.equal(r.cache, "no-store")
    assert.equal(r.body.draft.originalDescription, DESCRIPTION)
    assert.equal(r.body.draft.draft, true)
    assert.equal(r.body.draft.status, "ai_draft_requires_review")
    assert.equal(r.body.draft.scope.inScope[0].origin, "requested")
    assert.equal(r.body.draft.deliverables[0].origin, "suggested")
    assert.equal(r.body.draft.clarificationQuestions.length, 1)
    assert.equal(calls.length, 1)
  })

  it("never leaks the API key or provider details in any response", async () => {
    const ok = await post(ctx(), { description: DESCRIPTION })
    const failed = await post(ctx({ client: fakeClient(new Error(`provider said key ${ENV.GEMINI_API_KEY} is bad`)) }), { description: DESCRIPTION })
    for (const r of [ok, failed]) assert.ok(!JSON.stringify(r.body).includes(ENV.GEMINI_API_KEY))
  })

  it("requires a signed-in user and a verified wallet, and does not call the model otherwise", async () => {
    const calls: unknown[] = []
    const client = fakeClient(JSON.stringify(MODEL_JSON), calls)
    const signedOut = await post(ctx({ client, userId: async () => null }), { description: DESCRIPTION })
    assert.equal(signedOut.status, 401)
    assert.equal(signedOut.body.error.code, "UNAUTHENTICATED")
    const noWallet = await post(ctx({ client, verifiedAddresses: async () => [] }), { description: DESCRIPTION })
    assert.equal(noWallet.status, 403)
    assert.equal(noWallet.body.error.code, "NO_VERIFIED_WALLET")
    assert.equal(calls.length, 0)
  })

  it("rejects cross-origin and origin-less requests", async () => {
    const calls: unknown[] = []
    const c = ctx({ client: fakeClient(JSON.stringify(MODEL_JSON), calls) })
    assert.equal((await post(c, { description: DESCRIPTION }, { origin: "https://evil.example" })).status, 403)
    assert.equal((await post(c, { description: DESCRIPTION }, { origin: null })).status, 403)
    assert.equal(calls.length, 0)
  })

  it("answers incomplete or malformed input with 400 and no model call", async () => {
    const calls: unknown[] = []
    const c = ctx({ client: fakeClient(JSON.stringify(MODEL_JSON), calls) })
    const short = await post(c, { description: "app" })
    assert.equal(short.status, 400)
    assert.equal(short.body.error.code, "INVALID_INPUT")
    assert.match(short.body.error.message, /at least a sentence/i)
    assert.equal((await post(c, { description: "x".repeat(4001) })).status, 400)
    assert.equal((await post(c, { description: 5 })).status, 400)
    assert.equal((await post(c, { description: DESCRIPTION, budget: "5000" })).status, 400, "unknown fields are refused")
    assert.equal((await post(c, null, { raw: "not json" })).status, 400)
    assert.equal(calls.length, 0)
  })

  it("reports Gemini not configured as 503 and calls nothing", async () => {
    const r = await post(ctx({ env: {} }), { description: DESCRIPTION })
    assert.equal(r.status, 503)
    assert.equal(r.body.error.code, "INTEGRATION_UNAVAILABLE")
  })

  it("reports a Gemini outage or unusable output as 502 with a generic message", async () => {
    for (const client of [fakeClient(new Error("boom")), fakeClient("not json"), fakeClient(JSON.stringify({ ...MODEL_JSON, budget: "5000 USD" }))]) {
      resetDraftRateLimit()
      const r = await post(ctx({ client }), { description: DESCRIPTION })
      assert.equal(r.status, 502)
      assert.equal(r.body.error.code, "DRAFT_FAILED")
      assert.ok(!/boom|budget/i.test(r.body.error.message))
    }
  })

  it("strips commercial and legal terms the model invents", async () => {
    const withBudget = { ...MODEL_JSON, scope: { in_scope: [{ text: "Delivered within 4 weeks for a budget of $2,000", origin: "suggested", source_quote: null }], out_of_scope: [] } }
    const r = await post(ctx({ client: fakeClient(JSON.stringify(withBudget)) }), { description: DESCRIPTION })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.draft.scope.inScope, [])
  })

  it("limits each user, not everyone, and recovers after the window", async () => {
    let t = 1_000_000
    const base = { now: () => t }
    for (let i = 0; i < DRAFT_RATE.max; i++) assert.equal((await post(ctx(base), { description: DESCRIPTION })).status, 200)
    const blocked = await post(ctx(base), { description: DESCRIPTION })
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body.error.code, "RATE_LIMITED")
    assert.equal((await post(ctx({ ...base, userId: async () => "user-2" }), { description: DESCRIPTION })).status, 200)
    t += DRAFT_RATE.windowMs + 1
    assert.equal((await post(ctx(base), { description: DESCRIPTION })).status, 200)
  })
})

describe("failure diagnostics (server log only)", () => {
  async function logged(client: ReturnType<typeof fakeClient>) {
    const lines: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => void lines.push(a.join(" "))
    try {
      const r = await post(ctx({ client }), { description: DESCRIPTION })
      return { r, log: lines.join("\n") }
    } finally {
      console.error = orig
    }
  }

  it("names the failing stage and a safe reason for each kind of failure, never the key, message or description", async () => {
    const apiErr = Object.assign(new Error(`bad request for ${DESCRIPTION} key ${ENV.GEMINI_API_KEY}`), { name: "ApiError", status: 404 })
    const cases: [ReturnType<typeof fakeClient>, RegExp][] = [
      [fakeClient(apiErr), /generate .*category: http_404/],
      [fakeClient(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })), /generate .*category: timeout .*\d+ms/],
      [fakeClient(Object.assign(new Error("overloaded"), { name: "ApiError", status: 503 })), /generate .*category: http_503/],
      [fakeClient(new TypeError("fetch failed")), /generate .*category: network/],
      [fakeClient(""), /parse .*\(empty\)/],
      [fakeClient("{not json"), /parse .*response length 9/],
      [fakeClient(JSON.stringify({ ...MODEL_JSON, project_summary: "x".repeat(601) })), /validation .*project_summary/],
    ]
    for (const [client, expected] of cases) {
      resetDraftRateLimit()
      const { r, log } = await logged(client)
      assert.equal(r.status, 502)
      assert.match(log, /agreement draft failed:/)
      assert.match(log, expected)
      assert.ok(!log.includes(ENV.GEMINI_API_KEY) && !log.includes(DESCRIPTION) && !log.includes("x".repeat(50)))
    }
  })
})

describe("browser helper requestAgreementDraft", () => {
  const json = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it("posts the description to the draft endpoint with same-origin credentials", async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const f = (async (url: string, init: RequestInit) => ((seen = { url, init }), new Response(JSON.stringify({ draft: { draft: true } }), { status: 200 }))) as unknown as typeof fetch
    const r = await requestAgreementDraft(DESCRIPTION, f)
    assert.equal(r.ok, true)
    assert.equal(seen!.url, "/api/agreements/draft")
    assert.equal(seen!.init.method, "POST")
    assert.equal(seen!.init.credentials, "same-origin")
    assert.deepEqual(JSON.parse(seen!.init.body as string), { description: DESCRIPTION })
  })

  it("turns error responses, network failures and junk into messages the UI can show", async () => {
    const e = await requestAgreementDraft(DESCRIPTION, json(502, { error: { code: "DRAFT_FAILED", message: "Try again." } }))
    assert.deepEqual(e, { ok: false, code: "DRAFT_FAILED", message: "Try again." })
    const n = await requestAgreementDraft(DESCRIPTION, (async () => { throw new Error("offline") }) as unknown as typeof fetch)
    assert.equal(n.ok === false && n.code, "NETWORK")
    const j = await requestAgreementDraft(DESCRIPTION, (async () => new Response("<html>", { status: 500 })) as unknown as typeof fetch)
    assert.equal(j.ok === false && j.code, "UNKNOWN")
    const odd = await requestAgreementDraft(DESCRIPTION, json(200, { nope: true }))
    assert.equal(odd.ok, false)
  })
})

describe("UI wiring (source checks)", () => {
  const page = fs.readFileSync("app/(app)/client/invoices/new/page.tsx", "utf8")
  const panel = fs.readFileSync("components/duely/agreement-draft-panel.tsx", "utf8")
  const client = fs.readFileSync("lib/frontend/draft-api.ts", "utf8")
  const route = fs.readFileSync("app/api/agreements/draft/route.ts", "utf8")

  it("the server draft type is assignable to the browser's copy of it", () => {
    const check = (d: RequirementsDraft): AgreementDraft => d
    assert.equal(typeof check, "function")
  })

  it("the client bundle imports no server module, Gemini SDK or secret", () => {
    for (const src of [panel, client]) {
      assert.ok(!/lib\/ai\//.test(src))
      assert.ok(!/server-only|@google\/genai|GEMINI|process\.env/.test(src))
    }
  })

  it("the button sits beside the description field, is labelled, and is gated on a live backend and a real description", () => {
    assert.match(page, /Generate Agreement with AI/)
    assert.match(page, /label="Description"[\s\S]*action=\{[\s\S]*Generate Agreement with AI/)
    assert.match(page, /disabled=\{!live \|\| !descriptionReady/)
  })

  it("accepting a draft never creates, funds, signs or rewrites the description", () => {
    const accept = page.slice(page.indexOf("function acceptDraft"), page.indexOf("function move"))
    assert.ok(!/createInvoice|fundInvoice|create\.run|submit\(|router\.push|setDescription|setStep/.test(accept))
    assert.ok(!/createInvoice|fundInvoice|setDescription/.test(panel))
  })

  it("labels the output as an unsigned draft that is not legally approved", () => {
    assert.match(panel, /Unsigned AI draft/)
    assert.match(panel, /not legally approved/)
    assert.match(page, /Unsigned draft/)
  })

  it("suggestions start unchecked and the endpoint is a thin wrapper", () => {
    assert.match(panel, /include: i\.origin === "requested"/)
    assert.match(route, /handleDraftRequirements\(request, draftHandlerContext\)/)
  })
})
