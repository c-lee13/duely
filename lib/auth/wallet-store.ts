import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/supabase/database.types"
import { mapWalletDbError, type WalletBindingStore, type WalletChallengeStore } from "./wallet-verify"

/** Production store: service-role RPC calls. The admin client must never leave the server. */
export function createSupabaseWalletStore(admin: SupabaseClient<Database>): WalletChallengeStore & WalletBindingStore {
  const fail = (error: { message: string }): never => {
    throw mapWalletDbError(error.message) ?? new Error(error.message)
  }
  return {
    async create({ address, nonce, message, expiresAt }) {
      const { error } = await admin.rpc("create_wallet_challenge", {
        p_address: address,
        p_nonce: nonce,
        p_message: message,
        p_expires_at: expiresAt.toISOString(),
      })
      if (error) fail(error)
    },
    async consume({ nonce, address }) {
      const { data, error } = await admin.rpc("consume_wallet_challenge", { p_nonce: nonce, p_address: address })
      if (error) fail(error)
      return data ?? null
    },
    async findVerifiedOwner(address) {
      const { data, error } = await admin.rpc("find_verified_wallet_owner", { p_address: address })
      if (error) fail(error)
      return data ?? null
    },
    async bind({ userId, address, nonce }) {
      const { error } = await admin.rpc("bind_verified_wallet", {
        p_user: userId,
        p_address: address,
        p_nonce: nonce,
        p_method: "eip191",
      })
      if (error) fail(error)
    },
  }
}
