import { classifySourcePath, type GithubSubmissionMetadata } from "./github-submission"

/**
 * Standalone retrieval of source-file CONTENTS from a validated GitHub commit.
 *
 * Input is the validator's metadata (repository + commit SHA + listing) and the paths to read. Every file is requested
 * with `?ref=<the exact 40-hex commit SHA>`, never a branch, so the bytes are the ones that were validated. Contents come
 * back through GitHub's JSON contents API and are decoded as TEXT only. Nothing is written to disk, extracted, imported,
 * evaluated or executed, and no archive or clone is used.
 *
 * Everything returned in `content` is UNTRUSTED DATA written by the repository's author. It may contain instructions
 * aimed at a model, secrets, or hostile markup. Callers must treat it as quoted material, never as instructions.
 *
 * Retrieval is all-or-flagged: any file that could not be read is listed in `skipped`, and `complete` is false unless
 * every requested file was read AND the request covered the repository's whole source listing. A missing file must never
 * be read as "verified".
 */

export const DEFAULT_LIMITS = {
  /** Largest single file accepted, in bytes. */
  maxFileBytes: 128 * 1024,
  /** Largest total of all returned contents, in bytes. */
  maxTotalBytes: 512 * 1024,
  /** Most files requested in one retrieval (each is one GitHub request). */
  maxFiles: 60,
} as const

export type SkipReason =
  | "unsafe_path"
  | "not_source_file"
  | "not_in_validated_listing"
  | "too_many_files"
  | "too_large"
  | "total_limit"
  | "binary"
  | "not_a_file"
  | "not_found"
  | "bad_response"
  | "rate_limited"
  | "unavailable"
  | "api_error"

export interface SkippedFile {
  path: string
  reason: SkipReason
  message: string
}

export interface RetrievedFile {
  path: string
  language: string
  /** UNTRUSTED repository text. */
  content: string
  bytes: number
}

export interface SourceRetrieval {
  repository: string
  commitSha: string
  /** Always true: a reminder in the data itself that `files[].content` is untrusted repository input. */
  untrusted: true
  files: RetrievedFile[]
  skipped: SkippedFile[]
  requestedCount: number
  totalBytes: number
  /** True ONLY if every requested file was read and the request covered the whole, untruncated source listing. */
  complete: boolean
  incompleteReasons: string[]
  warnings: string[]
}

export type SourceRetrievalErrorCode = "INVALID_REPOSITORY" | "INVALID_SHA" | "INVALID_PATHS"

export type SourceRetrievalResult =
  | { ok: true; data: SourceRetrieval }
  | { ok: false; error: { code: SourceRetrievalErrorCode; message: string } }

export interface SourceRetrievalOptions {
  fetch?: typeof fetch
  /** Optional token for rate limits (server-side only). */
  token?: string
  timeoutMs?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  maxFiles?: number
}

export type ValidatedCommit = Pick<GithubSubmissionMetadata, "repository" | "commitSha" | "sourceFiles" | "sourceFileCount" | "truncated">

const API = "https://api.github.com"
const SHA_RE = /^[0-9a-f]{40}$/
const FULL_NAME_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/
const MAX_PATH_LENGTH = 400
const MAX_SEGMENTS = 30
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** A repository-relative path that cannot escape the repo, address a hidden/internal location, or smuggle control characters. */
export function isSafeRepoPath(path: unknown): path is string {
  if (typeof path !== "string" || path === "" || path.length > MAX_PATH_LENGTH) return false
  if (/[\u0000-\u001f\u007f\\]/.test(path) || path.startsWith("/") || path.endsWith("/") || path.includes("//")) return false
  const segments = path.split("/")
  if (segments.length > MAX_SEGMENTS) return false
  return segments.every((s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git" && s.trim() === s)
}

const skip = (path: string, reason: SkipReason, message: string): SkippedFile => ({ path, reason, message })

/** Reads at most `cap` characters of a response body, or returns null if it is larger (the rest is discarded unread). */
async function readCapped(res: Response, cap: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined)
    return null
  }
  if (!res.body) return ""
  const reader = res.body.getReader()
  const decoder = new TextDecoder("utf-8")
  let text = ""
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > cap) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

