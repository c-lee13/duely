import { after, before, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import type { PGlite } from "@electric-sql/pglite"
import { createDb } from "./helpers/db"
import { startRenderer } from "./helpers/render"
import { Clock, FakeChain, FakeObjectStore, createPgEvidenceDb } from "./helpers/evidence"
import { ctx, createPgBackendDb, FakeChainAdapter, FakeSigner, http , TEST_SCOPE } from "./helpers/backend"
import { handleEvaluate, handleGetInvoice } from "@/lib/backend/handlers"
import { handleSubmissionPost } from "@/lib/evidence/submissions-http"
import type { EvidenceDeps } from "@/lib/evidence/service"
import type { BackendDeps } from "@/lib/backend/ports"
import { createGeminiEvaluator } from "@/lib/ai/evaluation-service"
import { validateGithubSubmission } from "@/lib/ai/github-submission"
import { toBundle, toEvaluationRecord, type ApiInvoiceDetail } from "@/lib/frontend/api-mappers"
import type { EvaluationRecord } from "@/lib/frontend/domain"
import { blockedReasonsOf, isGithubEvaluation, scoringNotesOf, splitReason, unverifiedReferenceCount, verdictOf, whyNotPassOf } from "@/lib/frontend/github-evaluation"
import { githubBlobLink, githubCommitLinks, isSafeSourcePath } from "@/lib/frontend/github-input"

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
const REPO = "acme/widgets"
const renderer = startRenderer()
after(() => renderer.close())
const panel = (e: EvaluationRecord, mandatory?: boolean[]) => renderer.render("github", { evaluation: e, mandatory })
/** React escapes text: one apostrophe is written as &#x27;. Compare on text with entities decoded. */
const text = (markup: string) => markup.replace(/<span role="presentation"[^>]*>x<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ")

// ---- the pure helpers ---------------------------------------------------------------------------------------------------------

describe("verdict, blocked reasons and reason sections", () => {
  const base = { criteriaResults: [], mandatory: [] as boolean[] }

  it("reads the verdict from the summary, but only a stored pass is ever a Pass", async () => {
    assert.equal(verdictOf({ ...base, summary: `Needs Review (83/100) for ${REPO}@${SHA}. x`, score: 83, passed: false }), "Needs Review")
    assert.equal(verdictOf({ ...base, summary: `Fail (30/100) for ${REPO}@${SHA}. x`, score: 30, passed: false }), "Fail")
    assert.equal(verdictOf({ ...base, summary: `Pass (100/100) for ${REPO}@${SHA}. x`, score: 100, passed: true }), "Pass")
    // the summary may not upgrade a non-pass, and a stored pass is a pass
    assert.equal(verdictOf({ ...base, summary: `Pass (100/100) for ${REPO}@${SHA}. x`, score: 100, passed: false }), "Needs Review")
    assert.equal(verdictOf({ ...base, summary: "Needs Review (50/100)", score: 50, passed: true }), "Pass")
  })

  it("falls back to the structured data when the summary can't be trusted", async () => {
    assert.equal(verdictOf({ ...base, summary: "", score: 40, passed: false }), "Fail")
    assert.equal(verdictOf({ ...base, summary: "gibberish", score: 70, passed: false }), "Needs Review")
    assert.equal(verdictOf({ ...base, summary: `Pass (70/100)`, score: 70, passed: false }), "Needs Review")
    assert.equal(verdictOf({ ...base, summary: `Needs Review (99/100)`, score: 70, passed: false }), "Needs Review", "a number that disagrees with the stored score is ignored")
    const mandatoryUnsupported = { criteriaResults: [{ criterion: "a", passed: false, reason: "", assessment: "unsupported" as const }], mandatory: [true] }
    assert.equal(verdictOf({ ...mandatoryUnsupported, summary: "", score: 70, passed: false }), "Fail")
  })

  it("extracts the blocked-approval reasons and the unverified-reference count", async () => {
    const s = `Needs Review (50/100) for ${REPO}@${SHA}. Score 50/100 is below the pass threshold of 80. A person should look at this before any decision. Automatic approval blocked: Source retrieval was incomplete. 2 requested file(s) were not read. 3 cited source reference(s) could not be verified and were not counted.`
    assert.deepEqual(blockedReasonsOf(s), ["Source retrieval was incomplete.", "2 requested file(s) were not read."])
    assert.equal(unverifiedReferenceCount(s), 3)
    assert.equal(scoringNotesOf(s), "Score 50/100 is below the pass threshold of 80. A person should look at this before any decision.")
    assert.deepEqual(blockedReasonsOf(`Pass (100/100) for ${REPO}@${SHA}. ok`), [])
    assert.equal(unverifiedReferenceCount("nothing here"), 0)
  })

  it("explains why a result is not a pass from the stored data", async () => {
    const e = {
      score: 70,
      passed: false,
      mandatory: [true, false],
      criteriaResults: [
        { criterion: "Hero", passed: false, reason: "", assessment: "partial" as const },
        { criterion: "Docs", passed: true, reason: "", assessment: "verified" as const },
      ],
    }
    const why = whyNotPassOf(e)
    assert.equal(why.length, 2)
    assert.match(why[0], /mandatory criterion must be verified.*“Hero”/)
    assert.match(why[1], /70 is below the pass threshold of 80/)
    assert.deepEqual(whyNotPassOf({ ...e, passed: true }), [])
  })

  it("splits the stored reason into explanation, missing, uncertainty and adjustments", async () => {
    const r = "The evidence supports only part of this criterion (counts as half). Evaluator note: Hero renders but has no CTA. Missing: The call-to-action button. Uncertain: Styles may live elsewhere."
    assert.deepEqual(splitReason(r), { explanation: "Hero renders but has no CTA.", missing: "The call-to-action button.", uncertain: "Styles may live elsewhere.", notes: [] })
    const d = "The evidence does not support this criterion. Evaluator note: Looks done. Missing: Not specified by the reviewer. Downgraded to unsupported: no valid file and line citation backed the claim."
    const parts = splitReason(d)
    assert.equal(parts.explanation, "Looks done.")
    assert.equal(parts.missing, "Not specified by the reviewer.")
    assert.deepEqual(parts.notes, ["Downgraded to unsupported: no valid file and line citation backed the claim."])
    assert.deepEqual(splitReason("Some unusual text"), { explanation: "Some unusual text", missing: null, uncertain: null, notes: [] })
    assert.equal(splitReason("").explanation, "")
  })
})

describe("safe links", () => {
  it("builds links that always name the exact commit, never a branch", async () => {
    assert.deepEqual(githubCommitLinks(REPO, SHA), { repo: `https://github.com/${REPO}`, commit: `https://github.com/${REPO}/commit/${SHA}` })
    assert.equal(githubBlobLink(REPO, SHA, "src/app.tsx", 2, 2), `https://github.com/${REPO}/blob/${SHA}/src/app.tsx#L2`)
    assert.equal(githubBlobLink(REPO, SHA, "src/app.tsx", 2, 9), `https://github.com/${REPO}/blob/${SHA}/src/app.tsx#L2-L9`)
    assert.equal(githubBlobLink(REPO, SHA, "src/my file#1.ts", 1, 1), `https://github.com/${REPO}/blob/${SHA}/src/my%20file%231.ts#L1`)
  })

  it("returns null for anything unexpected, so the UI shows text instead of a link", async () => {
    for (const repo of ["evil", "a/b/c", "../x/y", "a/b?x=1", "a b/c", "-a/b", "", "https://evil.com/a"]) assert.equal(githubCommitLinks(repo, SHA), null, repo)
    for (const sha of ["main", "A".repeat(40), "a".repeat(39), "", `${SHA}/../x`]) assert.equal(githubCommitLinks(REPO, sha), null, sha)
    for (const p of ["", "/etc/passwd", "../x.ts", "src/../../x.ts", "src//a.ts", "a\\b.ts", "src/\u0000a.ts", ".git/config", "src/", "javascript:alert(1)//".replace("//", "/..")]) {
      assert.equal(isSafeSourcePath(p), false, JSON.stringify(p))
      assert.equal(githubBlobLink(REPO, SHA, p, 1, 1), null, JSON.stringify(p))
    }
    for (const [a, b] of [[0, 1], [3, 2], [-1, 1], [1.5, 2], [1, 99_999_999], [Number.NaN, 1]] as Array<[number, number]>) assert.equal(githubBlobLink(REPO, SHA, "a.ts", a, b), null, `${a}-${b}`)
  })
})

// ---- mapping the data the backend returns ---------------------------------------------------------------------------------------

const stored = (over: Record<string, unknown> = {}) => ({
  criterion: "Includes a hero section.",
  passed: true,
  reason: "The evidence clearly supports this criterion. Evaluator note: Hero shown.",
  mandatory: true,
  assessment: "verified",
  evidenceQuote: "Plants, delivered weekly",
  weight: 34,
  points: 34,
  evidence: [{ path: "src/hero.tsx", startLine: 2, endLine: 2, quote: "Plants, delivered weekly" }],
  source: { kind: "github", repository: REPO, commitSha: SHA },
  ...over,
})
const apiEval = (results: unknown[], over: Record<string, unknown> = {}) =>
  ({
    evaluationId: "e1",
    submissionId: "s1",
    state: "completed",
    score: 100,
    passed: true,
    criteriaResults: results,
    summary: `Pass (100/100) for ${REPO}@${SHA}. ok`,
    criteriaHash: ("0x" + "1".repeat(64)) as `0x${string}`,
    criteriaVersion: 1,
    model: "gemini-test-model",
    promptVersion: "gemini-code-review-v1",
    passRule: "Score ≥ 80 and every mandatory criterion passes",
    simulated: false,
    evaluatedAt: "2026-11-01T12:00:00Z",
    ...over,
  }) as never

describe("toEvaluationRecord keeps the stored GitHub detail and drops anything malformed", () => {
  it("maps assessment, weight, points, evidence and the reviewed source", async () => {
    const r = toEvaluationRecord(apiEval([stored()]), "1")
    assert.equal(r.criteriaResults[0].assessment, "verified")
    assert.equal(r.criteriaResults[0].weight, 34)
    assert.equal(r.criteriaResults[0].points, 34)
    assert.deepEqual(r.criteriaResults[0].evidence, [{ path: "src/hero.tsx", startLine: 2, endLine: 2, quote: "Plants, delivered weekly" }])
    assert.deepEqual(r.source, { kind: "github", repository: REPO, commitSha: SHA })
    assert.deepEqual(r.mandatory, [true])
    assert.ok(isGithubEvaluation(r))
  })

  it("text evaluations map exactly as before: no GitHub fields, not a GitHub evaluation", async () => {
    const r = toEvaluationRecord(apiEval([{ criterion: "c", passed: true, reason: "ok", mandatory: true }], { summary: "Pass (100/100). ok", promptVersion: "gemini-classify-v1" }), "1")
    assert.deepEqual(r.criteriaResults[0], { criterion: "c", passed: true, reason: "ok" })
    assert.equal(r.source, undefined)
    assert.equal(isGithubEvaluation(r), false)
  })

  it("ignores wrong types and a source that isn't one consistent, valid GitHub commit", async () => {
    const r = toEvaluationRecord(
      apiEval([
        stored({ assessment: "excellent", weight: "34", points: -1, evidence: [{ path: 5 }, null, { path: "a.ts", startLine: "1", endLine: 2, quote: "q" }, { path: "ok.ts", startLine: 1, endLine: 1, quote: "q" }] }),
      ]),
      "1"
    )
    assert.equal(r.criteriaResults[0].assessment, undefined)
    assert.equal(r.criteriaResults[0].weight, undefined)
    assert.equal(r.criteriaResults[0].points, undefined)
    assert.deepEqual(r.criteriaResults[0].evidence, [{ path: "ok.ts", startLine: 1, endLine: 1, quote: "q" }])
    for (const source of [{ kind: "gitlab", repository: REPO, commitSha: SHA }, { kind: "github", repository: "../etc", commitSha: SHA }, { kind: "github", repository: REPO, commitSha: "main" }, null, "x"]) {
      assert.equal(toEvaluationRecord(apiEval([stored({ source })]), "1").source, undefined, JSON.stringify(source))
    }
    const mixed = toEvaluationRecord(apiEval([stored(), stored({ source: { kind: "github", repository: "other/repo", commitSha: SHA } })]), "1")
    assert.equal(mixed.source, undefined, "criterion results must agree on one source")
  })

  it("bounds what it keeps from untrusted text", async () => {
    const r = toEvaluationRecord(apiEval([stored({ evidence: [{ path: "a".repeat(900), startLine: 1, endLine: 1, quote: "q".repeat(900) }, ...Array.from({ length: 50 }, () => ({ path: "b.ts", startLine: 1, endLine: 1, quote: "q" }))] })]), "1")
    assert.ok(r.criteriaResults[0].evidence!.length <= 20)
    assert.ok(r.criteriaResults[0].evidence![0].path.length <= 400 && r.criteriaResults[0].evidence![0].quote.length <= 400)
  })
})

// ---- rendering --------------------------------------------------------------------------------------------------------------------

const record = (results: unknown[], over: Record<string, unknown> = {}) => toEvaluationRecord(apiEval(results, over), "1")

describe("the breakdown", () => {
  const three = [
    stored(),
    stored({
      criterion: "Includes a features section.",
      mandatory: false,
      assessment: "partial",
      passed: false,
      weight: 33,
      points: 16.5,
      reason: "The evidence supports only part of this criterion (counts as half). Evaluator note: Two of three cards. Missing: The pet-safe card. Uncertain: May be in another file.",
      evidence: [{ path: "src/features.tsx", startLine: 2, endLine: 4, quote: "Fresh every week" }],
    }),
    stored({ criterion: "Includes a contact section.", assessment: "unsupported", passed: false, weight: 33, points: 0, reason: "The evidence does not support this criterion. Evaluator note: No form. Missing: A contact form.", evidence: [] }),
  ]

  it("shows score, verdict, reviewed commit, and every criterion with weight, assessment and earned points", async () => {
    const e = record(three, { score: 50, passed: false, summary: `Fail (50/100) for ${REPO}@${SHA}. Mandatory criteria not supported by the evidence: "Includes a contact section.".` })
    const t = text(await panel(e))
    assert.match(t, /Code review/)
    assert.match(t, /Verdict: Fail/)
    assert.match(t, /\b50\b/)
    for (const c of ["Includes a hero section.", "Includes a features section.", "Includes a contact section."]) assert.ok(t.includes(c), c)
    assert.match(t, /34 of 34 points earned · weight 34/)
    assert.match(t, /16\.5 of 33 points earned · weight 33/)
    assert.match(t, /0 of 33 points earned · weight 33/)
    for (const label of ["Verified", "Partial", "Unsupported"]) assert.ok(t.includes(label), label)
    assert.match(t, /Mandatory/)
    assert.match(t, /Optional/)
    assert.match(t, /acme\/widgets/)
    assert.match(t, /aaaaaaa/)
    assert.match(t, /never run/)
    assert.match(t, /not the final arbiter/)
  })

  it("shows the reviewer's explanation, what is missing and what is uncertain for each criterion", async () => {
    const t = text(await panel(record(three, { score: 50, passed: false })))
    assert.match(t, /Reviewer's explanation: Hero shown\./)
    assert.match(t, /Reviewer's explanation: Two of three cards\./)
    assert.match(t, /Missing: The pet-safe card\./)
    assert.match(t, /Uncertain: May be in another file\./)
    assert.match(t, /Reviewer's explanation: No form\./)
    assert.match(t, /Missing: A contact form\./)
  })

  it("lists cited files and lines with links that name the exact commit", async () => {
    const m = await panel(record(three, { score: 50, passed: false }))
    assert.ok(m.includes(`href="https://github.com/${REPO}/blob/${SHA}/src/hero.tsx#L2"`))
    assert.ok(m.includes(`href="https://github.com/${REPO}/blob/${SHA}/src/features.tsx#L2-L4"`))
    assert.ok(m.includes(`href="https://github.com/${REPO}/commit/${SHA}"`))
    assert.ok(m.includes(`href="https://github.com/${REPO}"`))
    const t = text(m)
    assert.match(t, /src\/hero\.tsx:2/)
    assert.match(t, /src\/features\.tsx:2–4/)
    assert.match(t, /Plants, delivered weekly/)
    assert.match(t, /No verified code reference supports this criterion\./)
    const hrefs = [...m.matchAll(/href="([^"]+)"/g)].map((x) => x[1])
    assert.equal(hrefs.length, 4) // repository, commit, and the two criteria that cite code
    for (const h of hrefs) {
      assert.match(h, /^https:\/\/github\.com\//, h)
      assert.doesNotMatch(h, /\/(blob|tree)\/(main|master|HEAD)\b/, h)
    }
    assert.equal((m.match(/target="_blank"/g) ?? []).length, (m.match(/rel="noopener noreferrer"/g) ?? []).length)
  })

  it("explains why automatic approval was blocked", async () => {
    const e = record(
      [stored({ assessment: "partial", passed: false, points: 17, reason: "x Evaluator note: Looks right. Capped at partial: only part of the submitted source could be reviewed." })],
      {
        score: 50,
        passed: false,
        summary: `Needs Review (50/100) for ${REPO}@${SHA}. Mandatory criteria only partly supported. A person should look at this before any decision. Automatic approval blocked: Source retrieval was incomplete. 1 requested file(s) were not read. 2 cited source reference(s) could not be verified and were not counted.`,
      }
    )
    const m = await panel(e)
    const t = text(m)
    assert.match(t, /Automatic approval was blocked/)
    assert.match(t, /Source retrieval was incomplete\./)
    assert.match(t, /1 requested file\(s\) were not read\./)
    assert.match(t, /Some cited source references couldn't be verified in the code and were not counted/)
    assert.match(t, /Verdict: Needs review/)
    assert.match(t, /Why this isn't a pass/)
    assert.match(t, /Capped at partial: only part of the submitted source could be reviewed\./)
    assert.match(m, /role="alert"/)
  })

  it("a clean pass shows no blocked or why-not-pass notices", async () => {
    const t = text(await panel(record([stored()])))
    assert.match(t, /Verdict: Pass/)
    assert.doesNotMatch(t, /Automatic approval was blocked|Why this isn't a pass/)
  })

  it("is accessible and mobile-friendly: status is text not just colour, labelled lists, wrapping content", async () => {
    const m = await panel(record(three, { score: 50, passed: false }))
    assert.match(m, /aria-label="Criteria breakdown"/)
    assert.match(m, /role="img" aria-label="Score 50 out of 100"/)
    assert.match(m, /break-words/)
    assert.match(m, /break-all/)
    assert.ok(!/min-w-\[/.test(m), "no fixed minimum widths that would force horizontal scroll")
  })

  it("renders model- and repository-written text as inert text, and makes no link from unsafe values", async () => {
    const hostile = record(
      [
        stored({
          criterion: "<b>Criterion</b>",
          reason: "The evidence clearly supports this criterion. Evaluator note: <img src=x onerror=alert(1)> Missing: <script>alert(2)</script>",
          evidence: [
            { path: "../../etc/passwd", startLine: 1, endLine: 1, quote: "<script>alert(3)</script>" },
            { path: "javascript:alert(4)", startLine: 1, endLine: 1, quote: "q" },
            { path: "src/ok.ts", startLine: 5, endLine: 2, quote: "backwards" },
            { path: "src/ok.ts", startLine: 2, endLine: 3, quote: "good" },
          ],
        }),
      ],
      { summary: `Pass (100/100) for ${REPO}@${SHA}. <iframe src=//evil></iframe>` }
    )
    const m = await panel(hostile)
    for (const raw of ["<script>", "<img src=x", "<iframe", "<b>Criterion</b>"]) assert.ok(!m.includes(raw), raw)
    assert.ok(m.includes("&lt;script&gt;"))
    const hrefs = [...m.matchAll(/href="([^"]+)"/g)].map((x) => x[1])
    assert.ok(hrefs.every((h) => h.startsWith("https://github.com/")))
    assert.ok(!hrefs.some((h) => /passwd|evil|^javascript:/i.test(h)))
    assert.ok(hrefs.every((h) => h.startsWith(`https://github.com/${REPO}`)), "every link stays inside the reviewed repository")
    assert.ok(hrefs.filter((h) => /javascript/.test(h)).every((h) => h.includes(`/blob/${SHA}/javascript%3Aalert(4)#`)), "a file literally named like that is just an encoded path at the commit")
    assert.ok(hrefs.some((h) => h.endsWith("/src/ok.ts#L2-L3")))
    assert.match(text(m), /\.\.\/\.\.\/etc\/passwd:1/, "unsafe paths still shown, as plain text")
  })

  it("no links at all when the reviewed repository or commit is not valid", async () => {
    const e = { ...record([stored()]), source: { kind: "github" as const, repository: "evil/../x", commitSha: "main" } }
    const m = await panel(e)
    assert.ok(!m.includes("<a "))
    assert.match(text(m), /evil\/\.\.\/x at commit/)
  })

  it("falls back gracefully for a GitHub evaluation stored without per-criterion detail", async () => {
    const e = record([stored({ assessment: undefined, weight: undefined, points: undefined, evidence: undefined })])
    const t = text(await panel(e))
    assert.match(t, /Met/)
    assert.doesNotMatch(t, /points earned/)
    assert.match(t, /No verified code reference/)
  })
})

describe("the text-evidence evaluation UI is preserved", () => {
  const textEval = record([{ criterion: "Hero", passed: true, reason: "Seen in the evidence.", mandatory: true }], { summary: "Pass (100/100). All good.", promptVersion: "gemini-classify-v1" })

  it("still renders through EvaluationPanel with its original wording", async () => {
    const t = text(await renderer.render("text", { evaluation: textEval }))
    assert.match(t, /AI evaluation/)
    assert.match(t, /Recommended: pass/)
    assert.match(t, /1 of 1 criteria met/)
    assert.match(t, /Seen in the evidence\./)
    assert.doesNotMatch(t, /Code review|Cited code/)
  })

  it("the page chooses the GitHub breakdown only for GitHub evaluations", async () => {
    assert.equal(isGithubEvaluation(textEval), false)
    assert.equal(isGithubEvaluation(undefined), false)
    assert.equal(isGithubEvaluation({ ...record([stored()]), state: "running" } as EvaluationRecord), false, "running/error states keep the existing panel")
    const page = fs.readFileSync("app/(app)/freelancer/invoices/[id]/page.tsx", "utf8")
    assert.match(page, /isGithubEvaluation\(latestEval\) \?/)
    assert.match(page, /<GithubEvaluationPanel evaluation=\{latestEval\}/)
    assert.match(page, /<EvaluationPanel evaluation=\{latestEval\}/)
  })

  it("a blocked GitHub result gets its own next-step wording instead of blaming the work", () => {
    const page = fs.readFileSync("app/(app)/freelancer/invoices/[id]/page.tsx", "utf8")
    assert.match(page, /blocked=\{!e\.passed && blockedReasonsOf\(e\.summary \?\? ""\)\.length > 0\}/)
    assert.match(page, /if \(blocked\)\s+return \(/)
    assert.match(page, /needs a person&apos;s review/)
    assert.match(page, /doesn&apos;t necessarily mean the work falls short/)
    // the original wording is still there for an ordinary non-pass
    assert.match(page, /The AI recommends this work doesn&apos;t yet meet the criteria/)
  })

  it("the existing panel's code is unchanged by this feature", async () => {
    const parts = fs.readFileSync("components/duely/invoice-parts.tsx", "utf8")
    assert.doesNotMatch(parts, /github|source\./i)
  })
})

// ---- end to end: real backend data -> UI -------------------------------------------------------------------------------------------

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const U = { freelancer: id(1), client: id(2), stranger: id(3) }
const W = { freelancer: "0x" + "b".repeat(40), client: "0x" + "a".repeat(40), stranger: "0x" + "c".repeat(40), contract: "0x" + "e".repeat(40), token: "0x" + "d".repeat(40) }
const H = "0x" + "1".repeat(64)
const INV = id(401)

type Reply = { status?: number; body?: unknown }
interface GitHubState { repo: Reply; commit: Reply; tree: Reply; files: Record<string, Reply> }
const SOURCES: Record<string, string> = {
  "src/hero.tsx": "export const Hero = () => (\n  <h1>Plants, delivered weekly</h1>\n)\n",
  "src/features.tsx": "export const Features = () => (\n  <ul><li>Fresh every week</li></ul>\n)\n",
  "src/contact.tsx": 'export const Contact = () => (\n  <form><input name="email" /></form>\n)\n',
}
const fileBody = (path: string, t: string) => ({ type: "file", path, size: Buffer.byteLength(t), encoding: "base64", content: Buffer.from(t).toString("base64") })
const freshGh = (): GitHubState => ({
  repo: { body: { full_name: REPO, private: false, default_branch: "main" } },
  commit: { body: { sha: SHA, tree: { sha: TREE } } },
  tree: { body: { truncated: false, tree: Object.keys(SOURCES).map((p) => ({ path: p, type: "blob", size: SOURCES[p].length })) } },
  files: Object.fromEntries(Object.entries(SOURCES).map(([p, t]) => [p, { body: fileBody(p, t) }])),
})
let gh: GitHubState
const ghFetch = (async (input: string | URL | Request) => {
  const p = decodeURIComponent(new URL(String(input)).pathname)
  let r: Reply | undefined
  if (p === `/repos/${REPO}`) r = gh.repo
  else if (p === `/repos/${REPO}/git/commits/${SHA}`) r = gh.commit
  else if (p === `/repos/${REPO}/git/trees/${TREE}`) r = gh.tree
  else if (p.startsWith(`/repos/${REPO}/contents/`)) r = gh.files[p.replace(`/repos/${REPO}/contents/`, "")]
  if (!r) return new Response("{}", { status: 404 })
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 })
}) as unknown as typeof fetch

const cite = (path: string, line: number, quote: string) => ({ path, start_line: line, end_line: line, quote })
const crow = (rid: string, assessment: string, citations: unknown[], extra: Record<string, unknown> = {}) => ({
  id: rid,
  assessment,
  explanation: `${rid} explained.`,
  missing_functionality: assessment === "verified" ? null : `${rid} is incomplete.`,
  uncertainty: null,
  citations,
  ...extra,
})
const C1 = [cite("src/hero.tsx", 2, "Plants, delivered weekly")]
const C2 = [cite("src/features.tsx", 2, "Fresh every week")]
const C3 = [cite("src/contact.tsx", 2, '<input name="email" />')]
let codeReply: () => unknown

let db: PGlite
let store: FakeObjectStore
let evDeps: EvidenceDeps
let deps: BackendDeps

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
  store = new FakeObjectStore(new Clock())
  gh = freshGh()
  codeReply = () => ({ assessments: [crow("c1", "verified", C1), crow("c2", "verified", C2), crow("c3", "verified", C3)] })
  evDeps = { scope: TEST_SCOPE, db: createPgEvidenceDb(db), objects: store, chain: new FakeChain(), requireChainVerification: false, github: (u, s) => validateGithubSubmission(u, s, { fetch: ghFetch }) }
  const chain = new FakeChainAdapter()
  chain.available = false
  deps = {
    scope: TEST_SCOPE,
    db: createPgBackendDb(db),
    objects: store,
    chain,
    signer: new FakeSigner(),
    evaluator: createGeminiEvaluator({ model: "gemini-test-model", generate: async () => "{}", github: { fetch: ghFetch, generate: async () => JSON.stringify(codeReply()) } }),
  }
})

/** Submit a GitHub repository, evaluate it, then read the invoice exactly as the freelancer page would, and render the panel. */
async function endToEnd() {
  const sub = await handleSubmissionPost(
    new Request("http://localhost:3000/api/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ type: "github", invoiceId: INV, repositoryUrl: `https://github.com/${REPO}`, commitSha: SHA }),
    }),
    { userId: async () => U.freelancer, deps: () => evDeps }
  )
  assert.equal(sub.status, 201)
  const submissionId = ((await sub.json()) as { submissionId: string }).submissionId
  const ev = await http(handleEvaluate, ctx(U.freelancer, deps), { body: { submissionId } })
  assert.equal(ev.status, 201, JSON.stringify(ev.json))
  const res = await handleGetInvoice(new Request("http://localhost:3000/api/invoices/x"), ctx(U.freelancer, deps), { id: INV })
  const detail = (await res.json()) as ApiInvoiceDetail
  const bundle = toBundle(detail, [W.freelancer])
  const evaluation = bundle.evaluations.find((e) => e.submissionId === submissionId)
  assert.ok(evaluation)
  assert.ok(isGithubEvaluation(evaluation))
  const markup = await panel(evaluation)
  return { evaluation, markup, t: text(markup), submissionId }
}

describe("end to end: a real stored GitHub evaluation is displayed from what the backend returns", () => {
  it("a full pass", async () => {
    const { evaluation, markup, t } = await endToEnd()
    assert.equal(evaluation.score, 100)
    assert.deepEqual(evaluation.source, { kind: "github", repository: REPO, commitSha: SHA })
    assert.match(t, /Verdict: Pass/)
    assert.match(t, /34 of 34 points earned · weight 34/)
    assert.match(t, /33 of 33 points earned · weight 33/)
    assert.match(t, /Reviewer's explanation: c1 explained\./)
    assert.ok(markup.includes(`href="https://github.com/${REPO}/blob/${SHA}/src/hero.tsx#L2"`))
    assert.ok(markup.includes(`href="https://github.com/${REPO}/blob/${SHA}/src/contact.tsx#L2"`))
    assert.ok(markup.includes(`href="https://github.com/${REPO}/commit/${SHA}"`))
    assert.doesNotMatch(t, /Automatic approval was blocked/)
  })

  it("a partial result: points halve, the missing text appears, and it is not a pass", async () => {
    codeReply = () => ({ assessments: [crow("c1", "partial", C1), crow("c2", "verified", C2), crow("c3", "verified", C3)] })
    const { evaluation, t } = await endToEnd()
    assert.equal(evaluation.score, 83)
    assert.equal(evaluation.passed, false)
    assert.match(t, /Verdict: Needs review/)
    assert.match(t, /17 of 34 points earned/)
    assert.match(t, /Partial/)
    assert.match(t, /Missing: c1 is incomplete\./)
    assert.match(t, /Why this isn't a pass/)
    assert.match(t, /Every mandatory criterion must be verified\. Not verified: “Includes a hero section\.”/)
    assert.doesNotMatch(t, /Automatic approval was blocked/)
  })

  it("incomplete source retrieval: automatic approval is blocked and the reasons are explained", async () => {
    gh.tree = { body: { ...(gh.tree.body as object), truncated: true } }
    const { evaluation, t } = await endToEnd()
    assert.equal(evaluation.passed, false)
    assert.match(t, /Automatic approval was blocked/)
    assert.match(t, /Source retrieval was incomplete|truncated|incomplete/i)
    assert.match(t, /Verdict: (Needs review|Fail)/)
    assert.doesNotMatch(t, /Verdict: Pass/)
  })

  it("a fabricated citation is not shown as evidence and the unverified count is explained", async () => {
    codeReply = () => ({ assessments: [crow("c1", "verified", [cite("src/hero.tsx", 3, "Plants, delivered weekly")]), crow("c2", "verified", C2), crow("c3", "verified", C3)] })
    const { markup, t } = await endToEnd()
    assert.match(t, /Some cited source references couldn't be verified in the code and were not counted/)
    assert.match(t, /Unsupported/)
    assert.match(t, /No verified code reference supports this criterion\./)
    assert.ok(!markup.includes("hero.tsx#L3"))
  })
})

describe("scope", () => {
  it("is display-only: no payment, API or backend code in the new UI", async () => {
    for (const f of ["components/duely/github-evaluation.tsx", "lib/frontend/github-evaluation.ts"]) {
      const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      assert.doesNotMatch(src, /requestAdvance|approveInvoice|disputeInvoice|fundInvoice|\bfetch\(|useRepository|useAction|@\/lib\/ai\/|@\/lib\/backend\/|@\/lib\/evidence\/|server-only|dangerouslySetInnerHTML/, f)
    }
  })
})

// ---- the client invoice page ---------------------------------------------------------------------------------------------------

describe("client invoice page shows the same breakdown, to authorized parties only", () => {
  const readAs = async (user: string | null, mine: string[]) => {
    const res = await handleGetInvoice(new Request("http://localhost:3000/api/invoices/x"), ctx(user, deps), { id: INV })
    const body = (await res.json()) as ApiInvoiceDetail & { error?: unknown }
    return { status: res.status, body, bundle: res.status === 200 ? toBundle(body, mine) : null }
  }

  it("the client gets the identical evaluation data and renders the identical breakdown", async () => {
    codeReply = () => ({ assessments: [crow("c1", "partial", C1), crow("c2", "verified", C2), crow("c3", "verified", C3)] })
    const { evaluation: asFreelancer, markup: freelancerMarkup } = await endToEnd()
    const client = await readAs(U.client, [W.client])
    assert.equal(client.status, 200)
    const asClient = client.bundle!.evaluations.find((e) => e.submissionId === asFreelancer.submissionId)
    assert.ok(asClient && isGithubEvaluation(asClient))
    assert.equal(asClient.score, asFreelancer.score)
    assert.equal(asClient.passed, asFreelancer.passed)
    assert.deepEqual(asClient.source, asFreelancer.source)
    assert.deepEqual(asClient.criteriaResults, asFreelancer.criteriaResults)
    assert.deepEqual(asClient.mandatory, asFreelancer.mandatory)
    const clientMarkup = await panel(asClient)
    assert.equal(clientMarkup, freelancerMarkup, "the same component renders the same thing for both parties")
    const t = text(clientMarkup)
    assert.match(t, /Verdict: Needs review/)
    assert.match(t, /17 of 34 points earned/)
    assert.match(t, /Reviewer's explanation: c1 explained\./)
    assert.ok(clientMarkup.includes(`href="https://github.com/${REPO}/blob/${SHA}/src/hero.tsx#L2"`))
    assert.ok(clientMarkup.includes(`href="https://github.com/${REPO}/commit/${SHA}"`))
  })

  it("the client sees the blocked-approval explanation too", async () => {
    gh.tree = { body: { ...(gh.tree.body as object), truncated: true } }
    const { evaluation } = await endToEnd()
    const client = await readAs(U.client, [W.client])
    const e = client.bundle!.evaluations.find((x) => x.submissionId === evaluation.submissionId)!
    assert.match(text(await panel(e)), /Automatic approval was blocked/)
    assert.equal(e.passed, false)
  })

  it("the client's submission list carries the repository and commit for the submission card", async () => {
    await endToEnd()
    const client = await readAs(U.client, [W.client])
    assert.equal(client.bundle!.submissions[0].repositoryUrl, `https://github.com/${REPO}`)
    assert.equal(client.bundle!.submissions[0].commitSha, SHA)
  })

  it("a stranger, a signed-out visitor and an unrelated user get no evaluation data at all", async () => {
    await endToEnd()
    const stranger = await readAs(U.stranger, [W.stranger])
    assert.equal(stranger.status, 404)
    assert.equal(stranger.bundle, null)
    assert.doesNotMatch(JSON.stringify(stranger.body), /Includes a hero section|aaaaaaaa|gemini|explained/)
    const signedOut = await readAs(null, [])
    assert.equal(signedOut.status, 401)
    assert.doesNotMatch(JSON.stringify(signedOut.body), /Includes a hero section|aaaaaaaa|explained/)
  })

  it("an unverified wallet claim doesn't grant access either", async () => {
    await endToEnd()
    const claimant = id(9)
    await db.query("insert into auth.users (id, email) values ($1,'claimant@t.invalid') on conflict do nothing", [claimant])
    await db.query("insert into user_wallets (user_id, address) values ($1,$2) on conflict do nothing", [claimant, W.client])
    const r = await readAs(claimant, [])
    assert.ok([403, 404].includes(r.status), String(r.status))
    assert.doesNotMatch(JSON.stringify(r.body), /explained|Includes a hero section/)
  })

  describe("the page itself", () => {
    const page = fs.readFileSync("app/(app)/client/invoices/[id]/page.tsx", "utf8")

    it("uses the shared GitHub component only for GitHub evaluations and keeps EvaluationPanel for everything else", () => {
      assert.match(page, /import \{ GithubEvaluationPanel \} from "@\/components\/duely\/github-evaluation"/)
      assert.match(page, /isGithubEvaluation\(latestEval\) \? <GithubEvaluationPanel evaluation=\{latestEval\} \/> : <EvaluationPanel evaluation=\{latestEval\} \/>/)
      assert.equal((page.match(/<GithubEvaluationPanel /g) ?? []).length, 1)
      assert.doesNotMatch(page, /components\/duely\/github-evaluation"[\s\S]*function GithubEvaluation/, "no second copy of the component")
    })

    it("adds no approval, payment or advance action: the same three wallet actions as before", () => {
      const actions = [...page.matchAll(/useAction\(\(repo\) => repo\.(\w+)\(/g)].map((m) => m[1]).sort()
      assert.deepEqual(actions, ["approveInvoice", "disputeInvoice", "fundInvoice"])
      assert.doesNotMatch(page, /requestAdvance|requestEvaluation|submitEvidence|submitGithubRepository|depositReserve/)
      assert.doesNotMatch(page, /<GithubEvaluationPanel[^>]*nextStep/, "no advance prompt is injected for the client")
    })

    it("keeps the existing client UI: payment controls, file submission card and criteria", () => {
      for (const kept of ["Approve", "Dispute", "latest.fileName", "formatBytes(latest.fileSize)", "<CriteriaList invoice={invoice} />", "canClientApprove", "canClientDispute", "settlementProjection"]) {
        assert.ok(page.includes(kept), kept)
      }
      assert.match(page, /\{latestGithub \? \(/)
      assert.equal((page.match(/target="_blank"/g) ?? []).length, 2)
      assert.equal((page.match(/target="_blank" rel="noopener noreferrer"/g) ?? []).length, 2, "every external link opens safely")
      assert.match(page, /githubLinks\(latest\.repositoryUrl, latest\.commitSha\)/)
    })
  })
})
