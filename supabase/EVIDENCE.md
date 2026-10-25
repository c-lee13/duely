# Secure evidence uploads (Phase 3B)

**Status: implemented and tested locally. Migration 7 is not applied to any project, and the flow has not been run against a
live Supabase project** (needs the service-role key and migrations 4–7). See "What was and was not tested".

## Flow

```
Browser                         Server (route handlers)                          Private bucket `evidence`
   │  POST /api/evidence/upload-url {invoiceId, fileName, fileSize, mimeType}
   ├────────────────────────────────▶ 1. session valid?  (auth.getUser, validated with Supabase)
   │                                  2. user has a VERIFIED wallet?
   │                                  3. that wallet == invoice.freelancer_address?
   │                                  4. file type / size allowed?
   │                                  5. invoice eligible? (funded + criteria complete, see below)
   │                                  6. limits not exceeded
   │                                  7. path = <invoice uuid>/<user uuid>/<random uuid>.<ext>   (server-generated)
   │ ◀──── {path, uploadToken} ───────  8. signed, create-only upload token for exactly that path
   │  uploadToSignedUrl(path, token, file) ─────────────────────────────────────────────▶ bucket enforces 25 MB + MIME allow-list
   │  POST /api/submissions {invoiceId, storagePath, fileName?, note?}
   ├────────────────────────────────▶ 9.  storagePath must be EXACTLY a path we could have issued for this invoice AND this user
   │                                  10. object exists; size + MIME read from the stored object (not the request)
   │                                  11. first 512 bytes match the type (magic numbers); otherwise delete + reject
   │                                  12. eligibility re-checked; insert `submissions` (DB triggers/FKs re-check consistency)
   │ ◀──── {submissionId, ...} ───────
   │  GET /api/submissions/:id/download
   ├────────────────────────────────▶ client or freelancer of the invoice (verified wallet)? → 60-second signed URL; else 404
```

Mock/demo mode is unchanged: the mock adapter ignores the `file` field; the real flow runs only through `ApiDuelyRepository.submitEvidence`
(`NEXT_PUBLIC_DATA_MODE=api`). Outside the demo the form hides the simulated-evaluator switch and says evaluation is not available yet.

## Security checks

| Threat | Control |
|---|---|
| Not signed in | every endpoint requires a validated Supabase session (401) |
| Wallet connected but not proven | only `user_wallets.verified_at` rows count; unverified claims are ignored (403) |
| Someone else's invoice | role comes from the invoice row vs the user's verified wallets; non-parties get 404 (existence not revealed); the invoice's client gets 403 on upload |
| Browser picks the path | the path is generated server-side from random UUIDs; the file name never appears in it; on registration the path must match a strict regex AND its invoice and user segments must equal the request's invoice and the session user |
| Path traversal / arbitrary file | strict `^uuid/uuid/uuid.ext$` parser (no `..`, encoded slashes, extra segments, upper case, NULs); also re-checked before every signed download |
| Direct uploads | migration 7 drops the browser upload policy; objects can only be created through a server-minted, single-use, create-only signed URL (no overwrite) |
| Wrong file type / spoofing | allow-list (PDF, PNG, JPG, ZIP, Markdown, text) at authorize time, bucket MIME allow-list at upload, stored MIME re-checked, extension must match the declared type, magic-number sniff of the stored bytes; failures delete the object |
| Oversize | 25 MB at authorize time, bucket limit, and the stored object's real size; DB check too |
| Fake funding | funding comes from a chain adapter when one exists (on-chain wins over the cache). With none, the cached status is used only if `EVIDENCE_REQUIRE_CHAIN_VERIFICATION` is not `true`, and the row records `funding_verified_onchain = false`. An adapter that errors is never treated as "funded". |
| Incomplete criteria | refused by the service and by a DB trigger |
| Duplicates / abuse | same path registered twice returns the same submission (also under concurrency); `storage_path` unique in the DB; max 10 submissions per invoice; max 20 objects per invoice+user folder |
| Unauthorized download | 404 for non-parties, unverified claimants and unknown ids; 60-second signed URLs minted per request, never stored; the bucket stays private |
| Service-role exposure | admin client is `server-only`; a build check confirms no client component imports it |
| CSRF | cookie-using POSTs require a same-origin `Origin` header |

Protected backend services (the future evaluator) use `createBackendReadUrl`, a server function that is **not** reachable through any HTTP route.

## Configuration

- Migrations 4–6 (Phase 3A) must be applied first, then `20261024000007_evidence_upload_hardening.sql` (review it, run `db push --dry-run`).
  If its first statement fails with *"must be owner of table objects"*, delete policy `evidence_insert_freelancer` in Dashboard → Storage → Policies.
- `.env.local`: `SUPABASE_SERVICE_ROLE_KEY` (server only). Optional `EVIDENCE_REQUIRE_CHAIN_VERIFICATION=true` once a chain adapter exists.
- Chain adapter: `getChainVerifier()` in `lib/evidence/server.ts` currently reports "unavailable". The integration owner supplies a
  viem-backed reader of the contract's invoice status (contract address, ABI and chain id are not frozen).

## Tests

`npm test` (96 tests, local Postgres via PGlite + a fake bucket). `tests/evidence.test.ts` (49) covers: authorized upload with DB row facts;
unauthenticated / no-wallet / unverified-claim / stranger / client callers; wrong invoice; traversal and malformed paths; invalid and spoofed
types; the 25 MB boundary (+1 byte, empty, fractional) and size taken from storage; authorized and unauthorized download; URL expiry
(download and upload); duplicates, concurrency and limits; funding/eligibility incl. chain-over-cache and fail-closed; policy/bucket/mock consistency.
Mutation check: removing the path-ownership check, the content sniff, the freelancer-only rule, or chain precedence each makes tests fail.

### What was and was not tested

**Not tested:** the real Storage API (`createSignedUploadUrl`, `list`, `createSignedUrl`, `remove`, `uploadToSignedUrl`), real signed-URL expiry
(enforced by Supabase; the tests use a fake bucket and prove we request short lifetimes and re-authorize every time), the browser upload helper,
the `invoice_id::text` PostgREST select, and the whole flow end to end. Routes were smoke-tested only for validation, origin checks and the
"not configured" response.

## Known limitations

- **Upload URL lifetime is 2 hours.** Supabase fixes it for signed upload URLs; we cannot shorten it. Mitigated by create-only, single-use,
  path-bound tokens, strict registration checks, and caps on unfinished uploads. Unregistered objects are orphans: add a cleanup job later.
- **Route uses the invoice's database UUID.** CLAUDE.md §8 shows `invoiceId` as the on-chain id; with multiple contract deployments that is ambiguous.
  The integration owner should confirm the public identifier before the general API is built.
- **No chain adapter yet**, so by default funding rests on the cached status (recorded as unverified). Set `EVIDENCE_REQUIRE_CHAIN_VERIFICATION=true`
  to refuse until the adapter exists.
- Magic-number sniffing is not a malware scan. ZIP contents are not inspected. Duplicate *content* (same bytes uploaded twice) is not detected.
- Signed upload tokens are not tied to the declared size/type; the bucket's limits and our post-upload checks are what enforce them.
- No per-IP rate limiting.
- Evaluation is not implemented: outside the demo a submission is stored and not evaluated.
