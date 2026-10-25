import { GITHUB_DECLARATION_FILE_NAME, serializeGithubDeclaration } from "@/lib/ai/github-declaration"
import type { GithubSubmissionResult } from "@/lib/ai/github-submission"
import type { Address, OnchainInvoiceStatus } from "@/lib/frontend/domain"
import { invoiceInScope, type DeploymentScope } from "@/lib/shared/deployment-scope"
import {
  contentMatchesType,
  DOWNLOAD_URL_TTL_SECONDS,
  EVIDENCE_MAX_BYTES,
  MAX_OBJECTS_PER_UPLOAD_FOLDER,
  MAX_SUBMISSIONS_PER_INVOICE,
  mimeToExt,
  parseEvidencePath,
  PolicyError,
  sanitizeFileName,
  SNIFF_BYTES,
  UPLOAD_URL_TTL_SECONDS,
  UUID_RE,
  validateFileMeta,
  buildEvidencePath,
} from "./policy"

/**
 * Evidence upload / retrieval rules. No framework, no Supabase imports: everything external arrives through the
 * ports below, so the same code runs in route handlers and in tests against the real schema.
 *
 * Trust model: the browser may only say WHO it wants to act on (an invoice id, a path we issued) and WHAT it
 * claims about a file. Identity comes from the validated session, wallet ownership from `user_wallets`
 * (verified only), roles from the invoice row, funding from the chain adapter, and file facts (size, MIME,
 * magic bytes) from the stored object itself.
 */

export type EvidenceErrorCode =
  | "UNAUTHENTICATED"
  | "NO_VERIFIED_WALLET"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "INVALID_FILE"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "CONTENT_MISMATCH"
  | "INVALID_PATH"
  | "UPLOAD_NOT_FOUND"
  | "NOT_FUNDED"
  | "INVOICE_CLOSED"
  | "CRITERIA_INCOMPLETE"
  | "CHAIN_UNAVAILABLE"
  | "SUBMISSION_LIMIT"
  | "TOO_MANY_UPLOADS"
  | "GITHUB_REJECTED"
  | "GITHUB_UNAVAILABLE"
  | "GITHUB_SUBMISSIONS_UNAVAILABLE"
  | "WRONG_DEPLOYMENT"

const STATUS: Record<EvidenceErrorCode, number> = {
  UNAUTHENTICATED: 401,
  NO_VERIFIED_WALLET: 403,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_INPUT: 400,
  INVALID_FILE: 400,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_TYPE: 415,
  CONTENT_MISMATCH: 415,
  INVALID_PATH: 400,
  UPLOAD_NOT_FOUND: 409,
  NOT_FUNDED: 409,
  INVOICE_CLOSED: 409,
  CRITERIA_INCOMPLETE: 409,
  CHAIN_UNAVAILABLE: 503,
  SUBMISSION_LIMIT: 409,
  TOO_MANY_UPLOADS: 429,
  GITHUB_REJECTED: 422,
  GITHUB_UNAVAILABLE: 503,
  GITHUB_SUBMISSIONS_UNAVAILABLE: 503,
  WRONG_DEPLOYMENT: 409,
}

export class EvidenceError extends Error {
  readonly status: number
  constructor(
    readonly code: EvidenceErrorCode,
    message: string
  ) {
    super(message)
    this.name = "EvidenceError"
    this.status = STATUS[code]
  }
}

// ---- Ports ------------------------------------------------------------------------------------------------

export interface InvoiceForEvidence {
  id: string
  client_address: Address
  freelancer_address: Address
  /** CACHE of chain state. Never sufficient to claim funding when a chain adapter is available. */
  onchain_status: OnchainInvoiceStatus
  criteria_count: number
  chain_id: number
  contract_address: Address
  /** uint256 as a decimal string. */
  invoice_id: string
}

export interface SubmissionRecord {
  id: string
  invoice_uuid: string
  freelancer_user_id: string
  storage_path: string
  file_name: string
  file_size: number
  mime_type: string
  funding_verified_onchain: boolean
  /** GitHub code submissions: canonical repository URL + full commit SHA (both or neither). null for file submissions. */
  repository_url: string | null
  commit_sha: string | null
  created_at: string
}

