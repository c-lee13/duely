import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import type { PGlite } from "@electric-sql/pglite"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createDb, as } from "./helpers/db"
import { createPgWalletStore } from "./helpers/pg-store"
import { normalizeAddress } from "@/lib/auth/wallet-message"
import { issueChallenge, verifyChallengeSignature, WalletAuthError, type WalletAuthErrorCode } from "@/lib/auth/wallet-verify"

let db: PGlite
let store: ReturnType<typeof createPgWalletStore>

const newWallet = () => privateKeyToAccount(generatePrivateKey())
const issue = (address: string) => issueChallenge(store, { address, domain: "duely.test" })

async function rejects(p: Promise<unknown>, code: WalletAuthErrorCode) {
  await assert.rejects(p, (e: unknown) => e instanceof WalletAuthError && e.code === code, `expected ${code}`)
}

async function newUser(): Promise<string> {
  const r = await db.query<{ id: string }>("insert into auth.users (email) values ($1) returning id", [`${crypto.randomUUID()}@t.invalid`])
  return r.rows[0].id
}

before(async () => {
  db = await createDb()
  store = createPgWalletStore(db)
})
after(async () => db.close())

describe("challenge + signature", () => {
  it("accepts a valid signature over the issued challenge and returns the lower-case address", async () => {
    const w = newWallet()
    const c = await issue(w.address)
    assert.match(c.message, /duely\.test wants you to verify/)
    assert.ok(c.message.includes(c.nonce) && c.message.includes(w.address), "message carries nonce and checksummed address")
    const signature = await w.signMessage({ message: c.message })
    const addr = await verifyChallengeSignature(store, { address: w.address, nonce: c.nonce, signature })
    assert.equal(addr, w.address.toLowerCase())
  })

  it("is single-use: replaying the same signature fails", async () => {
    const w = newWallet()
    const c = await issue(w.address)
    const signature = await w.signMessage({ message: c.message })
    await verifyChallengeSignature(store, { address: w.address, nonce: c.nonce, signature })
    await rejects(verifyChallengeSignature(store, { address: w.address, nonce: c.nonce, signature }), "CHALLENGE_INVALID")
  })

  it("rejects an expired challenge", async () => {
    const w = newWallet()
    const c = await issue(w.address)
    await db.query("update wallet_challenges set expires_at = now() - interval '1 second' where nonce = $1", [c.nonce])
    const signature = await w.signMessage({ message: c.message })
    await rejects(verifyChallengeSignature(store, { address: w.address, nonce: c.nonce, signature }), "CHALLENGE_INVALID")
  })

  it("rejects a signature from a different key, and burns the challenge so it cannot be retried", async () => {
    const victim = newWallet()
    const attacker = newWallet()
    const c = await issue(victim.address)
    const forged = await attacker.signMessage({ message: c.message })
    await rejects(verifyChallengeSignature(store, { address: victim.address, nonce: c.nonce, signature: forged }), "BAD_SIGNATURE")
    const genuine = await victim.signMessage({ message: c.message })
    await rejects(verifyChallengeSignature(store, { address: victim.address, nonce: c.nonce, signature: genuine }), "CHALLENGE_INVALID")
  })

  it("rejects a signature over any text other than the stored message (browser cannot substitute its own)", async () => {
    const w = newWallet()
    const c = await issue(w.address)
    const other = await w.signMessage({ message: c.message + "\nextra" })
    await rejects(verifyChallengeSignature(store, { address: w.address, nonce: c.nonce, signature: other }), "BAD_SIGNATURE")
  })

  it("does not let a challenge issued for one address be used for another", async () => {
    const a = newWallet()
    const b = newWallet()
    const c = await issue(a.address)
    const signature = await b.signMessage({ message: c.message })
    await rejects(verifyChallengeSignature(store, { address: b.address, nonce: c.nonce, signature }), "CHALLENGE_INVALID")
  })

  it("rejects unknown nonces, short nonces and malformed signatures", async () => {
    const w = newWallet()
    const sig = await w.signMessage({ message: "x" })
    await rejects(verifyChallengeSignature(store, { address: w.address, nonce: "a".repeat(32), signature: sig }), "CHALLENGE_INVALID")
    await rejects(verifyChallengeSignature(store, { address: w.address, nonce: "short", signature: sig }), "CHALLENGE_INVALID")
    await rejects(verifyChallengeSignature(store, { address: w.address, nonce: "a".repeat(32), signature: "0x1234" }), "INVALID_SIGNATURE_FORMAT")
    await rejects(verifyChallengeSignature(store, { address: w.address, nonce: "a".repeat(32), signature: 42 }), "INVALID_SIGNATURE_FORMAT")
  })

  it("rejects invalid addresses, including a bad EIP-55 checksum", async () => {
    await rejects(issue("not-an-address"), "INVALID_ADDRESS")
    await rejects(issue("0x123"), "INVALID_ADDRESS")
    const w = newWallet()
    const i = w.address.slice(2).search(/[a-fA-F]/) + 2 // flip the case of the first hex LETTER (digits have no case)
    const flipped = w.address[i] === w.address[i].toUpperCase() ? w.address[i].toLowerCase() : w.address[i].toUpperCase()
    const badChecksum = w.address.slice(0, i) + flipped + w.address.slice(i + 1)
    assert.equal(normalizeAddress(badChecksum), null, "flipped-case address fails checksum")
    assert.equal(normalizeAddress(w.address.toLowerCase()), w.address.toLowerCase(), "all-lowercase is accepted")
  })

  it("caps open challenges per address", async () => {
    const w = newWallet()
    for (let i = 0; i < 5; i++) await issue(w.address)
    await rejects(issue(w.address), "RATE_LIMITED")
    const other = newWallet()
    await issue(other.address) // other addresses are unaffected
  })

  it("browsers (anon / authenticated) cannot call the challenge or binding functions", async () => {
    const w = newWallet()
    const u = await newUser()
    const calls = [
      ["select public.create_wallet_challenge($1, $2, 'm', now() + interval '1 minute')", [w.address.toLowerCase(), "n".repeat(32)]],
      ["select public.consume_wallet_challenge($1, $2)", ["n".repeat(32), w.address.toLowerCase()]],
      ["select public.find_verified_wallet_owner($1)", [w.address.toLowerCase()]],
      ["select public.bind_verified_wallet($1, $2, 'n', 'eip191')", [u, w.address.toLowerCase()]],
    ] as const
    for (const [role, uid] of [["anon", null], ["authenticated", u]] as const) {
      for (const [sql, params] of calls) {
        const err = await as(db, role, uid, async () => {
          try {
            await db.query(sql, [...params])
            return null
          } catch (e) {
            return (e as Error).message
          }
        })
        assert.match(err ?? "NO ERROR", /permission denied/, `${role}: ${sql}`)
      }
    }
  })
})

