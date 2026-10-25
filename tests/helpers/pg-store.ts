import type { PGlite } from "@electric-sql/pglite"
import type { Address } from "@/lib/frontend/domain"
import { as } from "./db"
import { mapWalletDbError, type WalletBindingStore, type WalletChallengeStore } from "@/lib/auth/wallet-verify"

/**
 * Test double for the production store: calls the SAME service-role SQL functions, under the service_role
 * database role, so FORCE RLS and privileges are exercised exactly as in production.
 */
export function createPgWalletStore(db: PGlite): WalletChallengeStore & WalletBindingStore {
  const call = async <T>(sql: string, params: unknown[]): Promise<T> => {
    try {
      const r = await as(db, "service_role", null, () => db.query<{ v: T }>(sql, params))
      return r.rows[0]?.v as T
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw mapWalletDbError(msg) ?? e
    }
  }
  return {
    async create({ address, nonce, message, expiresAt }) {
      await call("select public.create_wallet_challenge($1, $2, $3, $4) as v", [address, nonce, message, expiresAt.toISOString()])
    },
    async consume({ nonce, address }) {
      return (await call<string | null>("select public.consume_wallet_challenge($1, $2) as v", [nonce, address])) ?? null
    },
    async findVerifiedOwner(address: Address) {
      return (await call<string | null>("select public.find_verified_wallet_owner($1) as v", [address])) ?? null
    },
    async bind({ userId, address, nonce }) {
      await call("select public.bind_verified_wallet($1, $2, $3, 'eip191') as v", [userId, address, nonce])
    },
  }
}