export interface NewSubmission {
  invoice_uuid: string
  freelancer_user_id: string
  freelancer_address: Address
  storage_path: string
  file_name: string
  file_size: number
  mime_type: string
  note: string
  funding_verified_onchain: boolean
  /** Present only for GitHub submissions. Absent (not null) for files so the insert never names columns it does not need. */
  repository_url?: string
  commit_sha?: string
}

export class DuplicatePathError extends Error {}

export interface EvidenceDb {
  /** Wallet addresses VERIFIED for this user (never unverified claims). */
  verifiedAddresses(userId: string): Promise<Address[]>
  getInvoice(invoiceId: string): Promise<InvoiceForEvidence | null>
  countCriteria(invoiceId: string): Promise<number>
  countSubmissions(invoiceId: string): Promise<number>
  findSubmissionByPath(path: string): Promise<SubmissionRecord | null>
  getSubmission(submissionId: string): Promise<SubmissionRecord | null>
  /** The invoice's newest submission, if any. */
  latestSubmission(invoiceId: string): Promise<SubmissionRecord | null>
  /** Throws DuplicatePathError when the path is already registered; throws EvidenceError CRITERIA_INCOMPLETE from the DB trigger. */
  insertSubmission(row: NewSubmission): Promise<SubmissionRecord>
}

export interface StoredObjectInfo {
  size: number
  mimeType: string
}

export interface EvidenceObjectStore {
  /** Signed URL + token that allow ONE create-only upload to exactly this path. */
  createSignedUpload(path: string): Promise<{ url: string; token: string }>
  /** Server-side, create-only write of a small object the SERVER generated (never user content). Fails if the path exists. */
  put(path: string, bytes: Uint8Array, mimeType: string): Promise<void>
  head(path: string): Promise<StoredObjectInfo | null>
  readPrefix(path: string, bytes: number): Promise<Uint8Array | null>
  createSignedDownload(path: string, ttlSeconds: number, downloadName: string): Promise<{ url: string; expiresAt: Date }>
  countInFolder(folder: string): Promise<number>
  remove(path: string): Promise<void>
}

export type ChainFundingCheck =
  | { status: "verified"; onchainStatus: OnchainInvoiceStatus }
  | { status: "unavailable" }

/** Reads authoritative invoice state from the contract. The integration owner supplies the real adapter. */
export interface ChainFundingVerifier {
  verify(invoice: InvoiceForEvidence): Promise<ChainFundingCheck>
}

export const noChainAdapter: ChainFundingVerifier = { verify: async () => ({ status: "unavailable" }) }

/** Confirms a public GitHub repository and commit exist (metadata only: never file contents) and returns their canonical form. */
export type GithubValidator = (repositoryUrl: string, commitSha: string) => Promise<GithubSubmissionResult>

export interface EvidenceDeps {
  /** The one deployment this process serves; invoices of another deployment are refused. Required. */
  scope: DeploymentScope
  db: EvidenceDb
  objects: EvidenceObjectStore
  /** Absent = GitHub submissions are not enabled in this deployment. */
  github?: GithubValidator
  chain: ChainFundingVerifier
  /** When true, evidence is refused unless the chain adapter confirmed funding. */
  requireChainVerification: boolean
  newId?: () => string
}

// ---- Authorization -------------------------------------------------------------------------------------------

interface PartyContext {
  invoice: InvoiceForEvidence
  isClient: boolean
  isFreelancer: boolean
}

function requireUser(userId: string | null | undefined): string {
  if (!userId) throw new EvidenceError("UNAUTHENTICATED", "Sign in to continue.")
  return userId
}

async function verifiedWallets(deps: EvidenceDeps, userId: string): Promise<Address[]> {
  const addresses = await deps.db.verifiedAddresses(userId)
  if (addresses.length === 0) {
    throw new EvidenceError("NO_VERIFIED_WALLET", "Verify your wallet before continuing.")
  }
  return addresses
}