describe("wallet binding", () => {
  it("binds a verified wallet to a user and is idempotent for that user", async () => {
    const u = await newUser()
    const w = newWallet()
    const addr = w.address.toLowerCase() as `0x${string}`
    assert.equal(await store.findVerifiedOwner(addr), null)
    await store.bind({ userId: u, address: addr, nonce: "n".repeat(32) })
    assert.equal(await store.findVerifiedOwner(addr), u)
    await store.bind({ userId: u, address: addr, nonce: "m".repeat(32) })
    const rows = await db.query("select count(*)::int c from user_wallets where address = $1", [addr])
    assert.equal((rows.rows[0] as { c: number }).c, 1)
  })

  it("refuses to bind a wallet that is already verified for another user", async () => {
    const [u1, u2] = [await newUser(), await newUser()]
    const addr = newWallet().address.toLowerCase() as `0x${string}`
    await store.bind({ userId: u1, address: addr, nonce: "n".repeat(32) })
    await rejects(store.bind({ userId: u2, address: addr, nonce: "n".repeat(32) }), "WALLET_TAKEN")
    assert.equal(await store.findVerifiedOwner(addr), u1)
  })

  it("exactly one of two concurrent bindings of the same wallet wins", async () => {
    const [u1, u2] = [await newUser(), await newUser()]
    const addr = newWallet().address.toLowerCase() as `0x${string}`
    const results = await Promise.allSettled([
      store.bind({ userId: u1, address: addr, nonce: "n".repeat(32) }),
      store.bind({ userId: u2, address: addr, nonce: "n".repeat(32) }),
    ])
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
    assert.ok([u1, u2].includes((await store.findVerifiedOwner(addr)) as string))
  })

  it("an unverified claim never blocks the real owner, and upgrades in place when verified", async () => {
    const [squatter, owner] = [await newUser(), await newUser()]
    const addr = newWallet().address.toLowerCase() as `0x${string}`
    await db.query("insert into user_wallets (user_id, address) values ($1, $2)", [squatter, addr])
    assert.equal(await store.findVerifiedOwner(addr), null, "an unverified claim confers nothing")
    await store.bind({ userId: owner, address: addr, nonce: "n".repeat(32) })
    assert.equal(await store.findVerifiedOwner(addr), owner)
    // the squatter's own claim is still unverified
    const r = await db.query("select verified_at from user_wallets where user_id = $1 and address = $2", [squatter, addr])
    assert.equal((r.rows[0] as { verified_at: unknown }).verified_at, null)
    // a user upgrades their own earlier claim
    const u = await newUser()
    const addr2 = newWallet().address.toLowerCase() as `0x${string}`
    await db.query("insert into user_wallets (user_id, address) values ($1, $2)", [u, addr2])
    await store.bind({ userId: u, address: addr2, nonce: "n".repeat(32) })
    assert.equal(await store.findVerifiedOwner(addr2), u)
  })

  it("caps verified wallets per user at 10", async () => {
    const u = await newUser()
    for (let i = 0; i < 10; i++) await store.bind({ userId: u, address: newWallet().address.toLowerCase() as `0x${string}`, nonce: "n".repeat(32) })
    await rejects(store.bind({ userId: u, address: newWallet().address.toLowerCase() as `0x${string}`, nonce: "n".repeat(32) }), "WALLET_LIMIT")
  })

  it("verified ownership cannot be reassigned or removed afterwards, even by the service role", async () => {
    const [u1, u2] = [await newUser(), await newUser()]
    const addr = newWallet().address.toLowerCase() as `0x${string}`
    await store.bind({ userId: u1, address: addr, nonce: "n".repeat(32) })
    for (const [sql, params] of [
      ["update user_wallets set user_id = $2 where address = $1", [addr, u2]],
      ["update user_wallets set verified_at = null, verification_method = null where address = $1", [addr]],
    ] as const) {
      const err = await as(db, "service_role", null, async () => {
        try {
          await db.query(sql, [...params])
          return null
        } catch (e) {
          return (e as Error).message
        }
      })
      assert.match(err ?? "NO ERROR", /immutable/, sql)
    }
  })
})
