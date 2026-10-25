import "server-only"
import { cookies } from "next/headers"
import { createServerClient } from "@supabase/ssr"
import type { Database } from "./database.types"
import { requirePublicSupabaseEnv } from "./env"

/**
 * Server client acting AS THE SIGNED-IN USER (anon key + session cookies), so RLS applies.
 * Use it in route handlers and server components to read what the caller may see and to
 * identify them via `auth.getUser()` (which validates the token with Supabase). Writes to
 * protected tables go through `createSupabaseAdminClient` after explicit authorization checks.
 */
export async function createSupabaseServerClient() {
  const { url, anonKey } = requirePublicSupabaseEnv()
  const cookieStore = await cookies()
  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        } catch {
          // Called from a Server Component, where cookies are read-only. Safe to ignore once a
          // session-refresh proxy exists (added with the auth phase).
        }
      },
    },
  })
}
