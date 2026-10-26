/**
 * DEV-ONLY TEST FIXTURE. Inserts ONE clearly-marked invoice into your Supabase project so the live-data screens, the
 * evidence upload and the evaluation flow can be exercised before the blockchain integration exists.
 *
 *   ALLOW_DEV_FIXTURES=true npm run seed:dev-fixture -- --wallet 0xYourVerifiedWallet [--as freelancer|client]
 *
 * It is NOT an on-chain invoice. It uses chain_id = 0, the zero contract/token addresses, no transaction hash and a
 * counterparty address nobody controls (0x...c0de). The app labels such rows "Test fixture · no blockchain", shows
 * their status as unverified, and shows no escrow or payment figures for them. Never run it against production.
 * Uses the service-role key from .env.local; the key never leaves this script.
 */
import { existsSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { computeCriteriaHash, canonicalCriteriaString } from "../lib/backend/criteria"
import { tokens } from "../lib/frontend/token"

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f)

function die(message: string): never {
  console.error(`seed-dev-fixture: ${message}`)
  process.exit(1)
}

if (process.env.ALLOW_DEV_FIXTURES !== "true") die("refusing to run. Set ALLOW_DEV_FIXTURES=true to confirm you want a TEST FIXTURE row (not a real invoice).")
if (process.env.NODE_ENV === "production") die("refusing to run with NODE_ENV=production.")

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const wallet = flag("wallet")?.toLowerCase()
const as = flag("as") ?? "freelancer"
if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) die("pass --wallet 0x… (a 42-character address already verified on your Duely account).")
if (as !== "freelancer" && as !== "client") die("--as must be 'freelancer' or 'client'.")

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) die("needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.")

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const COUNTERPARTY = "0x000000000000000000000000000000000000c0de"
const ZERO = "0x0000000000000000000000000000000000000000"

async function main() {
  const { data: owner, error: ownerError } = await admin.from("user_wallets").select("user_id").eq("address", wallet!).not("verified_at", "is", null).maybeSingle()
  if (ownerError) die(`could not read user_wallets: ${ownerError.message}`)
  if (!owner) die("that wallet isn't verified on any account yet. Sign in with it through the app first (Connect wallet), then run this again.")

  const criteria = [
    { id: "c1", text: "A final deliverable file is attached", mandatory: true },
    { id: "c2", text: "A short note explains what was done", mandatory: false },
  ]
  const { data, error } = await admin.rpc("register_invoice", {
    p_chain_id: 0,
    p_contract: ZERO,
    p_token: ZERO,
    p_invoice_id: String(Date.now()), // not an on-chain id
    p_client: as === "client" ? (wallet as `0x${string}`) : COUNTERPARTY,
    p_freelancer: as === "freelancer" ? (wallet as `0x${string}`) : COUNTERPARTY,
    p_amount: tokens(1),
    p_criteria_hash: computeCriteriaHash(criteria),
    p_canonical: canonicalCriteriaString(criteria),
    p_criteria: criteria,
    p_title: "TEST FIXTURE (not on-chain)",
    p_description: "Development fixture for exercising live-data screens. It does not exist on any blockchain.",
    p_due: null,
    p_create_tx: null,
    p_user: owner.user_id,
    p_status: "Funded", // lets evidence upload be tested; the app shows this status as unverified
    p_block: null,
  })
  if (error) die(`could not insert the fixture: ${error.message} (have migrations 1–8 been applied?)`)
  console.log(`Inserted test fixture ${data?.[0]?.o_id}. You are the ${as}. Open the app in live mode (NEXT_PUBLIC_DATA_MODE=api).`)
}
main().catch((e) => die(e instanceof Error ? e.message : String(e)))
