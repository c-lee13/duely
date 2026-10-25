import type { PGlite } from "@electric-sql/pglite"
import type { Address } from "@/lib/frontend/domain"
import {
  ALLOWED_MIME_TYPES,
  DOWNLOAD_URL_TTL_SECONDS,
  EVIDENCE_MAX_BYTES,
  UPLOAD_URL_TTL_SECONDS,
} from "@/lib/evidence/policy"
import {
  mapSubmissionInsertError,
  type ChainFundingCheck,
  type ChainFundingVerifier,
  type EvidenceDb,
  type EvidenceObjectStore,
  type InvoiceForEvidence,
  type SubmissionRecord,
} from "@/lib/evidence/service"
import { as } from "./db"

const COLS =
  "id, invoice_uuid, freelancer_user_id, storage_path, file_name, file_size::int as file_size, mime_type, funding_verified_onchain, repository_url, commit_sha, created_at::text as created_at"

/** EvidenceDb over the REAL schema (all migrations applied), run as the service_role database role. */
export function createPgEvidenceDb(db: PGlite): EvidenceDb {
  const q = <T extends object>(sql: string, params: unknown[] = []) => as(db, "service_role", null, () => db.query<T>(sql, params))
  return {
    async verifiedAddresses(userId) {
      const r = await q<{ address: Address }>("select address from user_wallets where user_id = $1 and verified_at is not null", [userId])
      return r.rows.map((x) => x.address)
    },
    async getInvoice(id) {
      const r = await q<InvoiceForEvidence>(
        "select id, client_address, freelancer_address, onchain_status, criteria_count, chain_id::int as chain_id, contract_address, invoice_id::text as invoice_id from invoices where id = $1",
        [id]
      )
      return r.rows[0] ?? null
    },
    async countCriteria(id) {
      return (await q<{ c: number }>("select count(*)::int c from invoice_criteria where invoice_uuid = $1", [id])).rows[0].c
    },
    async countSubmissions(id) {
      return (await q<{ c: number }>("select count(*)::int c from submissions where invoice_uuid = $1", [id])).rows[0].c
    },
    async findSubmissionByPath(path) {
      return (await q<SubmissionRecord>(`select ${COLS} from submissions where storage_path = $1`, [path])).rows[0] ?? null
    },
    async getSubmission(id) {
      return (await q<SubmissionRecord>(`select ${COLS} from submissions where id = $1`, [id])).rows[0] ?? null
    },
    async latestSubmission(invoiceId) {
      return (await q<SubmissionRecord>(`select ${COLS} from submissions where invoice_uuid = $1 order by created_at desc, id desc limit 1`, [invoiceId])).rows[0] ?? null
    },
    async insertSubmission(row) {
      try {
        const r = await q<SubmissionRecord>(
          `insert into submissions (invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type, note, funding_verified_onchain, repository_url, commit_sha)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning ${COLS}`,
          [row.invoice_uuid, row.freelancer_user_id, row.freelancer_address, row.storage_path, row.file_name, row.file_size, row.mime_type, row.note, row.funding_verified_onchain, row.repository_url ?? null, row.commit_sha ?? null]
        )
        return r.rows[0]
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw mapSubmissionInsertError(undefined, msg) ?? e
      }
    },
  }
}

export class Clock {
  constructor(public ms = Date.parse("2026-11-01T12:00:00Z")) {}
  now = () => this.ms
  advance(seconds: number) {
    this.ms += seconds * 1000
  }
}

interface StoredObject {
  bytes: Uint8Array
  mime: string
  size: number
}

/**
 * Imitates the private evidence bucket and Supabase signed URLs: create-only uploads bound to ONE path, a bucket
 * size limit and MIME allow-list enforced at upload time, and signed URLs that stop working when they expire.
 * (The real expiry is enforced by Supabase; this fake only lets us prove our code asks for short lifetimes and
 * never relies on a URL outliving its authorization.)
 */
