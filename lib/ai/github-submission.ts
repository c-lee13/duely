/**
 * Standalone validator for a software-development submission: a public GitHub repository URL plus a full commit SHA.
 *
 * It confirms with GitHub's REST API that the repository (public) and the commit exist, then reads the commit's file
 * LISTING (the git tree, metadata only) and picks out the source-code files and their languages. It never downloads
 * blob contents, archives or clones, and never executes anything from the repository. It has no secrets, touches no
 * database, chain or AI module, and takes `fetch` as a parameter so tests never use the network.
 */

export type GithubErrorCode =
  | "INVALID_URL"
  | "INVALID_SHA"
  | "REPO_NOT_FOUND"
  | "REPO_NOT_PUBLIC"
  | "COMMIT_NOT_FOUND"
  | "RATE_LIMITED"
  | "GITHUB_UNAVAILABLE"
  | "GITHUB_API_ERROR"
  | "GITHUB_BAD_RESPONSE"

export interface GithubSubmissionError {
  code: GithubErrorCode
  message: string
}

export interface LanguageSummary {
  language: string
  files: number
  bytes: number
}

export interface GithubSubmissionMetadata {
  /** Canonical "owner/repo" as GitHub reports it. */
  repository: string
  repositoryUrl: string
  /** Full 40-character lowercase commit SHA. */
  commitSha: string
  treeSha: string
  defaultBranch: string | null
  /** Paths of relevant source-code files at this commit, sorted. May be capped; see `truncated`. */
  sourceFiles: string[]
  /** Source files found before any cap was applied to `sourceFiles`. */
  sourceFileCount: number
  /** Every file in the commit's tree (all kinds, before filtering). */
  totalFileCount: number
  languages: LanguageSummary[]
  /** True when the listing is known to be incomplete (GitHub truncated the tree, or `maxSourceFiles` was exceeded). */
  truncated: boolean
  warnings: string[]
}

export type GithubSubmissionResult = { ok: true; data: GithubSubmissionMetadata } | { ok: false; error: GithubSubmissionError }

export interface GithubValidatorOptions {
  fetch?: typeof fetch
  /** Optional token for rate limits (server-side only). Never required for public repositories. */
  token?: string
  /** Per-request timeout. Default 10s. */
  timeoutMs?: number
  /** Cap on returned `sourceFiles`. Default 2000. */
  maxSourceFiles?: number
}

const API = "https://api.github.com"
const SHA_RE = /^[0-9a-f]{40}$/i
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const FULL_NAME_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/

export function parseGithubRepoUrl(input: unknown): { owner: string; repo: string } | null {
  if (typeof input !== "string" || input.length > 300) return null
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "www.github.com")) return null
  if (url.username || url.password || url.port || url.search || url.hash) return null
  const parts = url.pathname.replace(/^\//, "").replace(/\/$/, "").split("/")
  if (parts.length !== 2) return null
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/i, "")
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null
  return { owner, repo }
}

export function parseCommitSha(input: unknown): string | null {
  return typeof input === "string" && SHA_RE.test(input.trim()) ? input.trim().toLowerCase() : null
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", sol: "Solidity", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", kts: "Kotlin", swift: "Swift",
  c: "C", h: "C", cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", cs: "C#", rb: "Ruby", php: "PHP", dart: "Dart",
  scala: "Scala", ex: "Elixir", exs: "Elixir", lua: "Lua", sh: "Shell", bash: "Shell", sql: "SQL",
  vue: "Vue", svelte: "Svelte", html: "HTML", css: "CSS", scss: "SCSS", move: "Move",
}

/** Directories that hold dependencies, build output or tooling state rather than the author's own source. */
const EXCLUDED_DIRS = new Set([
  "node_modules", "vendor", "dist", "build", "out", "target", ".git", ".next", ".nuxt", ".svelte-kit", "coverage",
  "__pycache__", ".venv", "venv", "env", ".gradle", "pods", "bower_components", ".turbo",
])

/** Language of a path if it is relevant hand-written source, else null. */
export function classifySourcePath(path: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(path)) return null
  const segments = path.split("/")
  const name = segments[segments.length - 1]
  if (segments.slice(0, -1).some((s) => EXCLUDED_DIRS.has(s.toLowerCase()))) return null
  const lower = name.toLowerCase()
  if (lower.endsWith(".min.js") || lower.endsWith(".min.css") || lower.endsWith(".d.ts") || lower.endsWith(".map")) return null
  const dot = lower.lastIndexOf(".")
  if (dot <= 0) return null
  return LANGUAGE_BY_EXTENSION[lower.slice(dot + 1)] ?? null
}

const fail = (code: GithubErrorCode, message: string): GithubSubmissionResult => ({ ok: false, error: { code, message } })

type Fetched = { ok: true; json: unknown } | { ok: false; result: GithubSubmissionResult; status?: number }

