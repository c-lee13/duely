import { NextResponse } from "next/server"
import { z } from "zod"
import { configuredChainId, errorResponse, expectedDomain, rejectCrossOrigin, toErrorResponse } from "@/lib/auth/http"
import { createSupabaseWalletStore } from "@/lib/auth/wallet-store"
import { issueChallenge } from "@/lib/auth/wallet-verify"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const Body = z.object({ address: z.string().min(1).max(100) })

/** POST /api/auth/wallet/challenge  { address } -> { nonce, message, expiresAt } */
export async function POST(request: Request) {
  const blocked = rejectCrossOrigin(request)
  if (blocked) return blocked
  const body = Body.safeParse(await request.json().catch(() => null))
  if (!body.success) return errorResponse(400, "INVALID_INPUT", "Send a JSON body with an address.")
  try {
    const store = createSupabaseWalletStore(createSupabaseAdminClient())
    const c = await issueChallenge(store, {
      address: body.data.address,
      domain: expectedDomain(request),
      chainId: configuredChainId(),
    })
    return NextResponse.json(
      { nonce: c.nonce, message: c.message, expiresAt: c.expiresAt.toISOString() },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (e) {
    return toErrorResponse(e)
  }
}
