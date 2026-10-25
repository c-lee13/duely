import { z } from "zod"

/**
 * How a submission EXPLICITLY declares a GitHub repository and commit.
 *
 * Submissions have no repository/commit fields yet (that would need a database change), so a GitHub submission is an
 * uploaded text file with a reserved name whose ENTIRE content is one strict JSON document:
 *
 *   file name : duely-github-submission.txt   (type text/plain)
 *   content   : {"kind":"duely.github-submission.v1","repository_url":"https://github.com/owner/repo","commit_sha":"<40 hex>"}
 *
 * Detection never looks inside other evidence. A README, report or note that merely mentions a repository or a SHA is
 * ordinary text evidence. A file with the reserved name that is not exactly this document is an INVALID declaration (reported
 * to the submitter), never silently evaluated as text. This is the single place that decides; replace it when the
 * submissions table gets real repository and commit columns.
 *
 * Pure (no I/O). The URL and SHA are only shape-checked here; lib/ai/github-submission.ts validates them for real.
 */

export const GITHUB_DECLARATION_FILE_NAME = "duely-github-submission.txt"
export const GITHUB_DECLARATION_KIND = "duely.github-submission.v1"
/** A declaration is a few hundred bytes. Anything larger is not one. */
export const GITHUB_DECLARATION_MAX_BYTES = 4096

const declarationSchema = z
  .object({
    kind: z.literal(GITHUB_DECLARATION_KIND),
    repository_url: z.string().min(1).max(300),
    commit_sha: z.string().min(1).max(100),
  })
  .strict()

/**
 * The canonical declaration file content for a GitHub submission. The submissions API writes this object itself so the
 * submitter never uploads it; it is byte-for-byte what a user would have uploaded under the legacy convention.
 */
export function serializeGithubDeclaration(repositoryUrl: string, commitSha: string): string {
  return JSON.stringify({ kind: GITHUB_DECLARATION_KIND, repository_url: repositoryUrl, commit_sha: commitSha })
}

export type GithubDeclaration =
  | { kind: "none" }
  | { kind: "github"; repositoryUrl: string; commitSha: string }
  | { kind: "invalid"; message: string }

export function parseGithubDeclaration(submission: { fileName: string; mimeType: string; fileSize: number }, evidence: Uint8Array): GithubDeclaration {
  if (submission.fileName !== GITHUB_DECLARATION_FILE_NAME) return { kind: "none" }

  const invalid = (why: string): GithubDeclaration => ({
    kind: "invalid",
    message: `The GitHub submission file isn't valid: ${why} It must contain only {"kind":"${GITHUB_DECLARATION_KIND}","repository_url":"https://github.com/owner/repo","commit_sha":"<full 40-character SHA>"}.`,
  })
  if (submission.mimeType.toLowerCase() !== "text/plain") return invalid("it must be a plain-text file.")
  if (submission.fileSize > GITHUB_DECLARATION_MAX_BYTES || evidence.length > GITHUB_DECLARATION_MAX_BYTES) return invalid("it is too large.")

  let json: unknown
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evidence))
  } catch {
    return invalid("it isn't a single JSON document.")
  }
  const parsed = declarationSchema.safeParse(json)
  if (!parsed.success) return invalid("it has missing, wrong or extra fields.")
  return { kind: "github", repositoryUrl: parsed.data.repository_url, commitSha: parsed.data.commit_sha }
}
