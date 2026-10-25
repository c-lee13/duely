/**
 * Evidence upload policy: the single source of truth for what may be uploaded and where it lives.
 * Pure functions, no I/O, no server-only imports, so it is shared by the API, the browser helper and tests.
 *
 * Keep in sync with migration 20261024000003 (bucket limit + allowed MIME types) and 20261024000007
 * (submissions.mime_type check). tests/evidence.test.ts fails if they drift.
 */

/** 25 MB. Also the bucket's file_size_limit and the submissions.file_size check. */
export const EVIDENCE_MAX_BYTES = 25 * 1024 * 1024

/** Supabase issues short-lived signed DOWNLOAD urls; we ask for 60 seconds. */
export const DOWNLOAD_URL_TTL_SECONDS = 60
/** Signed UPLOAD urls are valid for 2 hours: fixed by Supabase and not configurable. Only the object path is trusted afterwards. */
export const UPLOAD_URL_TTL_SECONDS = 2 * 60 * 60

/** Abuse limits. */
export const MAX_SUBMISSIONS_PER_INVOICE = 10
export const MAX_OBJECTS_PER_UPLOAD_FOLDER = 20

export interface AllowedType {
  mime: string
  /** The only extension used in storage paths for this MIME type. Never taken from the user's file name. */
  ext: "pdf" | "png" | "jpg" | "zip" | "md" | "txt"
}

export const ALLOWED_TYPES: readonly AllowedType[] = [
  { mime: "application/pdf", ext: "pdf" },
  { mime: "image/png", ext: "png" },
  { mime: "image/jpeg", ext: "jpg" },
  { mime: "application/zip", ext: "zip" },
  { mime: "application/x-zip-compressed", ext: "zip" },
  { mime: "text/markdown", ext: "md" },
  { mime: "text/plain", ext: "txt" },
]
export const ALLOWED_MIME_TYPES: readonly string[] = ALLOWED_TYPES.map((t) => t.mime)

/** File-name extensions a user's own file name may carry for each storage extension. */
const NAME_EXTENSIONS: Record<AllowedType["ext"], readonly string[]> = {
  pdf: ["pdf"],
  png: ["png"],
  jpg: ["jpg", "jpeg"],
  zip: ["zip"],
  md: ["md", "markdown"],
  txt: ["txt"],
}

export type PolicyErrorCode = "INVALID_FILE" | "FILE_TOO_LARGE" | "UNSUPPORTED_TYPE"
export class PolicyError extends Error {
  constructor(
    readonly code: PolicyErrorCode,
    message: string
  ) {
    super(message)
    this.name = "PolicyError"
  }
}

export const mimeToExt = (mime: string): AllowedType["ext"] | null =>
  ALLOWED_TYPES.find((t) => t.mime === mime.trim().toLowerCase())?.ext ?? null

/**
 * Display-only file name: strips directories (both separators), control characters and leading dots, and caps
 * the length. The result is never used in a storage path or any file-system operation.
 */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ""
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/^\.+/, "").trim()
  const capped = cleaned.slice(0, 200)
  return capped.length > 0 ? capped : "evidence"
}

export interface ValidatedFile {
  ext: AllowedType["ext"]
  mime: string
  size: number
  safeName: string
}

/**
 * Validates what the browser CLAIMS about a file before any upload is authorized. The claims are re-checked
 * against the stored object (real size, real MIME, magic bytes) before a submission is recorded.
 */
export function validateFileMeta(input: { fileName: string; fileSize: number; mimeType: string }): ValidatedFile {
  const mime = (input.mimeType ?? "").trim().toLowerCase()
  const ext = mimeToExt(mime)
  if (!ext) throw new PolicyError("UNSUPPORTED_TYPE", "Upload a PDF, PNG, JPG, ZIP, Markdown or text file.")
  if (!Number.isInteger(input.fileSize) || input.fileSize <= 0) throw new PolicyError("INVALID_FILE", "The file is empty.")
  if (input.fileSize > EVIDENCE_MAX_BYTES) throw new PolicyError("FILE_TOO_LARGE", "Files must be 25 MB or smaller.")
  const safeName = sanitizeFileName(input.fileName)
  const nameExt = safeName.includes(".") ? safeName.split(".").pop()!.toLowerCase() : ""
  if (nameExt && !NAME_EXTENSIONS[ext].includes(nameExt)) {
    throw new PolicyError("UNSUPPORTED_TYPE", "The file name's extension does not match its type.")
  }
  return { ext, mime, size: input.fileSize, safeName }
}

// ---- Storage paths ------------------------------------------------------------------------------------------

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const PATH_RE = new RegExp(`^(${UUID})/(${UUID})/(${UUID})\\.(pdf|png|jpg|zip|md|txt)$`)
export const UUID_RE = new RegExp(`^${UUID}$`)

/** `<invoice uuid>/<user uuid>/<random uuid>.<ext>`. Every segment is server-chosen. */
export function buildEvidencePath(args: { invoiceId: string; userId: string; objectId: string; ext: AllowedType["ext"] }): string {
  for (const [k, v] of [["invoiceId", args.invoiceId], ["userId", args.userId], ["objectId", args.objectId]] as const) {
    if (!UUID_RE.test(v)) throw new Error(`buildEvidencePath: ${k} must be a lower-case UUID`)
  }
  return `${args.invoiceId}/${args.userId}/${args.objectId}.${args.ext}`
}

export interface ParsedEvidencePath {
  invoiceId: string
  userId: string
  objectId: string
  ext: AllowedType["ext"]
}

/**
 * Strict parser for a path the BROWSER sent back. Anything that is not exactly three lower-case UUID segments
 * plus an allow-listed extension (traversal, encoded slashes, extra segments, absolute paths, upper case, null
 * bytes, whitespace) returns null.
 */
export function parseEvidencePath(path: unknown): ParsedEvidencePath | null {
  if (typeof path !== "string" || path.length > 200) return null
  const m = PATH_RE.exec(path)
  if (!m) return null
  return { invoiceId: m[1], userId: m[2], objectId: m[3], ext: m[4] as ParsedEvidencePath["ext"] }
}

// ---- Content sniffing -----------------------------------------------------------------------------------------

/** Bytes read from the start of a stored object to confirm it really is what its MIME type claims. */
export const SNIFF_BYTES = 512

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v)

/**
 * True when the first bytes are consistent with the claimed type. Binary formats must carry their magic number;
 * text formats must be valid UTF-8 with no NUL bytes. Not a malware scan: it only stops a renamed/spoofed file
 * (for example an executable labelled application/pdf) from being accepted as evidence.
 */
export function contentMatchesType(mime: string, bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  switch (mimeToExt(mime)) {
    case "pdf":
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-
    case "png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case "jpg":
      return startsWith(bytes, [0xff, 0xd8, 0xff])
    case "zip":
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) // PK local header / empty archive
    case "md":
    case "txt": {
      if (bytes.includes(0)) return false
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        return true
      } catch {
        // a multi-byte character may be cut at the end of the sniffed window
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - 3))
          return true
        } catch {
          return false
        }
      }
    }
    default:
      return false
  }
}
