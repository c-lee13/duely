/**
 * Supabase environment access and validation.
 *
 * Only the two NEXT_PUBLIC_* values are safe for the browser. The service-role key is read
 * exclusively in `admin.ts` (server-only). Missing or malformed values never crash mock mode:
 * callers use `isSupabaseConfigured()` to decide, and only real Supabase access throws.
 */
export const EVIDENCE_BUCKET = "evidence"

export class SupabaseConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `Supabase is not configured correctly:\n- ${problems.join("\n- ")}\nSee supabase/README.md. ` +
        "Mock mode (NEXT_PUBLIC_DATA_MODE=mock) works without Supabase."
    )
    this.name = "SupabaseConfigError"
  }
}

/** Supabase's newer name is PUBLISHABLE_KEY; the legacy ANON_KEY name is still accepted. Static refs so Next inlines them. */
function publicKey(): { name: string; value: string | undefined } {
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  return publishable
    ? { name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", value: publishable }
    : { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", value: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY }
}

const PLACEHOLDER = /your-project|your_project|your-anon|your_anon|<.*>|changeme|example\.com/i

/** Best-effort read of a JWT's `role` claim, to catch a service-role key pasted into a public variable. */
function jwtRole(token: string): string | null {
  const part = token.split(".")[1]
  if (!part) return null
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"))
    const role = (JSON.parse(json) as { role?: unknown }).role
    return typeof role === "string" ? role : null
  } catch {
    return null
  }
}

function validateUrl(url: string | undefined, problems: string[]) {
  if (!url) return problems.push("NEXT_PUBLIC_SUPABASE_URL is not set.")
  if (PLACEHOLDER.test(url)) return problems.push("NEXT_PUBLIC_SUPABASE_URL still has its placeholder value.")
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return problems.push("NEXT_PUBLIC_SUPABASE_URL is not a valid URL (expected https://<project-ref>.supabase.co).")
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    problems.push("NEXT_PUBLIC_SUPABASE_URL must use https:// (http:// is only allowed for localhost).")
  }
}

function validateAnonKey(name: string, key: string | undefined, problems: string[]) {
  if (!key) return problems.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or legacy NEXT_PUBLIC_SUPABASE_ANON_KEY) is not set.")
  if (PLACEHOLDER.test(key)) return problems.push(`${name} still has its placeholder value.`)
  if (/\s/.test(key)) return problems.push(`${name} contains whitespace.`)
  if (key.startsWith("sb_secret_") || jwtRole(key) === "service_role") {
    problems.push(
      `${name} holds a SECRET/service-role key. Use the publishable/anon key here and keep the secret key in SUPABASE_SERVICE_ROLE_KEY (server only).`
    )
  }
}

/** Lists what is wrong with the public Supabase env (empty array = fine). */
export function getSupabaseEnvProblems(): string[] {
  const problems: string[] = []
  // Static references so Next.js can inline NEXT_PUBLIC_* into the browser bundle.
  validateUrl(process.env.NEXT_PUBLIC_SUPABASE_URL, problems)
  const key = publicKey()
  validateAnonKey(key.name, key.value, problems)
  return problems
}

/** True when a valid Supabase project is configured. Mock mode never needs it. */
export function isSupabaseConfigured(): boolean {
  return getSupabaseEnvProblems().length === 0
}

export function getPublicSupabaseEnv(): { url: string; anonKey: string } | null {
  return isSupabaseConfigured()
    ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL as string, anonKey: publicKey().value as string }
    : null
}

/** Returns the validated public env or throws a SupabaseConfigError that names every problem. */
export function requirePublicSupabaseEnv(): { url: string; anonKey: string } {
  const problems = getSupabaseEnvProblems()
  if (problems.length > 0) throw new SupabaseConfigError(problems)
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    anonKey: publicKey().value as string,
  }
}