/** Loads the invoice for a caller who must be one of its parties. Unrelated callers get NOT_FOUND, never a hint it exists. */
async function loadPartyContext(deps: EvidenceDeps, userId: string, invoiceId: string): Promise<PartyContext> {
  const wallets = await verifiedWallets(deps, userId)
  if (!UUID_RE.test(invoiceId)) throw new EvidenceError("NOT_FOUND", "Invoice not found.")
  const invoice = await deps.db.getInvoice(invoiceId)
  if (!invoice) throw new EvidenceError("NOT_FOUND", "Invoice not found.")
  const isClient = wallets.includes(invoice.client_address)
  const isFreelancer = wallets.includes(invoice.freelancer_address)
  if (!isClient && !isFreelancer) throw new EvidenceError("NOT_FOUND", "Invoice not found.")
  if (!invoiceInScope(invoice, deps.scope)) {
    throw new EvidenceError(
      "WRONG_DEPLOYMENT",
      `This invoice belongs to a different deployment than the one this server runs (${deps.scope.key.toUpperCase()}).`
    )
  }
  return { invoice, isClient, isFreelancer }
}

function requireFreelancer(ctx: PartyContext) {
  if (!ctx.isFreelancer) {
    throw new EvidenceError("FORBIDDEN", "Only the freelancer assigned to this invoice can submit evidence.")
  }
}

function statusToError(status: OnchainInvoiceStatus): EvidenceError | null {
  if (status === "Funded") return null
  if (status === "Created") return new EvidenceError("NOT_FUNDED", "The client hasn't funded escrow for this invoice yet.")
  return new EvidenceError("INVOICE_CLOSED", `Evidence can't be submitted while the invoice is ${status}.`)
}

/**
 * Evidence is accepted only for a funded invoice whose frozen criteria are complete. Funding comes from the chain
 * adapter when one is available. Without one, the cached status is used ONLY if the deployment has not required
 * chain verification, and the submission is recorded as `funding_verified_onchain = false`.
 */
async function checkEligibility(deps: EvidenceDeps, invoice: InvoiceForEvidence): Promise<{ fundingVerifiedOnchain: boolean }> {
  let check: ChainFundingCheck
  try {
    check = await deps.chain.verify(invoice)
  } catch {
    throw new EvidenceError("CHAIN_UNAVAILABLE", "The blockchain couldn't be reached to confirm funding. Try again shortly.")
  }
  let fundingVerifiedOnchain = false
  if (check.status === "verified") {
    const err = statusToError(check.onchainStatus)
    if (err) throw err
    fundingVerifiedOnchain = true
  } else {
    if (deps.requireChainVerification) {
      throw new EvidenceError("CHAIN_UNAVAILABLE", "Funding can't be verified on-chain right now, so evidence can't be accepted.")
    }
    const err = statusToError(invoice.onchain_status)
    if (err) throw err
  }
  const criteria = await deps.db.countCriteria(invoice.id)
  if (criteria !== invoice.criteria_count) {
    throw new EvidenceError("CRITERIA_INCOMPLETE", "This invoice's acceptance criteria aren't fully recorded yet.")
  }
  return { fundingVerifiedOnchain }
}

function fromPolicy(e: unknown): never {
  if (e instanceof PolicyError) throw new EvidenceError(e.code, e.message)
  throw e
}

// ---- Upload: step 1, authorize and mint a signed upload URL ----------------------------------------------------

export interface UploadGrant {
  /** Server-generated; the only path the browser may upload to and later register. */
  path: string
  uploadUrl: string
  uploadToken: string
  expiresInSeconds: number
  maxBytes: number
}

export async function initUpload(
  deps: EvidenceDeps,
  input: { userId: string | null; invoiceId: string; fileName: string; fileSize: number; mimeType: string }
): Promise<UploadGrant> {
  const userId = requireUser(input.userId)
  const file = (() => {
    try {
      return validateFileMeta(input)
    } catch (e) {
      return fromPolicy(e)
    }
  })()
  const ctx = await loadPartyContext(deps, userId, input.invoiceId)
  requireFreelancer(ctx)
  await checkEligibility(deps, ctx.invoice)

  if ((await deps.db.countSubmissions(ctx.invoice.id)) >= MAX_SUBMISSIONS_PER_INVOICE) {
    throw new EvidenceError("SUBMISSION_LIMIT", `An invoice can have at most ${MAX_SUBMISSIONS_PER_INVOICE} submissions.`)
  }
  const folder = `${ctx.invoice.id}/${userId}`
  if ((await deps.objects.countInFolder(folder)) >= MAX_OBJECTS_PER_UPLOAD_FOLDER) {
    throw new EvidenceError("TOO_MANY_UPLOADS", "Too many unfinished uploads for this invoice. Submit or wait before uploading more.")
  }

  const objectId = (deps.newId ?? (() => crypto.randomUUID()))()
  const path = buildEvidencePath({ invoiceId: ctx.invoice.id, userId, objectId, ext: file.ext })
  const signed = await deps.objects.createSignedUpload(path)
  return {
    path,
    uploadUrl: signed.url,
    uploadToken: signed.token,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    maxBytes: EVIDENCE_MAX_BYTES,
  }
}

