import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Address } from "@/lib/frontend/domain"
import { validateGithubSubmission } from "@/lib/ai/github-submission"
import { activeDeploymentScope } from "@/lib/backend/scope"
import { createChainAdapter, createChainFundingVerifier } from "@/lib/backend/chain-adapter"
import type { DeploymentScope } from "@/lib/shared/deployment-scope"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { EVIDENCE_BUCKET } from "@/lib/supabase/env"
import type { Database } from "@/lib/supabase/database.types"
import {
  EvidenceError,
  mapSubmissionInsertError,
  type ChainFundingVerifier,
  type EvidenceDb,
  type EvidenceDeps,
  type EvidenceObjectStore,
  type InvoiceForEvidence,
  type SubmissionRecord,
} from "./service"

type Admin = SupabaseClient<Database>

/**
 * Reads use "*" and pick fields below, NOT a column list: repository_url / commit_sha only exist once migration 9 is applied,
 * and naming them would break every submission read on a database that does not have them yet. A missing column reads as null.
 */
const SUBMISSION_COLUMNS = "*"

function toRecord(row: Record<string, unknown>): SubmissionRecord {
  return {
    id: row.id as string,
    invoice_uuid: row.invoice_uuid as string,
    freelancer_user_id: row.freelancer_user_id as string,
    storage_path: row.storage_path as string,
    file_name: row.file_name as string,
    file_size: Number(row.file_size),
    mime_type: row.mime_type as string,
    funding_verified_onchain: row.funding_verified_onchain as boolean,
    repository_url: (row.repository_url as string | null | undefined) ?? null,
    commit_sha: (row.commit_sha as string | null | undefined) ?? null,
    created_at: row.created_at as string,
  }
}

