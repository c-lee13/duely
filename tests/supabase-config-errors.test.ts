import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { toErrorResponse } from "@/lib/auth/http"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { SupabaseConfigError, getSupabaseEnvProblems } from "@/lib/supabase/env"

/**
 * "This feature is unavailable: Supabase is not fully configured on the server." comes from exactly one place: a
 * SupabaseConfigError. Those errors say which variable is wrong; the HTTP layer now passes that (names only, never
 * values) to the developer outside production instead of hiding it behind one generic sentence.
 */
const SAVED = { ...process.env }
const env = process.env as Record<string, string | undefined>
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete env[k]
  Object.assign(process.env, SAVED)
})

const URL_OK = "https://abcdefghijklmnopqrst.supabase.co"
const KEY_OK = "sb_publishable_" + "x".repeat(24)
const SERVICE = "eyJ-secret-value-that-must-never-appear-in-output"

describe("which variables the sign-in path requires", () => {
  it("exactly three: the public URL, the publishable (or legacy anon) key, and the server-only service-role key", () => {
    env.NEXT_PUBLIC_SUPABASE_URL = URL_OK
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = KEY_OK
    assert.deepEqual(getSupabaseEnvProblems(), [])
    delete env.NEXT_PUBLIC_SUPABASE_URL
    assert.match(getSupabaseEnvProblems().join(), /NEXT_PUBLIC_SUPABASE_URL is not set/)
    env.NEXT_PUBLIC_SUPABASE_URL = URL_OK
    delete env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    assert.match(getSupabaseEnvProblems().join(), /PUBLISHABLE_KEY.*not set/)
  })

  it("the service-role key: absent, empty and placeholder are all refused, each described differently, and the key is never echoed", () => {
    env.NEXT_PUBLIC_SUPABASE_URL = URL_OK
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = KEY_OK
    const messageFor = (value: string | undefined) => {
      if (value === undefined) delete env.SUPABASE_SERVICE_ROLE_KEY
      else env.SUPABASE_SERVICE_ROLE_KEY = value
      try {
        createSupabaseAdminClient()
      } catch (e) {
        assert.ok(e instanceof SupabaseConfigError)
        return e.problems.join(" ")
      }
      return "NO ERROR"
    }
    assert.match(messageFor(undefined), /SUPABASE_SERVICE_ROLE_KEY is not set/)
    assert.match(messageFor(""), /set but EMPTY/)
    assert.match(messageFor("your-service-key"), /placeholder/)
    assert.match(messageFor(""), /unset it in that terminal and restart/, "points at the shell-override cause")
    assert.equal(messageFor(SERVICE), "NO ERROR", "a real value builds the client")
  })
})

describe("the HTTP response", () => {
  async function respond(nodeEnv: string) {
    env.NODE_ENV = nodeEnv
    env.SUPABASE_SERVICE_ROLE_KEY = SERVICE
    const res = toErrorResponse(new SupabaseConfigError(["SUPABASE_SERVICE_ROLE_KEY is set but EMPTY (server environment only)."]))
    return { status: res.status, body: (await res.json()) as { error: { code: string; message: string } } }
  }

  it("is 503 SUPABASE_NOT_CONFIGURED with the original sentence in every environment", async () => {
    for (const mode of ["development", "test", "production"]) {
      const r = await respond(mode)
      assert.equal(r.status, 503)
      assert.equal(r.body.error.code, "SUPABASE_NOT_CONFIGURED")
      assert.match(r.body.error.message, /^This feature is unavailable: Supabase is not fully configured on the server\./)
    }
  })

  it("outside production it names the offending variable; in production it stays generic", async () => {
    assert.match((await respond("development")).body.error.message, /Details \(development only\): SUPABASE_SERVICE_ROLE_KEY is set but EMPTY/)
    assert.doesNotMatch((await respond("production")).body.error.message, /SUPABASE_SERVICE_ROLE_KEY|Details/)
  })

  it("never contains a secret value, in any environment", async () => {
    for (const mode of ["development", "production"]) assert.ok(!JSON.stringify(await respond(mode)).includes(SERVICE))
  })
})
