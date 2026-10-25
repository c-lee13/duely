"use client"

import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import { EVIDENCE_BUCKET } from "@/lib/supabase/env"
import { ALLOWED_TYPES } from "./policy"

/**
 * Browser side of the evidence upload. The browser never chooses a storage path or says who it is: the server
 * returns the path and a signed, create-only upload token after checking the session, verified wallet and invoice,
 * and re-verifies the stored object before recording the submission.
 */

export class EvidenceUploadError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "EvidenceUploadError"
  }
}

export interface UploadedSubmission {
  submissionId: string
  invoiceId: string
  fileName: string
  fileSize: number
  mimeType: string
  createdAt: string
  fundingVerifiedOnchain: boolean
  duplicate: boolean
  /** The server-issued path (needed only to build the app's Submission record). */
  storagePath: string
}

const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  zip: "application/zip",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
}

/** Browsers often report "" for .md files; fall back to the extension, but only to an allowed type. */
export function resolveMimeType(file: Pick<File, "name" | "type">): string {
  const declared = file.type.trim().toLowerCase()
  if (declared && ALLOWED_TYPES.some((t) => t.mime === declared)) return declared
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : ""
  return declared || EXT_TO_MIME[ext] || ""
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null
  if (!res.ok) throw new EvidenceUploadError(json?.error?.code ?? "REQUEST_FAILED", json?.error?.message ?? "The request failed.")
  return json as T
}

export type UploadPhase = "authorizing" | "uploading" | "verifying"

export async function uploadEvidence(args: {
  invoiceId: string
  file: File
  note?: string
  onPhase?: (phase: UploadPhase) => void
}): Promise<UploadedSubmission> {
  const mimeType = resolveMimeType(args.file)

  args.onPhase?.("authorizing")
  const grant = await postJson<{ path: string; uploadToken: string }>("/api/evidence/upload-url", {
    invoiceId: args.invoiceId,
    fileName: args.file.name,
    fileSize: args.file.size,
    mimeType,
  })

  args.onPhase?.("uploading")
  const { error } = await createSupabaseBrowserClient()
    .storage.from(EVIDENCE_BUCKET)
    .uploadToSignedUrl(grant.path, grant.uploadToken, args.file, { contentType: mimeType })
  if (error) throw new EvidenceUploadError("UPLOAD_FAILED", "The file couldn't be uploaded. Check your connection and try again.")

  args.onPhase?.("verifying")
  const res = await postJson<Omit<UploadedSubmission, "storagePath">>("/api/submissions", {
    invoiceId: args.invoiceId,
    storagePath: grant.path,
    fileName: args.file.name,
    note: args.note,
  })
  return { ...res, storagePath: grant.path }
}
