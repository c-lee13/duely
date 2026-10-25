#!/usr/bin/env node
/**
 * Development-only Supabase connectivity check:  npm run supabase:check
 *
 * - Reads .env.local (then .env) like Next.js does; never prints key values.
 * - Uses ONLY the public URL + publishable/anon key against Supabase Auth's public health endpoint.
 * - Does not read or write database tables, does not use the service-role key, and does not
 *   sign anyone in. It is not an HTTP route of the app, so nothing is exposed in production.
 */
import { existsSync } from "node:fs"

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f)

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const keyName = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ? "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" : "NEXT_PUBLIC_SUPABASE_ANON_KEY"
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const service = process.env.SUPABASE_SERVICE_ROLE_KEY
const PLACEHOLDER = /your-project|your_project|your-anon|your_anon|<.*>|changeme|example\.com/i

const fail = (msg) => {
  console.error(`FAIL  ${msg}`)
  process.exitCode = 1
}
const pass = (msg) => console.log(`ok    ${msg}`)

function role(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).role ?? null
  } catch {
    return null
  }
}

console.log("Duely Supabase connection check (no secrets are printed)\n")

if (!url || PLACEHOLDER.test(url)) fail("NEXT_PUBLIC_SUPABASE_URL is missing or still a placeholder.")
if (!anon || PLACEHOLDER.test(anon)) fail("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or legacy NEXT_PUBLIC_SUPABASE_ANON_KEY) is missing or still a placeholder.")
if (anon && (anon.startsWith("sb_secret_") || role(anon) === "service_role"))
  fail(`${keyName} is a SECRET/service-role key. Put the publishable/anon key here.`)
if (process.exitCode) {
  console.error("\nMock mode still works without Supabase. Fix .env.local (see supabase/README.md) and re-run.")
  process.exit(1)
}
pass(`NEXT_PUBLIC_SUPABASE_URL and ${keyName} are set`)
pass(service && !PLACEHOLDER.test(service) ? "SUPABASE_SERVICE_ROLE_KEY is set (server-only; not used by this check)" : "SUPABASE_SERVICE_ROLE_KEY not set (only needed for server writes later)")

let base
try {
  base = new URL(url)
} catch {
  fail("NEXT_PUBLIC_SUPABASE_URL is not a valid URL.")
  process.exit(1)
}
const local = ["localhost", "127.0.0.1"].includes(base.hostname)
if (base.protocol !== "https:" && !(local && base.protocol === "http:")) {
  fail("NEXT_PUBLIC_SUPABASE_URL must be https:// (http only for localhost).")
  process.exit(1)
}

try {
  const res = await fetch(new URL("/auth/v1/health", base), {
    headers: { apikey: anon },
    signal: AbortSignal.timeout(10_000),
  })
  if (res.ok) pass(`Auth service reachable and accepted the public key (HTTP ${res.status})`)
  else if (res.status === 401 || res.status === 403) fail(`Reached Supabase but the public key was rejected (HTTP ${res.status}). Check the key matches this project.`)
  else fail(`Unexpected response from Supabase Auth (HTTP ${res.status}).`)
} catch (e) {
  fail(`Could not reach ${base.origin}: ${e instanceof Error ? e.message : e}`)
}

console.log(process.exitCode ? "\nConnection NOT verified." : "\nConnection verified. (Database tables are not touched by this check.)")
