import { NextResponse } from "next/server"
import { toErrorResponse } from "@/lib/auth/http"
import { createSupabaseServerClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

/** GET /api/auth/session -> who is signed in and which wallets are VERIFIED for them (read through RLS). */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient()
    const { data } = await supabase.auth.getUser() // validated with Supabase, not just decoded from the cookie
    if (!data.user) return NextResponse.json({ authenticated: false, wallets: [] }, { headers: { "Cache-Control": "no-store" } })
    const { data: rows } = await supabase.from("user_wallets").select("address").not("verified_at", "is", null)
    return NextResponse.json(
      { authenticated: true, userId: data.user.id, wallets: (rows ?? []).map((r) => r.address) },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (e) {
    return toErrorResponse(e)
  }
}
