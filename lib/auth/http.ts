import { NextResponse } from "next/server"
import { WalletAuthError } from "./wallet-verify"
import { SupabaseConfigError } from "@/lib/supabase/env"
import { EvidenceError } from "@/lib/evidence/service"
import { ApiError } from "@/lib/backend/api-error"

/** Documented JSON error shape from CLAUDE.md §8. */
export function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } })
}

export function toErrorResponse(e: unknown) {
  if (e instanceof WalletAuthError) return errorResponse(e.status, e.code, e.message)
  if (e instanceof EvidenceError) return errorResponse(e.status, e.code, e.message)
  if (e instanceof ApiError) return errorResponse(e.status, e.code, e.message)
  if (e instanceof SupabaseConfigError) {
    return errorResponse(503, "SUPABASE_NOT_CONFIGURED", "This feature is unavailable: Supabase is not fully configured on the server.")
  }
  // Name and database error code only: messages can carry evidence content, values or connection details.
  console.error("api error:", e instanceof Error ? e.name : typeof e, (e as { code?: string } | null)?.code ?? "")
  return errorResponse(500, "INTERNAL", "Something went wrong. Please try again.")
}

/** The origin this deployment is served from. NEXT_PUBLIC_SITE_URL wins; otherwise the request's own origin. */
export function expectedOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      /* fall through */
    }
  }
  return new URL(request.url).origin
}

/**
 * CSRF defence for cookie-setting POSTs: browsers always send Origin on cross-site POSTs, so a missing or
 * foreign Origin is rejected. Returns an error response, or null when the request is acceptable.
 */
export function rejectCrossOrigin(request: Request) {
  const origin = request.headers.get("origin")
  if (!origin || origin !== expectedOrigin(request)) {
    return errorResponse(403, "BAD_ORIGIN", "Cross-origin requests are not allowed.")
  }
  return null
}

/** The domain shown to the user inside the signed message. */
export function expectedDomain(request: Request): string {
  return new URL(expectedOrigin(request)).host
}

export function configuredChainId(): number | undefined {
  const raw = process.env.NEXT_PUBLIC_XRPL_EVM_CHAIN_ID
  const n = raw ? Number(raw) : NaN
  return Number.isInteger(n) && n > 0 ? n : undefined
}