async function getJson(doFetch: typeof fetch, url: string, opts: GithubValidatorOptions): Promise<Fetched> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  let res: Response
  try {
    res = await doFetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) })
  } catch {
    return { ok: false, result: fail("GITHUB_UNAVAILABLE", "GitHub couldn't be reached. Try again shortly.") }
  }
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    return { ok: false, status: res.status, result: fail("RATE_LIMITED", "GitHub's rate limit was reached. Try again later.") }
  }
  if (!res.ok) {
    return { ok: false, status: res.status, result: fail("GITHUB_API_ERROR", `GitHub answered with an unexpected status (${res.status}).`) }
  }
  try {
    return { ok: true, json: await res.json() }
  } catch {
    return { ok: false, result: fail("GITHUB_BAD_RESPONSE", "GitHub returned a response that couldn't be read.") }
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const bad = () => fail("GITHUB_BAD_RESPONSE", "GitHub returned a response in an unexpected shape.")

export async function validateGithubSubmission(repoUrl: unknown, commitSha: unknown, options: GithubValidatorOptions = {}): Promise<GithubSubmissionResult> {
  const parsed = parseGithubRepoUrl(repoUrl)
  if (!parsed) return fail("INVALID_URL", "Enter a public repository URL like https://github.com/owner/repo.")
  const sha = parseCommitSha(commitSha)
  if (!sha) return fail("INVALID_SHA", "Enter the full 40-character commit SHA.")
  const doFetch = options.fetch ?? fetch
  const maxFiles = options.maxSourceFiles ?? 2000

  // 1. The repository exists and is public.
  const repoRes = await getJson(doFetch, `${API}/repos/${parsed.owner}/${parsed.repo}`, options)
  if (!repoRes.ok) {
    return repoRes.status === 404 ? fail("REPO_NOT_FOUND", "That repository wasn't found, or it isn't public.") : repoRes.result
  }
  const repo = repoRes.json
  if (!isObj(repo) || typeof repo.full_name !== "string" || !FULL_NAME_RE.test(repo.full_name) || typeof repo.private !== "boolean") return bad()
  if (repo.private) return fail("REPO_NOT_PUBLIC", "Only public repositories can be submitted.")
  const [, owner, name] = FULL_NAME_RE.exec(repo.full_name) as RegExpExecArray
  const defaultBranch = typeof repo.default_branch === "string" ? repo.default_branch : null

  // 2. The commit exists in that repository (its tree is what we list).
  const commitRes = await getJson(doFetch, `${API}/repos/${owner}/${name}/git/commits/${sha}`, options)
  if (!commitRes.ok) {
    return commitRes.status === 404 || commitRes.status === 422
      ? fail("COMMIT_NOT_FOUND", "That commit wasn't found in this repository.")
      : commitRes.result
  }
  const commit = commitRes.json
  if (!isObj(commit) || typeof commit.sha !== "string" || commit.sha.toLowerCase() !== sha) return bad()
  const treeSha = isObj(commit.tree) && typeof commit.tree.sha === "string" && SHA_RE.test(commit.tree.sha) ? commit.tree.sha.toLowerCase() : null
  if (!treeSha) return bad()

  // 3. The file listing at that commit: metadata only, no file contents.
  const treeRes = await getJson(doFetch, `${API}/repos/${owner}/${name}/git/trees/${treeSha}?recursive=1`, options)
  if (!treeRes.ok) {
    return treeRes.status === 404 ? fail("COMMIT_NOT_FOUND", "The file listing for that commit wasn't found.") : treeRes.result
  }
  const tree = treeRes.json
  if (!isObj(tree) || !Array.isArray(tree.tree)) return bad()

  const warnings: string[] = []
  let truncated = false
  if (tree.truncated === true) {
    truncated = true
    warnings.push("GitHub truncated the file listing for this commit (very large repository). Some files are missing.")
  }

  const files: Array<{ path: string; size: number }> = []
  let totalFileCount = 0
  for (const entry of tree.tree) {
    if (!isObj(entry) || typeof entry.path !== "string" || typeof entry.type !== "string") return bad()
    if (entry.type !== "blob") continue
    totalFileCount++
    files.push({ path: entry.path, size: typeof entry.size === "number" && entry.size >= 0 ? entry.size : 0 })
  }

  const byLanguage = new Map<string, LanguageSummary>()
  const source: string[] = []
  for (const f of files) {
    const language = classifySourcePath(f.path)
    if (!language) continue
    source.push(f.path)
    const s = byLanguage.get(language) ?? { language, files: 0, bytes: 0 }
    s.files++
    s.bytes += f.size
    byLanguage.set(language, s)
  }
  source.sort()
  if (source.length > maxFiles) {
    truncated = true
    warnings.push(`Found ${source.length} source files; only the first ${maxFiles} paths are listed.`)
  }
  if (source.length === 0) warnings.push("No source-code files were found at this commit.")

  return {
    ok: true,
    data: {
      repository: `${owner}/${name}`,
      repositoryUrl: `https://github.com/${owner}/${name}`,
      commitSha: sha,
      treeSha,
      defaultBranch,
      sourceFiles: source.slice(0, maxFiles),
      sourceFileCount: source.length,
      totalFileCount,
      languages: [...byLanguage.values()].sort((a, b) => b.files - a.files || a.language.localeCompare(b.language)),
      truncated,
      warnings,
    },
  }
}