type FileOutcome = { file: RetrievedFile } | { skipped: SkippedFile }

async function fetchOne(
  doFetch: typeof fetch,
  repo: { owner: string; name: string },
  sha: string,
  path: string,
  language: string,
  opts: SourceRetrievalOptions,
  maxFileBytes: number,
  budgetLeft: number
): Promise<FileOutcome> {
  const url = `${API}/repos/${repo.owner}/${repo.name}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`

  let res: Response
  try {
    res = await doFetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) })
  } catch {
    return { skipped: skip(path, "unavailable", "GitHub couldn't be reached for this file.") }
  }
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    await res.body?.cancel().catch(() => undefined)
    return { skipped: skip(path, "rate_limited", "GitHub's rate limit was reached.") }
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined)
    return { skipped: skip(path, "not_found", "This file doesn't exist at the validated commit.") }
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    return { skipped: skip(path, "api_error", `GitHub answered with an unexpected status (${res.status}).`) }
  }

  // base64 expands by 4/3; allow headroom for the JSON envelope. Anything larger cannot be an in-limit file.
  const text = await readCapped(res, Math.ceil((maxFileBytes * 4) / 3) + 8192).catch(() => undefined)
  if (text === undefined) return { skipped: skip(path, "unavailable", "The file download was interrupted.") }
  if (text === null) return { skipped: skip(path, "too_large", `File exceeds the ${maxFileBytes}-byte per-file limit.`) }

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { skipped: skip(path, "bad_response", "GitHub returned a response that couldn't be read.") }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    // A directory listing comes back as an array.
    return { skipped: skip(path, Array.isArray(body) ? "not_a_file" : "bad_response", Array.isArray(body) ? "This path is a directory, not a file." : "GitHub returned a response in an unexpected shape.") }
  }
  const b = body as Record<string, unknown>
  if (b.type !== "file") return { skipped: skip(path, "not_a_file", "This path is not a regular file (symlink, submodule or directory).") }
  if (typeof b.size !== "number" || !Number.isInteger(b.size) || b.size < 0) return { skipped: skip(path, "bad_response", "GitHub returned a response in an unexpected shape.") }
  if (b.size > maxFileBytes) return { skipped: skip(path, "too_large", `File exceeds the ${maxFileBytes}-byte per-file limit.`) }
  if (b.size > budgetLeft) return { skipped: skip(path, "total_limit", "Including this file would exceed the total content limit.") }
  if (b.encoding !== "base64" || typeof b.content !== "string") return { skipped: skip(path, "bad_response", "GitHub returned the file in an unexpected encoding.") }
  if (typeof b.path === "string" && b.path !== path) return { skipped: skip(path, "bad_response", "GitHub returned a different file than requested.") }

  const compact = b.content.replace(/\n/g, "")
  if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) return { skipped: skip(path, "bad_response", "The file content wasn't valid base64.") }
  const bytes = Buffer.from(compact, "base64")
  if (bytes.length !== b.size) return { skipped: skip(path, "bad_response", "The file's size didn't match its reported size.") }

  // Text only: NUL bytes or invalid UTF-8 mean binary (or a corrupt/odd encoding), which is never handed on.
  if (bytes.includes(0)) return { skipped: skip(path, "binary", "Binary file skipped.") }
  let content: string
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return { skipped: skip(path, "binary", "File isn't valid UTF-8 text and was skipped.") }
  }
  if (/[\u0001-\u0008\u000e-\u001a\u001c-\u001f\u007f]/.test(content)) return { skipped: skip(path, "binary", "File contains control characters and was skipped.") }

  return { file: { path, language, content, bytes: bytes.length } }
}