export class FakeObjectStore implements EvidenceObjectStore {
  objects = new Map<string, StoredObject>()
  private uploadTokens = new Map<string, { path: string; expires: number; used: boolean }>()
  private downloads = new Map<string, { path: string; expires: number }>()
  lastDownloadTtl: number | null = null
  constructor(private clock: Clock) {}

  async createSignedUpload(path: string) {
    const token = crypto.randomUUID()
    this.uploadTokens.set(token, { path, expires: this.clock.now() + UPLOAD_URL_TTL_SECONDS * 1000, used: false })
    return { url: `https://storage.test/upload/sign/evidence/${path}?token=${token}`, token }
  }

  /** What the browser's uploadToSignedUrl does against the bucket. */
  upload(token: string, bytes: Uint8Array, contentType: string, declaredSize = bytes.length) {
    const t = this.uploadTokens.get(token)
    if (!t) throw new Error("invalid upload token")
    if (this.clock.now() > t.expires) throw new Error("upload URL expired")
    if (t.used) throw new Error("upload token already used")
    if (this.objects.has(t.path)) throw new Error("object already exists (no upsert)")
    if (declaredSize > EVIDENCE_MAX_BYTES) throw new Error("bucket: object exceeds maximum allowed size")
    if (!ALLOWED_MIME_TYPES.includes(contentType)) throw new Error("bucket: mime type not supported")
    t.used = true
    this.objects.set(t.path, { bytes, mime: contentType, size: declaredSize })
  }

  /** Server-side create-only write (what the Supabase adapter does with the service role). Records the calls for assertions. */
  puts: Array<{ path: string; mime: string; size: number }> = []
  failPut = false
  async put(path: string, bytes: Uint8Array, mimeType: string) {
    if (this.failPut) throw new Error("storage unavailable")
    if (this.objects.has(path)) throw new Error("object already exists (no upsert)")
    this.puts.push({ path, mime: mimeType, size: bytes.length })
    this.objects.set(path, { bytes, mime: mimeType, size: bytes.length })
  }

  /** Test-only: places an object bypassing the bucket's limits (models a bug or a policy gap). */
  putRaw(path: string, bytes: Uint8Array, mime: string, size = bytes.length) {
    this.objects.set(path, { bytes, mime, size })
  }

  async head(path: string) {
    const o = this.objects.get(path)
    return o ? { size: o.size, mimeType: o.mime } : null
  }
  async readPrefix(path: string, n: number) {
    return this.objects.get(path)?.bytes.subarray(0, n) ?? null
  }
  async createSignedDownload(path: string, ttlSeconds: number, downloadName: string) {
    this.lastDownloadTtl = ttlSeconds
    const token = crypto.randomUUID()
    const expires = this.clock.now() + ttlSeconds * 1000
    this.downloads.set(token, { path, expires })
    return { url: `https://storage.test/object/sign/evidence/${path}?token=${token}&download=${encodeURIComponent(downloadName)}`, expiresAt: new Date(expires) }
  }
  /** What the browser does when it follows a download URL. */
  fetchDownload(url: string): Uint8Array {
    const token = new URL(url).searchParams.get("token") ?? ""
    const d = this.downloads.get(token)
    if (!d) throw new Error("invalid signature")
    if (this.clock.now() > d.expires) throw new Error("signed URL expired")
    const o = this.objects.get(d.path)
    if (!o) throw new Error("object not found")
    return o.bytes
  }
  async countInFolder(folder: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(folder + "/")).length
  }
  async remove(path: string) {
    this.objects.delete(path)
  }
}

export class FakeChain implements ChainFundingVerifier {
  result: ChainFundingCheck | "throw" = { status: "unavailable" }
  calls = 0
  async verify(): Promise<ChainFundingCheck> {
    this.calls++
    if (this.result === "throw") throw new Error("rpc down")
    return this.result
  }
}

export { DOWNLOAD_URL_TTL_SECONDS }

// Real file signatures, so uploads carry plausible content.
export const bytes = {
  pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3]),
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]),
  jpg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]),
  zip: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]),
  text: new TextEncoder().encode("# Deliverable\n\nHere is the proof of work.\n"),
  exe: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0, 0, 0]), // "MZ" Windows executable
}
