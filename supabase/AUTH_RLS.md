# Authentication, wallet identity and RLS (Phase 3A)

**Status: written and tested locally. Migrations 4–6 are NOT applied to any Supabase project, and the Supabase Auth
session step has not been exercised against a live project.** See "What was and was not tested".

## Session strategy

Real **Supabase Auth** sessions in HttpOnly cookies via `@supabase/ssr` (`lib/supabase/server.ts`, refreshed by `proxy.ts`).
RLS identifies the caller through the JWT (`auth.uid()`), so the database itself enforces access, not just our API code.

Supabase Auth has no wallet-first login that fits our own challenge table, so the server does this after a wallet
signature is verified:

1. If a user is **already signed in** (checked with `auth.getUser()`, which validates the token with Supabase), the wallet
   is **linked** to that user. Connecting a wallet never switches you into another account.
2. Else if the wallet is already **verified** for an account, sign in as that account.
3. Else **create** an account for the wallet, bind the wallet, and sign in.

Signing in = the server asks Supabase Auth (admin API) for a one-time magic-link token for that account and redeems it
immediately on the server (`verifyOtp`), which sets the cookies. The token never reaches the browser. Wallet accounts use
a **random** synthetic email (`w-<uuid>@wallet.duely.invalid`), never derived from the address: a derived email could be
pre-registered by an attacker through the public sign-up endpoint, who would then share the victim's account.

## Wallet ownership verification

`POST /api/auth/wallet/challenge {address}` → server stores a challenge (random 128-bit nonce, exact message text, 5-minute
expiry, max 5 open per address) and returns `{nonce, message}`. The message names the domain, the checksummed address,
nonce and expiry, and says no transaction is sent.

`POST /api/auth/wallet/verify {address, nonce, signature}` →
1. `consume_wallet_challenge` atomically burns the nonce **and** returns the **stored** message (so the browser cannot
   substitute its own text). Unknown, used, expired, or wrong-address nonces fail. It is burned even if the signature is
   then wrong, so a nonce is never tried twice.
2. EIP-191 `personal_sign` signature is verified with viem against that stored message and the claimed address.
3. Only then is the session established / wallet bound (`bind_verified_wallet`, atomic: one verified owner per address,
   idempotent for the same user, max 10 verified wallets per user, race-safe).

Also: `GET /api/auth/session` (who am I + verified wallets, read through RLS), `POST /api/auth/signout`.
Cookie-setting POSTs require a same-origin `Origin` header. Errors use `{ error: { code, message } }`.
Not supported: smart-contract wallets (ERC-1271). The addresses the server uses are always the verified ones.

## Authorization rules

Identity = a Supabase user with at least one **verified** wallet. Unverified claims, anonymous sessions and plain email
accounts have no wallet identity and see nothing.

| Data | client wallet of the invoice | freelancer wallet of the invoice | unrelated wallet / unverified / anon |
|---|---|---|---|
| invoice, criteria, submissions, evaluations, advance requests | read | read | nothing |
| transactions | read (their invoice's, plus own invoice-less) | read (their invoice's) | nothing (own invoice-less only) |
| own `user_wallets` rows | read own | read own | read own; never anyone else's |
| evidence objects | read | read, **upload** to `<invoice>/<own user id>/…` only | nothing |
| `wallet_challenges` | none | none | none |
| **any INSERT / UPDATE / DELETE on any table** | **none** | **none** | **none** |

All writes (invoice registration, submissions, evaluation results, advance requests, transactions, wallet binding) are
**server-only** via the service role after session, wallet, and chain-state checks. There are no write policies and no
write grants, so a leaked anon key cannot create or alter a record. Uploading evidence to storage does not create a
submission; only the server can.

## Migrations (new, in order, after 1–3)

