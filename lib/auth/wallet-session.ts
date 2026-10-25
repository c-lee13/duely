import "server-only"
import type { Address } from "@/lib/frontend/domain"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseWalletStore } from "./wallet-store"
import { WalletAuthError } from "./wallet-verify"

export interface WalletSessionResult {
  userId: string
  wallets: Address[]
  /** True when this call created a new account for the wallet. */
  created: boolean
  /** True when the wallet was linked to an already signed-in account instead of signing in. */
  linked: boolean
}

/**
 * Establishes the authenticated Supabase session for a wallet whose ownership was ALREADY proven by
 * verifyChallengeSignature (a signed, single-use challenge). Never call this with an unverified address.
 *
 *  1. A user is already signed in (validated with Supabase, not just read from the cookie): the wallet is
 *     linked to that user. Connecting a wallet never switches the session to someone else's account.
 *  2. Otherwise, if the wallet is already verified for an account, sign in as that account.
 *  3. Otherwise create a fresh account for the wallet, bind the wallet, and sign in.
 *
 * Sessions are real Supabase Auth cookies (via @supabase/ssr). Supabase Auth has no wallet-first sign-in
 * that fits our challenge table, so the server mints a one-time magic-link token for the account and
 * redeems it immediately on the server; the token never reaches the browser.
 */
export async function establishWalletSession(args: { address: Address; nonce: string }): Promise<WalletSessionResult> {
  const admin = createSupabaseAdminClient()
  const store = createSupabaseWalletStore(admin)
  const userClient = await createSupabaseServerClient()

  const { data: current } = await userClient.auth.getUser()
  let userId: string
  let created = false
  let linked = false

  if (current.user) {
    userId = current.user.id
    await store.bind({ userId, address: args.address, nonce: args.nonce })
    linked = true
  } else {
    const owner = await store.findVerifiedOwner(args.address)
    let email: string
    if (owner) {
      const { data, error } = await admin.auth.admin.getUserById(owner)
      if (error || !data.user?.email) throw new Error("Could not load the account for this wallet.")
      userId = owner
      email = data.user.email
    } else {
      // The email is random and never derived from the address: a derived address could be pre-registered
      // through the public sign-up endpoint by an attacker, who would then share this account.
      email = `w-${crypto.randomUUID()}@wallet.duely.invalid`
      const { data, error } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        app_metadata: { provider: "wallet" },
      })
      if (error || !data.user) throw new Error("Could not create the account for this wallet.")
      userId = data.user.id
      try {
        await store.bind({ userId, address: args.address, nonce: args.nonce })
      } catch (e) {
        await admin.auth.admin.deleteUser(userId)
        throw e
      }
      created = true
    }

    const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email })
    const tokenHash = link?.properties?.hashed_token
    if (linkError || !tokenHash) throw new Error("Could not start a session for this wallet.")
    const { error: otpError } = await userClient.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash })
    if (otpError) throw new Error("Could not start a session for this wallet.")
  }

  // Read back through the user's own session: this goes through RLS, so it also proves the session works.
  const { data: rows, error } = await userClient
    .from("user_wallets")
    .select("address")
    .not("verified_at", "is", null)
  if (error) throw new WalletAuthError("CHALLENGE_INVALID", "Signed in, but the wallet list could not be read.")
  return { userId, wallets: (rows ?? []).map((r) => r.address), created, linked }
}