/** Service-role database access. Only ever called after the service layer has authorized the caller. */
export function createSupabaseEvidenceDb(admin: Admin): EvidenceDb {
  const fail = (error: { message: string }): never => {
    throw new Error(error.message)
  }
  const count = async (table: "invoice_criteria" | "submissions", invoiceId: string) => {
    const { count: n, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq("invoice_uuid", invoiceId)
    if (error) fail(error)
    return n ?? 0
  }
  return {
    async verifiedAddresses(userId) {
      const { data, error } = await admin.from("user_wallets").select("address").eq("user_id", userId).not("verified_at", "is", null)
      if (error) fail(error)
      return (data ?? []).map((r) => r.address as Address)
    },
    async getInvoice(invoiceId) {
      // invoice_id is a uint256: read it as text, never as a JSON number.
      const { data, error } = await admin
        .from("invoices")
        .select("id, client_address, freelancer_address, onchain_status, criteria_count, chain_id, contract_address, invoice_id::text")
        .eq("id", invoiceId)
        .maybeSingle()
      if (error) fail(error)
      return (data as unknown as InvoiceForEvidence | null) ?? null
    },
    countCriteria: (id) => count("invoice_criteria", id),
    countSubmissions: (id) => count("submissions", id),
    async findSubmissionByPath(path) {
      const { data, error } = await admin.from("submissions").select(SUBMISSION_COLUMNS).eq("storage_path", path).maybeSingle()
      if (error) fail(error)
      return data ? toRecord(data as Record<string, unknown>) : null
    },
    async getSubmission(id) {
      const { data, error } = await admin.from("submissions").select(SUBMISSION_COLUMNS).eq("id", id).maybeSingle()
      if (error) fail(error)
      return data ? toRecord(data as Record<string, unknown>) : null
    },
    async latestSubmission(invoiceId) {
      const { data, error } = await admin
        .from("submissions")
        .select(SUBMISSION_COLUMNS)
        .eq("invoice_uuid", invoiceId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) fail(error)
      return data ? toRecord(data as Record<string, unknown>) : null
    },
    async insertSubmission(row) {
      // `row` only names repository_url / commit_sha for GitHub submissions, so file submissions never touch the new columns.
      const { data, error } = await admin.from("submissions").insert(row).select(SUBMISSION_COLUMNS).single()
      if (error) throw mapSubmissionInsertError(error.code, error.message) ?? new Error(error.message)
      return toRecord(data as Record<string, unknown>)
    },
  }
}

/** Private-bucket access with the service role. The bucket stays private; nothing here creates public URLs. */
export function createSupabaseObjectStore(admin: Admin): EvidenceObjectStore {
  const bucket = () => admin.storage.from(EVIDENCE_BUCKET)
  const split = (path: string) => {
    const i = path.lastIndexOf("/")
    return { folder: path.slice(0, i), name: path.slice(i + 1) }
  }
  return {
    async createSignedUpload(path) {
      // create-only (no upsert): an existing object can never be overwritten through this URL.
      const { data, error } = await bucket().createSignedUploadUrl(path)
      if (error || !data) throw new Error(error?.message ?? "Could not create an upload URL.")
      return { url: data.signedUrl, token: data.token }
    },
    async put(path, bytes, mimeType) {
      // create-only (no upsert) and bound to a path the server generated: it can never replace an existing object.
      const { error } = await bucket().upload(path, bytes, { contentType: mimeType, upsert: false })
      if (error) throw new Error(error.message)
    },
    async head(path) {
      const { folder, name } = split(path)
      const { data, error } = await bucket().list(folder, { limit: 5, search: name })
      if (error) throw new Error(error.message)
      const hit = data?.find((o) => o.name === name)
      const meta = hit?.metadata as { size?: number; mimetype?: string } | null | undefined
      if (!hit || !meta || typeof meta.size !== "number") return null
      return { size: meta.size, mimeType: String(meta.mimetype ?? "") }
    },
    async readPrefix(path, bytes) {
      const { data, error } = await bucket().createSignedUrl(path, 30)
      if (error || !data) return null
      const res = await fetch(data.signedUrl, { headers: { Range: `bytes=0-${bytes - 1}` } })
      if (!res.ok || !res.body) return null
      // Read at most `bytes` even if the server ignored the Range header.
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      while (total < bytes) {
        const { done, value } = await reader.read()
        if (done || !value) break
        chunks.push(value)
        total += value.length
      }
      await reader.cancel().catch(() => undefined)
      const out = new Uint8Array(Math.min(total, bytes))
      let offset = 0
      for (const c of chunks) {
        const part = c.subarray(0, out.length - offset)
        out.set(part, offset)
        offset += part.length
        if (offset >= out.length) break
      }
      return out
    },
    async createSignedDownload(path, ttlSeconds, downloadName) {
      const { data, error } = await bucket().createSignedUrl(path, ttlSeconds, { download: downloadName })
      if (error || !data) throw new Error(error?.message ?? "Could not create a download URL.")
      return { url: data.signedUrl, expiresAt: new Date(Date.now() + ttlSeconds * 1000) }
    },
    async countInFolder(folder) {
      const { data, error } = await bucket().list(folder, { limit: 100 })
      if (error) throw new Error(error.message)
      return data?.length ?? 0
    },
    async remove(path) {
      await bucket().remove([path])
    },
  }
}

/**
 * Chain adapter slot. No contract, ABI or chain config is frozen yet (integration owner), so this reports
 * "unavailable" and the service falls back to the cached status unless EVIDENCE_REQUIRE_CHAIN_VERIFICATION=true.
 * Replace with a viem-backed reader of the contract's invoice status when the adapter exists.
 */
export function getChainVerifier(scope: DeploymentScope = activeDeploymentScope()): ChainFundingVerifier {
  return createChainFundingVerifier(createChainAdapter({ scope }))
}

export function getEvidenceDeps(): EvidenceDeps {
  const admin = createSupabaseAdminClient()
  const scope = activeDeploymentScope()
  return {
    db: createSupabaseEvidenceDb(admin),
    objects: createSupabaseObjectStore(admin),
    scope,
    chain: getChainVerifier(scope),
    // With a real chain reader, funding must be PROVEN on-chain: the cached database status is no longer an acceptable
    // fallback. Only an explicit EVIDENCE_REQUIRE_CHAIN_VERIFICATION=false (dev fixtures that were never on-chain) turns it off.
    requireChainVerification: process.env.EVIDENCE_REQUIRE_CHAIN_VERIFICATION !== "false",
    github: githubValidator(),
  }
}

/** Metadata-only GitHub validation. The optional token (server-only env) goes in a request header and nowhere else. */
function githubValidator(): NonNullable<EvidenceDeps["github"]> {
  const token = process.env.GITHUB_TOKEN?.trim()
  return (url, sha) => validateGithubSubmission(url, sha, token ? { token } : {})
}

/** The signed-in user's id, validated with Supabase (not merely decoded from the cookie). Null when signed out. */
export async function getSessionUserId(): Promise<string | null> {
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase.auth.getUser()
  return data.user?.id ?? null
}

export { EvidenceError }
