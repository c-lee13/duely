import { NextResponse } from "next/server"
import { rejectCrossOrigin, toErrorResponse } from "@/lib/auth/http"
import { createSupabaseServerClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

/** POST /api/auth/signout -> ends the session and clears its cookies. */
export async function POST(request: Request) {
  const blocked = rejectCrossOrigin(request)
  if (blocked) return blocked
  try {
    const supabase = await createSupabaseServerClient()
    await supabase.auth.signOut()
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return toErrorResponse(e)
  }
}
