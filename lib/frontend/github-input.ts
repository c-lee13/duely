/**
 * Form-side checks for a GitHub repository submission. These only give the freelancer quick, specific feedback before a
 * request is sent. They mirror the rules in lib/ai/github-submission.ts, which the SERVER applies for real (it also
 * confirms with GitHub that the repository is public and the commit exists), so nothing here is trusted by the backend.
 *
 * Pure and browser-safe: no server imports, no network.
 */

export type FieldCheck = { ok: true; value: string } | { ok: false; message: string }

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const SHA_RE = /^[0-9a-f]{40}$/i

/** Returns the canonical `https://github.com/owner/repo` (no .git, no trailing slash, no www) or a specific problem. */
export function checkRepositoryUrl(raw: string): FieldCheck {
  const input = raw.trim()
  if (input === "") return { ok: false, message: "Enter the repository URL." }
  if (input.length > 300) return { ok: false, message: "That URL is too long." }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, message: "That doesn't look like a URL. Use https://github.com/owner/repo." }
  }
  if (url.protocol !== "https:") return { ok: false, message: "The URL must start with https://." }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return { ok: false, message: "Only github.com repositories are supported." }
  if (url.username || url.password || url.port) return { ok: false, message: "Remove any username, password or port from the URL." }
  if (url.search || url.hash) return { ok: false, message: "Remove everything after the repository name (no ? or # parts)." }
  const parts = url.pathname.replace(/^\//, "").replace(/\/$/, "").split("/")
  if (parts.length < 2 || parts[0] === "" || parts[1] === "") return { ok: false, message: "Include the owner and repository: https://github.com/owner/repo." }
  if (parts.length > 2) return { ok: false, message: "Use the repository's main URL, not a branch, file or folder page." }
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/i, "")
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return { ok: false, message: "That owner or repository name isn't valid." }
  return { ok: true, value: `https://github.com/${owner}/${repo}` }
}

/** Returns the lower-case 40-character SHA or a specific problem. */
export function checkCommitSha(raw: string): FieldCheck {
  const input = raw.trim()
  if (input === "") return { ok: false, message: "Enter the full commit SHA." }
  if (SHA_RE.test(input)) return { ok: true, value: input.toLowerCase() }
  if (/^[0-9a-f]{7,39}$/i.test(input)) return { ok: false, message: `That's a short SHA (${input.length} characters). Use the full 40-character one: run git rev-parse HEAD.` }
  if (/^[0-9a-f]+$/i.test(input) && input.length > 40) return { ok: false, message: "That's longer than a 40-character SHA." }
  if (input.length === 40) return { ok: false, message: "A SHA only contains the digits 0-9 and the letters a-f." }
  return { ok: false, message: "Use a commit SHA, not a branch or tag name. Run git rev-parse HEAD for the full 40 characters." }
}

export const shortSha = (sha: string) => sha.slice(0, 7)

/**
 * Links to show for a stored GitHub submission. Built only from values that match the strict canonical shapes, so a
 * malformed or unexpected value can never become a link; returns null instead.
 */
export function githubLinks(repositoryUrl: string | null | undefined, commitSha: string | null | undefined): { repo: string; commit: string; label: string } | null {
  if (!repositoryUrl || !commitSha) return null
  const repo = checkRepositoryUrl(repositoryUrl)
  const sha = checkCommitSha(commitSha)
  if (!repo.ok || !sha.ok || repo.value !== repositoryUrl) return null
  return { repo: repo.value, commit: `${repo.value}/commit/${sha.value}`, label: repo.value.replace("https://github.com/", "") }
}

const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/

/** A repository-relative path that cannot climb out of the repo or smuggle control characters, separators or odd segments. */
export function isSafeSourcePath(path: string): boolean {
  if (path === "" || path.length > 400 || /[\u0000-\u001f\u007f\\]/.test(path) || path.startsWith("/") || path.endsWith("/")) return false
  return path.split("/").length <= 30 && path.split("/").every((s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git" && s.trim() === s)
}

/**
 * Builds github.com links for the repository and exact commit that were reviewed, and (when its path and lines are sane) a
 * link to a cited line range at that commit. Every part is validated here; anything unexpected yields null, so the UI shows
 * plain text instead of a link. The link always names the commit SHA, never a branch.
 */
export function githubCommitLinks(repository: string, commitSha: string): { repo: string; commit: string } | null {
  if (!REPOSITORY_RE.test(repository) || !/^[0-9a-f]{40}$/.test(commitSha)) return null
  const repo = `https://github.com/${repository}`
  return { repo, commit: `${repo}/commit/${commitSha}` }
}

export function githubBlobLink(repository: string, commitSha: string, path: string, startLine: number, endLine: number): string | null {
  const base = githubCommitLinks(repository, commitSha)
  if (!base || !isSafeSourcePath(path)) return null
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > 10_000_000) return null
  const anchor = endLine === startLine ? `#L${startLine}` : `#L${startLine}-L${endLine}`
  return `${base.repo}/blob/${commitSha}/${path.split("/").map(encodeURIComponent).join("/")}${anchor}`
}
