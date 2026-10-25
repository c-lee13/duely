# Duely — Supabase database foundation

Off-chain metadata only. **Nothing here proves funds moved**: the contract, its receipts and events
are authoritative. `invoices.onchain_status` / `advance_amount` are a cache written by trusted server
code after verifying chain data. Mock mode (`NEXT_PUBLIC_DATA_MODE=mock`, the default) needs none of this.

**Using the app with this database: see [`LIVE_MODE.md`](./LIVE_MODE.md).** The app runs in mock mode (browser `localStorage`, no Supabase) unless `NEXT_PUBLIC_DATA_MODE=api`.

## Schema and migrations

See [`SCHEMA.md`](./SCHEMA.md) for tables, relationships, guarantees and migration order.

| File | Contents |
|---|---|
| `migrations/20261024000001_core_schema.sql` | Tables, constraints, immutability triggers |
| `migrations/20261024000002_rls_deny_by_default.sql` | RLS enabled + forced, no policies (deny-by-default) |
| `migrations/20261024000003_evidence_storage.sql` | Private `evidence` bucket, no object policies |
| `migrations/20261024000004_wallet_auth_functions.sql` | Wallet challenge/binding functions (service role only) |
| `migrations/20261024000005_rls_policies.sql` | Read-only SELECT policies for invoice parties |
| `migrations/20261024000006_evidence_storage_policies.sql` | Evidence upload/read policies |
| `migrations/20261024000008_backend_api_support.sql` | Phase 4: atomic `register_invoice()` (service role only), one live evaluation per submission. See [`API.md`](./API.md). |
| `migrations/20261024000007_evidence_upload_hardening.sql` | Removes direct browser uploads (server-minted signed URLs only), funding-verification flag, MIME check. See [`EVIDENCE.md`](./EVIDENCE.md). |
| `migrations/20261024000009_github_submissions.sql` | Additive: nullable `submissions.repository_url` + `commit_sha` (canonical URL, full lower-case 40-hex SHA, both or neither, immutable). No RLS or grant changes. |

Migrations 1–3 were applied to the dev project. **4–9 are not applied yet.** See [`AUTH_RLS.md`](./AUTH_RLS.md) for the auth
design, authorization rules, configuration and tests (`npm test`). Browsers get read-only access; every write is server-only.
Do not add client write policies.
Amounts are exact `numeric` integers: always read them as text (`amount::text`) to avoid JSON precision loss.

## Connect a project and apply migrations

1. Create a project at <https://supabase.com/dashboard>. Copy **Project URL**, **anon key** and **service_role key**
   (Project Settings → API).
2. `cp .env.example .env.local` and fill in:
   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...   # legacy name NEXT_PUBLIC_SUPABASE_ANON_KEY also accepted
   SUPABASE_SERVICE_ROLE_KEY=...      # server only, never NEXT_PUBLIC_
   ```
   Leave `NEXT_PUBLIC_DATA_MODE=mock` until the API adapter is wired and tested.
3. Apply the migrations, either:
   - **CLI:** `npx supabase init` (creates `supabase/config.toml`, keeps existing migrations), then
     `npx supabase login`, `npx supabase link --project-ref <ref>`, `npx supabase db push`; or
   - **Dashboard:** SQL Editor → run the three files in order.
4. Verify in the dashboard: all 8 tables show RLS enabled with **no policies**; Storage has a **private** `evidence` bucket.
   **Apply to a throwaway/dev project first.** Never reset a shared project; these migrations only add objects, but check before pushing to anything shared.
5. Optional: `npx supabase gen types typescript --linked > lib/supabase/database.types.ts` to replace the hand-written types.

## Code

- `lib/supabase/client.ts` — anon client with the user's session (RLS applies).
- `lib/supabase/server.ts` — server client acting as the signed-in user (cookies, RLS applies). `server-only`.
- `lib/supabase/admin.ts` — service-role client, bypasses RLS. `server-only`; use only after authorization checks.
- `lib/supabase/env.ts` — env access and `isSupabaseConfigured()`.
- `lib/supabase/database.types.ts` — row types for the schema.

## Verify the connection

```
npm run supabase:check
```
Reads `.env.local`, validates the variables, and calls Supabase Auth's public health endpoint with the anon key.
It never prints keys, never uses the service-role key, and never touches tables. Without configuration it fails
with a clear message while mock mode keeps working (`npm run dev` needs no Supabase).

## How wallets get bound (not implemented yet)

`user_wallets` rows are claims until server code verifies a signed challenge and sets `verified_at`
(`wallet_challenges` holds single-use nonces). The auth/API phase implements sign-in; until then no user has a
verified wallet, so RLS correctly returns nothing.

## Not done / follow-ups

- No session-refresh proxy and no sign-in flow (auth phase).
- No API routes, AI evaluation, chain verification or wallet transactions.
- Platform/admin read access is intentionally absent (use the service role from server code).
- Submissions are insert-only, so deleting a user's evidence for privacy requests needs a deliberate admin procedure.
- `invoice_criteria` rows are frozen by trigger, but the criteria-hash recomputation check belongs in the API
  (integration owner's canonical encoding is not frozen yet).
- Migrations were tested against a local in-memory Postgres with stand-ins for `auth`/`storage`, not a live Supabase project.
