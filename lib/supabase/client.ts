"use client"

import { createBrowserClient } from "@supabase/ssr"
import type { Database } from "./database.types"
import { requirePublicSupabaseEnv } from "./env"

/**
 * Browser client: anon key + the signed-in user's session, so every query runs under RLS
 * (read-only on a user's own invoices). It cannot write financial or evaluation data.
 * Throws SupabaseConfigError if env is missing/invalid. Not imported by any page yet, so mock mode never touches Supabase.
 */
export function createSupabaseBrowserClient() {
  const { url, anonKey } = requirePublicSupabaseEnv()
  return createBrowserClient<Database>(url, anonKey)
}