// ---- Upload: step 2, verify the stored object and record the submission --------------------------------------

export interface RegisteredSubmission {
  submission: SubmissionRecord
  /** True when this path had already been registered; the existing submission is returned (idempotent retry). */
  duplicate: boolean
}

export async function registerSubmission(
  deps: EvidenceDeps,
  input: { userId: string | null; invoiceId: string; storagePath: string; fileName?: string; note?: string }
): Promise<RegisteredSubmission> {
  const userId = requireUser(input.userId)

  // The path comes from the browser, so treat it as hostile: it must be exactly a path we could have issued
  // for THIS invoice and THIS user. Anything else is rejected before any storage or database access.
  const parsed = parseEvidencePath(input.storagePath)
  if (!parsed || parsed.invoiceId !== input.invoiceId || parsed.userId !== userId) {
    throw new EvidenceError("INVALID_PATH", "That upload doesn't belong to this invoice and account.")
  }

  const ctx = await loadPartyContext(deps, userId, input.invoiceId)
  requireFreelancer(ctx)

  // Retrying a registration that already succeeded returns the same submission.
  const existing = await deps.db.findSubmissionByPath(input.storagePath)
  if (existing) return { submission: existing, duplicate: true }

  const { fundingVerifiedOnchain } = await checkEligibility(deps, ctx.invoice)
  if ((await deps.db.countSubmissions(ctx.invoice.id)) >= MAX_SUBMISSIONS_PER_INVOICE) {
    throw new EvidenceError("SUBMISSION_LIMIT", `An invoice can have at most ${MAX_SUBMISSIONS_PER_INVOICE} submissions.`)
  }

  const reject = async (code: EvidenceErrorCode, message: string): Promise<never> => {
    // Only objects inside this user's own folder for this invoice can reach here (path was parsed above).
    await deps.objects.remove(input.storagePath).catch(() => undefined)
    throw new EvidenceError(code, message)
  }

  const head = await deps.objects.head(input.storagePath)
  if (!head) throw new EvidenceError("UPLOAD_NOT_FOUND", "The file hasn't finished uploading. Upload it again.")
  if (head.size <= 0) return reject("INVALID_FILE", "The file is empty.")
  if (head.size > EVIDENCE_MAX_BYTES) return reject("FILE_TOO_LARGE", "Files must be 25 MB or smaller.")
  const mime = head.mimeType.trim().toLowerCase()
  if (mimeToExt(mime) !== parsed.ext) return reject("UNSUPPORTED_TYPE", "The stored file's type isn't allowed for this upload.")
  const prefix = await deps.objects.readPrefix(input.storagePath, SNIFF_BYTES)
  if (!prefix || !contentMatchesType(mime, prefix)) {
    return reject("CONTENT_MISMATCH", "The file's contents don't match its type. Upload a real PDF, PNG, JPG, ZIP, Markdown or text file.")
  }

  const row: NewSubmission = {
    invoice_uuid: ctx.invoice.id,
    freelancer_user_id: userId,
    freelancer_address: ctx.invoice.freelancer_address, // from the invoice, which equals the user's verified wallet
    storage_path: input.storagePath,
    file_name: sanitizeFileName(input.fileName ?? `evidence.${parsed.ext}`),
    file_size: head.size, // the stored object's real size, not the browser's claim
    mime_type: mime,
    note: (input.note ?? "").trim().slice(0, 2000),
    funding_verified_onchain: fundingVerifiedOnchain,
  }
  try {
    return { submission: await deps.db.insertSubmission(row), duplicate: false }
  } catch (e) {
    if (e instanceof DuplicatePathError) {
      const winner = await deps.db.findSubmissionByPath(input.storagePath)
      if (winner) return { submission: winner, duplicate: true }
    }
    throw e
  }
}