export async function retrieveGithubSource(commit: ValidatedCommit, paths: unknown, options: SourceRetrievalOptions = {}): Promise<SourceRetrievalResult> {
  const nameMatch = typeof commit?.repository === "string" ? FULL_NAME_RE.exec(commit.repository) : null
  if (!nameMatch) return { ok: false, error: { code: "INVALID_REPOSITORY", message: "The repository must be a validated owner/repo name." } }
  if (typeof commit.commitSha !== "string" || !SHA_RE.test(commit.commitSha)) {
    return { ok: false, error: { code: "INVALID_SHA", message: "A full lowercase 40-character commit SHA from the validator is required." } }
  }
  if (!Array.isArray(paths) || paths.length === 0 || !Array.isArray(commit.sourceFiles)) {
    return { ok: false, error: { code: "INVALID_PATHS", message: "Provide a non-empty list of source-file paths from the validated listing." } }
  }

  const maxFileBytes = options.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes
  const maxFiles = options.maxFiles ?? DEFAULT_LIMITS.maxFiles
  const doFetch = options.fetch ?? fetch
  const repo = { owner: nameMatch[1], name: nameMatch[2] }
  const listing = new Set(commit.sourceFiles)

  const files: RetrievedFile[] = []
  const skipped: SkippedFile[] = []
  const queue: Array<{ path: string; language: string }> = []
  const seen = new Set<string>()

  for (const raw of paths) {
    const label = typeof raw === "string" ? raw.slice(0, 120).replace(/[\u0000-\u001f\u007f]/g, "?") : String(typeof raw)
    if (!isSafeRepoPath(raw)) {
      skipped.push(skip(label, "unsafe_path", "Path was rejected as unsafe."))
      continue
    }
    if (seen.has(raw)) continue
    seen.add(raw)
    if (!listing.has(raw)) {
      skipped.push(skip(raw, "not_in_validated_listing", "This path isn't in the validated commit's source listing."))
      continue
    }
    const language = classifySourcePath(raw)
    if (!language) {
      skipped.push(skip(raw, "not_source_file", "Not a recognized source-code file."))
      continue
    }
    if (queue.length >= maxFiles) {
      skipped.push(skip(raw, "too_many_files", `Only ${maxFiles} files are read per retrieval.`))
      continue
    }
    queue.push({ path: raw, language })
  }

  let totalBytes = 0
  let rateLimited = false
  for (const item of queue) {
    if (rateLimited) {
      skipped.push(skip(item.path, "rate_limited", "Not attempted: GitHub's rate limit was reached."))
      continue
    }
    const out = await fetchOne(doFetch, repo, commit.commitSha, item.path, item.language, options, maxFileBytes, maxTotalBytes - totalBytes)
    if ("file" in out) {
      files.push(out.file)
      totalBytes += out.file.bytes
    } else {
      skipped.push(out.skipped)
      if (out.skipped.reason === "rate_limited") rateLimited = true
    }
  }

  const incompleteReasons: string[] = []
  if (skipped.length > 0) incompleteReasons.push(`${skipped.length} requested file(s) were not read.`)
  if (commit.truncated || commit.sourceFiles.length < commit.sourceFileCount) {
    incompleteReasons.push("The validator's source listing was incomplete, so unlisted files exist that were never considered.")
  }
  const retrieved = new Set(files.map((f) => f.path))
  const unrequested = commit.sourceFiles.filter((p) => !retrieved.has(p)).length
  if (unrequested > 0) incompleteReasons.push(`${unrequested} source file(s) in the listing were not retrieved.`)

  return {
    ok: true,
    data: {
      repository: commit.repository,
      commitSha: commit.commitSha,
      untrusted: true,
      files,
      skipped,
      requestedCount: paths.length,
      totalBytes,
      complete: incompleteReasons.length === 0,
      incompleteReasons,
      warnings: skipped.map((s) => `${s.path}: ${s.message}`),
    },
  }
}