| File | Contents |
|---|---|
| `20261024000004_wallet_auth_functions.sql` | `create_/consume_wallet_challenge`, `find_verified_wallet_owner`, `bind_verified_wallet` (service role only). Also revokes the default PUBLIC `EXECUTE` from every function in `public`. |
| `20261024000005_rls_policies.sql` | `private` helper schema (not exposed through the API), read-only grants, SELECT policies for the seven tables |
| `20261024000006_evidence_storage_policies.sql` | `storage.objects` policies: freelancer upload to own folder, parties read, no update/delete |
| `20261024000007_evidence_upload_hardening.sql` | (Phase 3B) drops the direct-upload policy, adds `submissions.funding_verified_onchain` and a MIME allow-list check. See `EVIDENCE.md`. |

## Configuration required (nothing here has been done for you)

1. **Server env:** add `SUPABASE_SERVICE_ROLE_KEY` to `.env.local` (server only, never `NEXT_PUBLIC_`). Optionally set
   `NEXT_PUBLIC_SITE_URL` to the deployed origin (used for the sign-in domain and Origin checks; defaults to the request origin).
2. **Dashboard → Authentication → Providers:** keep **Email** enabled (the server's one-time token uses it; no email is sent).
   Then turn **off "Allow new users to sign up"**: wallet accounts are created through the admin API, which is unaffected,
   and public email sign-up is not needed. Leave anonymous sign-ins off.
3. **Apply migrations 4–6** to your dev project (after you've reviewed them), same way as before:
   `npx supabase migration list`, `npx supabase db push --dry-run`, then `npx supabase db push` (or paste each file in the
   SQL Editor in order). If migration 6 fails with *"must be owner of table objects"*, create the two policies
   (`evidence_insert_freelancer`, `evidence_select_party`) in Dashboard → Storage → Policies using the same expressions.
4. Verify in the dashboard: 7 tables show one SELECT policy each (`wallet_challenges` none); Storage shows 2 evidence policies.

## Tests

`npm test` runs 48 tests on a local Postgres (PGlite, a WASM build of real Postgres) that imitates Supabase's roles and
default grants, then applies the **real** migration files in order:

- `tests/rls.test.ts` (32): anon denied everywhere; client/freelancer/unrelated/unverified/no-wallet read boundaries on every
  table; every write verb denied for every user on all 8 tables; unverified→verified transition; storage upload/read/overwrite rules;
  helper-function privileges; RLS enabled+forced with SELECT-only policies.
- `tests/wallet-auth.test.ts` (16): valid signature, replay, expiry, wrong key (nonce burned), tampered message, wrong address,
  malformed input, EIP-55 checksum, rate limit, browsers cannot call the SQL functions, binding rules (idempotent, one owner,
  concurrent race, unverified claim never blocks, cap of 10, ownership immutable even for the service role).

Mutation check: deliberately counting unverified wallets, or granting `INSERT` on invoices, makes these tests fail; the migration was restored afterwards.

### What was and was not tested

Tested: SQL, policies, grants, the challenge/signature logic and binding rules (above), plus a dev-server smoke test of the
four routes (origin checks, input validation, 503 when the service key is missing, signed-out session) and that all existing pages still load.

**Not tested:** anything that needs a live Supabase project: `establishWalletSession` (admin `createUser` / `generateLink` /
`verifyOtp` and cookie setting), the real PostgREST/Storage API, `.rpc()` calls, JWT handling, `proxy.ts` token refresh with a
real session, and the MetaMask helper in a browser. Migrations 4–6 have never run on real Supabase.

## Known limitations and risks

- The magic-link session mechanism depends on GoTrue behavior I could not verify here (e.g. whether the reserved `.invalid`
  email domain is accepted by `createUser`). Test it on the dev project first; the failure mode is a clean 500, not an auth bypass.
- Per-address challenge cap only; there is no per-IP rate limit yet.
- `proxy.ts` calls `getClaims()` only when an `sb-` session cookie exists (zero cost for the mock demo), and never redirects.
- No role distinction for "platform" yet; platform actions use the service role from server code.
- RLS gives parties read access to the whole invoice bundle, including the freelancer's evidence for the client. Narrower
  per-column rules (e.g. hiding evaluation details from the client) would need views or column grants.
- The wallet-first account has a synthetic email: users cannot recover it by email. Their wallet is the credential.
