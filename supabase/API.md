# Backend API (Phase 4)

**Status: implemented and tested locally against the real schema with fake chain / signer / evaluator. Migrations 4–8 are not
applied to any project, there is no chain adapter or signer, and nothing here has run against live Supabase.** In real mode,
invoice registration and advances therefore answer `503 INTEGRATION_UNAVAILABLE` by design.

All endpoints: JSON in/out, Zod-validated with **strict** schemas (unknown fields are rejected), session from Supabase Auth cookies,
errors as `{ "error": { "code", "message" } }`, `Cache-Control: no-store`. Every POST needs a same-origin `Origin` header.
Amounts and uint256 ids are decimal **strings**; arithmetic is `bigint`. Order of checks: origin → body validation → session →
verified wallet → role on the invoice → business rules → chain.

Identifier note: `:id` / `invoiceId` in these routes is the invoice's **database UUID** (`invoices.id`), except `POST /api/invoices`, whose
`invoiceId` is the **on-chain** decimal id. CLAUDE.md §8 uses the on-chain id everywhere; with several contract deployments that is
ambiguous. The integration owner should confirm the public identifier.

## Endpoints

| Endpoint | Who | Result |
|---|---|---|
| `POST /api/invoices` `{invoiceId, txHash, description, criteria[{id,text,mandatory}], title?, dueDate?}` | signed in, verified wallet that **created** the invoice on-chain | `201` (new) / `200` (already registered) invoice record. Persists only after the chain adapter confirms the tx, creator, invoice id and that `keccak256(canonical criteria)` equals the on-chain hash. Amount, parties, token and contract come from the chain, not the body. **No adapter → `503 INTEGRATION_UNAVAILABLE`, nothing stored.** |
| `GET /api/invoices/:id` | client or freelancer (verified wallet); others `404` | invoice, criteria, submissions (no storage paths), evaluations, advance requests, and a `chain` block: `{verified:true,...}` from the chain, or `{verified:false, cachedOnchainStatus, cachedStatusIsProof:false}`. `financialStatusVerified` says which. |
| `POST /api/submissions` `{invoiceId, storagePath}` | assigned freelancer | **Phase 3B, unchanged and reused:** path must be one the server issued for this invoice+user, object verified (size, MIME, magic bytes), funding checked. See `EVIDENCE.md`. |
| `POST /api/evaluate` `{submissionId}` | the submitting freelancer only | `201` / `200` (existing) evaluation. Input is **only** the submission id (a browser `score`/`passed` is a `400`). Frozen criteria + stored evidence go to the evaluator; **the server computes `passed`** (score ≥ 80 and every mandatory criterion met). Only the latest submission can be evaluated. One live evaluation per submission (DB-enforced). Disabled evaluator → `503 EVALUATOR_UNAVAILABLE`. |
| `POST /api/advances` `{invoiceId}` (+ optional `Idempotency-Key` header) | the invoice's freelancer | `202` pending / `200` existing request. Needs the **latest** submission's **real** (non-simulated) passing evaluation, then live on-chain `Funded` with no advance, dispute or settlement, then reserve ≥ floor(90%). **No chain adapter or signer → `503 INTEGRATION_UNAVAILABLE`, nothing recorded.** Never returns `paid`. |

Stored evaluation fields: submission, invoice, criteria hash + version, model, prompt version, score, passed, ordered criterion results (with
mandatory flags), rationale (`summary`), pass rule, `simulated`, timestamps.

## Real vs demo (mock) separation

- The mock/demo workflow lives entirely in the browser (`MockDuelyRepository`); no API code imports it (test-enforced).
- `NEXT_PUBLIC_DATA_MODE` selects a UI adapter only; it never relaxes server authorization.
- The deterministic evaluator runs only with `DUELY_EVALUATOR_MODE=demo` **and** a non-production runtime. Its results are stored with
  `simulated = true`, and `POST /api/advances` rejects any simulated evaluation (`EVALUATION_NOT_REAL`) even if chain and signer exist.

## Integration points still missing (not invented)

| Needed | From | Where it plugs in |
|---|---|---|
| Compiled `InvoiceAdvance` ABI, deployed address, chain id, RPC URL, token address | Track A / integration owner | `getChainAdapter()` in `lib/backend/server.ts` (returns the "unavailable" adapter today). Must implement `getInvoiceCreation(txHash)` (receipt + `InvoiceCreated` event), `getInvoiceState`, `getReserveAvailable`. |
| Protected platform signer for `approveAdvance` | Track A / integration owner | `getAdvanceSigner()` in `lib/backend/server.ts`. Key stays server-side; never in the AI or browser. |
| Receipt reconciliation (`pending` → `paid`/`failed`, writing confirmed `transactions` with block data) | Track B follow-up | Not built. Until then an advance stays `pending`; nothing is ever marked paid. |
| Frozen canonical criteria encoding | integration owner | `lib/backend/criteria.ts` implements the CLAUDE.md §6 **proposal** (versioned, ordered, NFC, Keccak-256). A different choice changes only that module. `lib/frontend/criteria-digest.ts` is a mock placeholder and is **not** this hash. |
| Real evaluator | next phase | `Evaluator` port in `lib/backend/ports.ts`. |

## Apply and verify

1. Apply migrations 4–8 to the dev project (review, then `npx supabase db push --dry-run`, `db push`). Add `SUPABASE_SERVICE_ROLE_KEY` to `.env.local`.
2. `npm test` → 162 tests (local Postgres via PGlite) including 66 for these endpoints.
3. With the dev server running (`npm run dev`) and a signed-in session cookie, the honest expected results today:
   - `curl -i -X POST localhost:3000/api/advances -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' --cookie "<session>" -d '{"invoiceId":"<uuid>"}'`
     → `503 INTEGRATION_UNAVAILABLE` once local eligibility passes (or the specific 4xx that blocks it).
   - Same for `POST /api/invoices` → `503 INTEGRATION_UNAVAILABLE`.
   - `POST /api/evaluate` → `503 EVALUATOR_UNAVAILABLE`, or with `DUELY_EVALUATOR_MODE=demo` a `201` flagged `"simulated": true`.
   - `GET /api/invoices/<uuid>` → `200` with `"chain": {"verified": false, "reason": "INTEGRATION_UNAVAILABLE", ...}` for a participant, `404` for anyone else.
   - Without a session: `401`. Without `Origin`: `403`. Extra body fields (`score`, `amount`, ...): `400`.

## Not tested

Anything needing live Supabase (PostgREST casts such as `invoice_id::text`, the `register_invoice` RPC via `supabase-js`, Storage, auth cookies) or a real
chain/signer/evaluator. The HTTP handlers were driven with real `Request` objects against the real schema; the production Supabase adapter
(`createSupabaseBackendDb`) is type-checked but its queries have not been executed.
