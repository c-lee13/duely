import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { getPublicSupabaseEnv } from "@/lib/supabase/env"

/**
 * Keeps a signed-in user's Supabase session fresh (Supabase SSR guidance): Server Components cannot write
 * cookies, so token refresh happens here. It is a no-op, with no network call, for visitors without a
 * Supabase session cookie, and for everyone when Supabase is not configured, so the mock demo is unaffected.
 * It only refreshes the session; it does not authorize or redirect anything.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })
  const env = getPublicSupabaseEnv()
  const hasSession = request.cookies.getAll().some((c) => c.name.startsWith("sb-"))
  if (!env || !hasSession) return response

  try {
    const supabase = createServerClient(env.url, env.anonKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    })
    await supabase.auth.getClaims() // validates the token and refreshes it when expired
  } catch {
    // Never break page loads because of a session refresh problem.
  }
  return response
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
}