// ---- GitHub code submissions: validate, canonicalise, record -----------------------------------------------------

/** Errors the submitter can fix; everything else from GitHub is a retryable outage. */
const GITHUB_FIXABLE = new Set(["INVALID_URL", "INVALID_SHA", "REPO_NOT_FOUND", "REPO_NOT_PUBLIC", "COMMIT_NOT_FOUND"])

/**
 * Records a GitHub code submission: a repository URL and a full commit SHA. Same authorization and invoice rules as a file
 * submission, applied BEFORE any call to GitHub. Both values are validated and normalised by the GitHub validator (metadata
 * only: no source code is fetched, cloned or run), and only the canonical forms are stored, in the dedicated columns.
 *
 * The submissions table still requires an evidence file, so the server writes the canonical declaration object itself under a
 * path it generated; the submitter never uploads one. The stored columns are authoritative for evaluation.
 */
export async function registerGithubSubmission(
  deps: EvidenceDeps,
  input: { userId: string | null; invoiceId: string; repositoryUrl: string; commitSha: string; note?: string }
): Promise<RegisteredSubmission> {
  const userId = requireUser(input.userId)
  const ctx = await loadPartyContext(deps, userId, input.invoiceId)
  requireFreelancer(ctx)
  if (!deps.github) throw new EvidenceError("GITHUB_SUBMISSIONS_UNAVAILABLE", "GitHub submissions aren't enabled on this server.")

  const { fundingVerifiedOnchain } = await checkEligibility(deps, ctx.invoice)
  if ((await deps.db.countSubmissions(ctx.invoice.id)) >= MAX_SUBMISSIONS_PER_INVOICE) {
    throw new EvidenceError("SUBMISSION_LIMIT", `An invoice can have at most ${MAX_SUBMISSIONS_PER_INVOICE} submissions.`)
  }
  const folder = `${ctx.invoice.id}/${userId}`
  if ((await deps.objects.countInFolder(folder)) >= MAX_OBJECTS_PER_UPLOAD_FOLDER) {
    throw new EvidenceError("TOO_MANY_UPLOADS", "Too many unfinished uploads for this invoice. Submit or wait before uploading more.")
  }

  // Only now, with the caller authorized and the invoice eligible, is GitHub contacted.
  let validated: GithubSubmissionResult
  try {
    validated = await deps.github(input.repositoryUrl, input.commitSha)
  } catch {
    throw new EvidenceError("GITHUB_UNAVAILABLE", "GitHub couldn't be reached. Try again shortly.")
  }
  if (!validated.ok) {
    if (validated.error.code === "INVALID_URL" || validated.error.code === "INVALID_SHA") throw new EvidenceError("INVALID_INPUT", validated.error.message)
    if (GITHUB_FIXABLE.has(validated.error.code)) throw new EvidenceError("GITHUB_REJECTED", validated.error.message)
    throw new EvidenceError("GITHUB_UNAVAILABLE", validated.error.message)
  }
  const repositoryUrl = validated.data.repositoryUrl
  const commitSha = validated.data.commitSha

  // A retry of the same request returns the same submission instead of creating another "latest" one.
  const latest = await deps.db.latestSubmission(ctx.invoice.id)
  if (latest && latest.freelancer_user_id === userId && latest.repository_url === repositoryUrl && latest.commit_sha === commitSha) {
    return { submission: latest, duplicate: true }
  }

  const bytes = new TextEncoder().encode(serializeGithubDeclaration(repositoryUrl, commitSha))
  const objectId = (deps.newId ?? (() => crypto.randomUUID()))()
  const path = buildEvidencePath({ invoiceId: ctx.invoice.id, userId, objectId, ext: "txt" })
  await deps.objects.put(path, bytes, "text/plain")

  const row: NewSubmission = {
    invoice_uuid: ctx.invoice.id,
    freelancer_user_id: userId,
    freelancer_address: ctx.invoice.freelancer_address,
    storage_path: path,
    file_name: GITHUB_DECLARATION_FILE_NAME,
    file_size: bytes.length,
    mime_type: "text/plain",
    note: (input.note ?? "").trim().slice(0, 2000),
    funding_verified_onchain: fundingVerifiedOnchain,
    repository_url: repositoryUrl,
    commit_sha: commitSha,
  }
  try {
    return { submission: await deps.db.insertSubmission(row), duplicate: false }
  } catch (e) {
    // Nothing references the object yet: do not leave it behind.
    await deps.objects.remove(path).catch(() => undefined)
    throw e
  }
}

