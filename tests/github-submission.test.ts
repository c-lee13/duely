import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { classifySourcePath, parseCommitSha, parseGithubRepoUrl, validateGithubSubmission } from "@/lib/ai/github-submission"

const SHA = "a".repeat(40)
const TREE = "b".repeat(40)
const URL_OK = "https://github.com/acme/widgets"

type Route = { status?: number; body?: unknown; headers?: Record<string, string>; throws?: boolean; rawText?: string }

/** A fake fetch keyed by URL substring. Records every call; any unmatched URL fails the test (no real network). */
function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = []
  const fn = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const key = Object.keys(routes).find((k) => url.includes(k))
    if (!key) throw new Error(`unexpected request: ${url}`)
    const r = routes[key]
    if (r.throws) throw new TypeError("fetch failed")
    return new Response(r.rawText ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const repoOk = { full_name: "acme/widgets", private: false, default_branch: "main" }
const commitOk = { sha: SHA, tree: { sha: TREE } }
const treeOf = (paths: Array<string | [string, number]>, truncated = false) => ({
  truncated,
  tree: [
    { path: "src", type: "tree" },
    ...paths.map((p) => (Array.isArray(p) ? { path: p[0], type: "blob", size: p[1] } : { path: p, type: "blob", size: 10 })),
    { path: "vendored", type: "commit" },
  ],
})
const happy = (tree = treeOf(["src/index.ts", "src/app.tsx", "README.md", "contracts/Vault.sol"])) =>
  fakeFetch({ "/repos/acme/widgets/git/trees/": { body: tree }, "/git/commits/": { body: commitOk }, "/repos/acme/widgets": { body: repoOk } })

describe("input validation", () => {
  it("accepts plain, .git and trailing-slash repository URLs", () => {
    for (const u of [URL_OK, `${URL_OK}.git`, `${URL_OK}/`, "https://www.github.com/acme/widgets", "  https://github.com/acme/widgets "]) {
      assert.deepEqual(parseGithubRepoUrl(u), { owner: "acme", repo: "widgets" }, u)
    }
  })

  it("rejects other hosts, schemes, extra path parts, credentials, ports, queries and junk", () => {
    for (const u of [
      "http://github.com/acme/widgets",
      "https://gitlab.com/acme/widgets",
      "https://github.com.evil.com/acme/widgets",
      "https://evil.com/github.com/acme/widgets",
      "https://github.com/acme",
      "https://github.com/acme/widgets/tree/main",
      "https://user:pw@github.com/acme/widgets",
      "https://github.com:8443/acme/widgets",
      "https://github.com/acme/widgets?x=1",
      "https://github.com/acme/widgets#readme",
      "https://github.com/-acme/widgets",
      "https://github.com/acme/..",
      "git@github.com:acme/widgets.git",
      "github.com/acme/widgets",
      "",
      "https://github.com/",
      `https://github.com/acme/${"x".repeat(400)}`,
      42,
      null,
      undefined,
    ]) {
      assert.equal(parseGithubRepoUrl(u), null, String(u))
    }
  })

  it("accepts only a full 40-hex SHA and lowercases it", () => {
    assert.equal(parseCommitSha("A".repeat(40)), SHA)
    for (const s of ["abc1234", "a".repeat(39), "a".repeat(41), "g".repeat(40), "main", "HEAD", `${SHA}\n`.replace("\n", "x"), "", null, 5]) {
      assert.equal(parseCommitSha(s), null, String(s))
    }
  })

  it("returns INVALID_URL / INVALID_SHA without any request", async () => {
    const { fn, calls } = happy()
    const a = await validateGithubSubmission("https://example.com/a/b", SHA, { fetch: fn })
    assert.deepEqual(a.ok === false && a.error.code, "INVALID_URL")
    const b = await validateGithubSubmission(URL_OK, "main", { fetch: fn })
    assert.deepEqual(b.ok === false && b.error.code, "INVALID_SHA")
    assert.equal(calls.length, 0)
  })
})

describe("successful validation", () => {
  it("returns repository, commit, source paths and languages", async () => {
    const { fn, calls } = happy()
    const r = await validateGithubSubmission(URL_OK, SHA.toUpperCase(), { fetch: fn })
    assert.ok(r.ok)
    assert.equal(r.data.repository, "acme/widgets")
    assert.equal(r.data.repositoryUrl, URL_OK)
    assert.equal(r.data.commitSha, SHA)
    assert.equal(r.data.treeSha, TREE)
    assert.equal(r.data.defaultBranch, "main")
    assert.deepEqual(r.data.sourceFiles, ["contracts/Vault.sol", "src/app.tsx", "src/index.ts"])
    assert.equal(r.data.sourceFileCount, 3)
    assert.equal(r.data.totalFileCount, 4) // blobs only: trees and submodule entries are not files
    assert.deepEqual(r.data.languages, [
      { language: "TypeScript", files: 2, bytes: 20 },
      { language: "Solidity", files: 1, bytes: 10 },
    ])
    assert.equal(r.data.truncated, false)
    assert.deepEqual(r.data.warnings, [])
    // Only metadata endpoints: repo, git commit, git tree. Never contents/archive/raw/zipball/blobs.
    assert.equal(calls.length, 3)
    for (const c of calls) {
      assert.ok(c.startsWith("https://api.github.com/repos/acme/widgets"), c)
      assert.doesNotMatch(c, /contents|zipball|tarball|archive|raw\.|\/blobs\//)
    }
  })

  it("uses GitHub's canonical name when the repository was renamed", async () => {
    const renamed = fakeFetch({
      "/repos/acme/gadgets/git/trees/": { body: treeOf(["a.py"]) },
      "/repos/acme/gadgets/git/commits/": { body: commitOk },
      "/repos/acme/widgets": { body: { ...repoOk, full_name: "acme/gadgets" } },
    })
    const r = await validateGithubSubmission(URL_OK, SHA, { fetch: renamed.fn })
    assert.ok(r.ok)
    assert.equal(r.data.repository, "acme/gadgets")
  })

  it("sends a bearer token only when one is supplied", async () => {
    const seen: Array<string | null> = []
    const base = happy().fn
    const spy = (async (url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"))
      return base(url, init)
    }) as unknown as typeof fetch
    await validateGithubSubmission(URL_OK, SHA, { fetch: spy })
    await validateGithubSubmission(URL_OK, SHA, { fetch: spy, token: "t0ken" })
    assert.deepEqual(seen, [null, null, null, "Bearer t0ken", "Bearer t0ken", "Bearer t0ken"])
  })
})

describe("source-file detection", () => {
  it("keeps hand-written source and drops dependencies, build output, minified, typings and non-code", () => {
    const keep = ["src/a.ts", "app/page.tsx", "lib/util.js", "x.py", "main.go", "src/lib.rs", "App.java", "a/b/c.sol", "styles/site.css", "index.html", "db/schema.sql", "run.sh"]
    const drop = [
      "node_modules/react/index.js",
      "pkg/node_modules/x/y.js",
      "vendor/lib.go",
      "dist/bundle.js",
      "build/out.js",
      ".next/server/a.js",
      "target/debug/x.rs",
      "public/app.min.js",
      "styles/site.min.css",
      "types/global.d.ts",
      "bundle.js.map",
      "README.md",
      "package.json",
      "package-lock.json",
      "logo.png",
      "LICENSE",
      "Makefile",
      ".gitignore",
      "src/bad\u0000name.ts",
    ]
    for (const p of keep) assert.notEqual(classifySourcePath(p), null, p)
    for (const p of drop) assert.equal(classifySourcePath(p), null, p)
  })

  it("is case-insensitive on extensions and maps languages", () => {
    assert.equal(classifySourcePath("A.TS"), "TypeScript")
    assert.equal(classifySourcePath("a.mjs"), "JavaScript")
    assert.equal(classifySourcePath("a.sol"), "Solidity")
    assert.equal(classifySourcePath("a.cpp"), "C++")
  })

  it("warns, but still succeeds, when no source files exist", async () => {
    const r = await validateGithubSubmission(URL_OK, SHA, { fetch: happy(treeOf(["README.md", "logo.png"])).fn })
    assert.ok(r.ok)
    assert.deepEqual(r.data.sourceFiles, [])
    assert.equal(r.data.languages.length, 0)
    assert.match(r.data.warnings.join(" "), /No source-code files/)
  })
})

describe("truncation", () => {
  it("flags a listing GitHub itself truncated", async () => {
    const r = await validateGithubSubmission(URL_OK, SHA, { fetch: happy(treeOf(["a.ts"], true)).fn })
    assert.ok(r.ok)
    assert.equal(r.data.truncated, true)
    assert.match(r.data.warnings.join(" "), /truncated/i)
  })

  it("caps the returned paths, keeps the true count, and flags it", async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`)
    const r = await validateGithubSubmission(URL_OK, SHA, { fetch: happy(treeOf(paths)).fn, maxSourceFiles: 5 })
    assert.ok(r.ok)
    assert.equal(r.data.sourceFiles.length, 5)
    assert.equal(r.data.sourceFileCount, 12)
    assert.equal(r.data.languages[0].files, 12)
    assert.equal(r.data.truncated, true)
  })
})

describe("failures", () => {
  const code = async (routes: Record<string, Route>) => {
    const r = await validateGithubSubmission(URL_OK, SHA, { fetch: fakeFetch(routes).fn })
    assert.equal(r.ok, false)
    return r.ok ? "" : r.error.code
  }
  const okRoutes = (over: Record<string, Route>) => ({
    "/git/trees/": { body: treeOf(["a.ts"]) },
    "/git/commits/": { body: commitOk },
    "/repos/acme/widgets": { body: repoOk },
    ...over,
  })

  it("repository not found / not public", async () => {
    assert.equal(await code(okRoutes({ "/repos/acme/widgets": { status: 404 } })), "REPO_NOT_FOUND")
    assert.equal(await code(okRoutes({ "/repos/acme/widgets": { body: { ...repoOk, private: true } } })), "REPO_NOT_PUBLIC")
  })

  it("commit not found (404 or 422) and tree not found", async () => {
    assert.equal(await code(okRoutes({ "/git/commits/": { status: 404 } })), "COMMIT_NOT_FOUND")
    assert.equal(await code(okRoutes({ "/git/commits/": { status: 422 } })), "COMMIT_NOT_FOUND")
    assert.equal(await code(okRoutes({ "/git/trees/": { status: 404 } })), "COMMIT_NOT_FOUND")
  })

  it("a commit that is not the one asked for is rejected", async () => {
    assert.equal(await code(okRoutes({ "/git/commits/": { body: { sha: "c".repeat(40), tree: { sha: TREE } } } })), "GITHUB_BAD_RESPONSE")
  })

  it("rate limiting (429, or 403 with no quota left)", async () => {
    assert.equal(await code(okRoutes({ "/repos/acme/widgets": { status: 429 } })), "RATE_LIMITED")
    assert.equal(await code(okRoutes({ "/git/commits/": { status: 403, headers: { "x-ratelimit-remaining": "0" } } })), "RATE_LIMITED")
    assert.equal(await code(okRoutes({ "/git/commits/": { status: 403 } })), "GITHUB_API_ERROR")
  })

  it("server errors and network failures", async () => {
    assert.equal(await code(okRoutes({ "/repos/acme/widgets": { status: 500 } })), "GITHUB_API_ERROR")
    assert.equal(await code(okRoutes({ "/git/trees/": { status: 502 } })), "GITHUB_API_ERROR")
    assert.equal(await code(okRoutes({ "/repos/acme/widgets": { throws: true } })), "GITHUB_UNAVAILABLE")
    assert.equal(await code(okRoutes({ "/git/trees/": { throws: true } })), "GITHUB_UNAVAILABLE")
  })

  it("malformed responses", async () => {
    assert.equal(await code(okRoutes({ "/repos/acme/widgets": { rawText: "<html>" } })), "GITHUB_BAD_RESPONSE")
    assert.equal(await code(okRoutes({ "/repos/acme/widgets": { body: { private: false } } })), "GITHUB_BAD_RESPONSE")
    assert.equal(await code(okRoutes({ "/repos/acme/widgets": { body: { ...repoOk, full_name: "../../etc" } } })), "GITHUB_BAD_RESPONSE")
    assert.equal(await code(okRoutes({ "/git/commits/": { body: { sha: SHA } } })), "GITHUB_BAD_RESPONSE")
    assert.equal(await code(okRoutes({ "/git/trees/": { body: { truncated: false } } })), "GITHUB_BAD_RESPONSE")
    assert.equal(await code(okRoutes({ "/git/trees/": { body: { tree: [{ type: "blob" }] } } })), "GITHUB_BAD_RESPONSE")
  })

  it("error messages never echo the response body", async () => {
    const r = await validateGithubSubmission(URL_OK, SHA, { fetch: fakeFetch(okRoutes({ "/repos/acme/widgets": { status: 500, rawText: "SECRET-INTERNAL-DETAIL" } })).fn })
    assert.ok(!r.ok)
    assert.doesNotMatch(JSON.stringify(r), /SECRET-INTERNAL-DETAIL/)
  })
})

describe("isolation", () => {
  const src = fs.readFileSync("lib/ai/github-submission.ts", "utf8")

  it("is standalone: no AI, scoring, backend, database, chain or frontend imports", () => {
    assert.doesNotMatch(src, /^\s*import\s/m)
  })

  it("never fetches file contents, archives or runs code", () => {
    assert.doesNotMatch(src, /child_process|\beval\(|new Function|(?<![.\w])exec(Sync|File)?\(|spawn|zipball|tarball|\/contents\/|\/blobs\/|raw\.githubusercontent/)
  })

  it("is only wired in through lib/ai/evaluation-service.ts, never into scoring, assessment, routes or the backend core", () => {
    for (const f of ["lib/backend/evaluation.ts", "lib/backend/server.ts", "lib/ai/assessment.ts", "lib/ai/scoring.ts"]) {
      assert.doesNotMatch(fs.readFileSync(f, "utf8"), /github-submission/, f)
    }
  })
})
