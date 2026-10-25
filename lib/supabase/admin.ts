import "server-only"
import { createClient } from "@supabase/supabase-js"
import type { Database } from "./database.types"
import { requirePublicSupabaseEnv, SupabaseConfigError } from "./env"

/**
 * Service-role client. BYPASSES RLS. Server-only: `import "server-only"` makes the build fail
 * if a client component ever imports this file, and the key has no NEXT_PUBLIC_ prefix.
 *
 * Rules for callers (route handlers / the protected signer module):
 *  - authenticate the session and verify the wallet binding BEFORE touching this client;
 *  - never pass caller-supplied addresses, scores, amounts or passed flags straight through;
 *  - never mark a transaction `confirmed` without a verified receipt/event.
 */
export function createSupabaseAdminClient() {
  const pub = requirePublicSupabaseEnv()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey || /your[-_]|<.*>|changeme/i.test(serviceKey)) {
    throw new SupabaseConfigError([
      `SUPABASE_SERVICE_ROLE_KEY is ${serviceKey === undefined ? "not set" : serviceKey.trim() === "" ? "set but EMPTY" : "still a placeholder"} (server environment only). ` +
        "If it is in .env.local but this error persists, the process that started the server has its own (empty or stale) value, which overrides the .env files: unset it in that terminal and restart `npm run dev`.",
    ])
  }
  return createClient<Database>(pub.url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