// ---- Retrieval ------------------------------------------------------------------------------------------------

export interface DownloadGrant {
  url: string
  expiresAt: string
  fileName: string
  mimeType: string
  fileSize: number
}

/**
 * Authorizes the caller as the client or freelancer of the submission's invoice, then mints a fresh 60-second signed
 * URL. URLs are never stored or cached; every call re-checks authorization.
 */
export async function getDownloadUrl(
  deps: EvidenceDeps,
  input: { userId: string | null; submissionId: string }
): Promise<DownloadGrant> {
  const userId = requireUser(input.userId)
  const wallets = await verifiedWallets(deps, userId)
  if (!UUID_RE.test(input.submissionId)) throw new EvidenceError("NOT_FOUND", "Submission not found.")
  const submission = await deps.db.getSubmission(input.submissionId)
  const invoice = submission ? await deps.db.getInvoice(submission.invoice_uuid) : null
  if (!submission || !invoice || !(wallets.includes(invoice.client_address) || wallets.includes(invoice.freelancer_address))) {
    throw new EvidenceError("NOT_FOUND", "Submission not found.")
  }
  return signDownload(deps, submission)
}

/**
 * For protected backend services (the future evaluator): a short-lived read URL with no user session. Never exposed
 * through an HTTP route; callers are server modules that already decided the read is legitimate.
 */
export async function createBackendReadUrl(deps: EvidenceDeps, submissionId: string): Promise<DownloadGrant> {
  const submission = UUID_RE.test(submissionId) ? await deps.db.getSubmission(submissionId) : null
  if (!submission) throw new EvidenceError("NOT_FOUND", "Submission not found.")
  return signDownload(deps, submission)
}

async function signDownload(deps: EvidenceDeps, submission: SubmissionRecord): Promise<DownloadGrant> {
  // Defence in depth: a stored path must still be one of our server-generated shapes for this invoice.
  const parsed = parseEvidencePath(submission.storage_path)
  if (!parsed || parsed.invoiceId !== submission.invoice_uuid) {
    throw new EvidenceError("INVALID_PATH", "This submission's stored file reference is invalid.")
  }
  const signed = await deps.objects.createSignedDownload(submission.storage_path, DOWNLOAD_URL_TTL_SECONDS, submission.file_name)
  return {
    url: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
    fileName: submission.file_name,
    mimeType: submission.mime_type,
    fileSize: submission.file_size,
  }
}

/** Translates the database's rejection of a submission insert into the right error. Shared by the adapters. */
export function mapSubmissionInsertError(code: string | undefined, message: string): Error | null {
  if (code === "23505" || /duplicate key value|already exists/i.test(message)) {
    if (/storage_path/.test(message)) return new DuplicatePathError(message)
  }
  if (/invoice criteria are incomplete/.test(message)) {
    return new EvidenceError("CRITERIA_INCOMPLETE", "This invoice's acceptance criteria aren't fully recorded yet.")
  }
  // Migration 9 (repository_url / commit_sha) is not applied to this database yet: GitHub submissions cannot be stored.
  if (/repository_url|commit_sha/.test(message) && (code === "42703" || code === "PGRST204" || /column|schema cache/i.test(message)) && !/violates check constraint/i.test(message)) {
    return new EvidenceError("GITHUB_SUBMISSIONS_UNAVAILABLE", "GitHub submissions need a database update that hasn't been applied yet.")
  }
  if (/submissions_(repository_url_format|commit_sha_format|github_fields_together)/.test(message)) {
    return new EvidenceError("INVALID_INPUT", "The repository URL or commit SHA isn't in the required form.")
  }
  return null
}
