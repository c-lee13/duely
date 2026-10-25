import { NextResponse } from "next/server"
import { z } from "zod"
import { errorResponse, rejectCrossOrigin, toErrorResponse } from "@/lib/auth/http"
import { createSupabaseWalletStore } from "@/lib/auth/wallet-store"
import { establishWalletSession } from "@/lib/auth/wallet-session"
import { verifyChallengeSignature } from "@/lib/auth/wallet-verify"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const Body = z.object({
  address: z.string().min(1).max(100),
  nonce: z.string().min(1).max(128),
  signature: z.string().min(1).max(200),
})

/**
 * POST /api/auth/wallet/verify  { address, nonce, signature }
 * Verifies the signature over the stored challenge, then links the wallet to the signed-in user or signs
 * in / creates the account that owns it. Only the verified address is ever used afterwards.
 */
export async function POST(request: Request) {
  const blocked = rejectCrossOrigin(request)
  if (blocked) return blocked
  const body = Body.safeParse(await request.json().catch(() => null))
  if (!body.success) return errorResponse(400, "INVALID_INPUT", "Send address, nonce and signature.")
  try {
    const store = createSupabaseWalletStore(createSupabaseAdminClient())
    const address = await verifyChallengeSignature(store, body.data)
    const session = await establishWalletSession({ address, nonce: body.data.nonce })
    return NextResponse.json(session, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return toErrorResponse(e)
  }
}
