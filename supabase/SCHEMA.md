# Duely database schema (Phase 2)

Off-chain metadata only. **The contract and its receipts/events are authoritative for money.**
`invoices.onchain_status` and `invoices.advance_amount` are a cache; no row here, including a
`confirmed` transaction, establishes payment finality by itself. It only records what trusted server
code verified on-chain.

## Migration order

| # | File | Effect |
|---|---|---|
| 1 | `20261024000001_core_schema.sql` | Domains, 8 tables, constraints, indexes, immutability triggers |
| 2 | `20261024000002_rls_deny_by_default.sql` | RLS enabled **and forced** on every table, **zero policies**, public-role privileges revoked |
| 3 | `20261024000003_evidence_storage.sql` | Private `evidence` bucket (25 MB, allowed types), **no** object policies |
| 4 | `20261024000004_wallet_auth_functions.sql` | Service-role-only wallet challenge/binding functions; strips default `PUBLIC` execute |
| 5 | `20261024000005_rls_policies.sql` | Read-only SELECT policies for invoice parties (verified wallets only) |
| 6 | `20261024000006_evidence_storage_policies.sql` | Evidence upload (freelancer, own folder) and read (parties); write-once |

Policies, auth design and tests: see `AUTH_RLS.md`. After migrations 1–3 alone the tables are deny-all; migrations 5–6 add the read-only policies.

## Relationships

```
auth.users ──< user_wallets            (user_id)         verified_at NULL = unverified claim
auth.users ──< invoices                (registered_by)
wallet_challenges                       standalone nonces for wallet verification (server only)

invoices ──< invoice_criteria          (invoice_uuid)    ordered, insert-only
invoices ──< submissions               (invoice_uuid)    insert-only; storage_path unique
invoices ──< evaluations               (invoice_uuid, criteria_hash, criteria_version)  must equal the invoice's own
submissions ──< evaluations            (submission_id, invoice_uuid)   same invoice; many per submission = audit history
invoices ──< advance_requests          (invoice_uuid)
submissions ──< advance_requests       (submission_id, invoice_uuid, requester_address = submitter)
evaluations ──< advance_requests       (evaluation_id, submission_id, invoice_uuid)  an evaluation OF that submission
invoices ──< transactions              (invoice_uuid, nullable: e.g. depositReserve)
transactions ──< advance_requests      (transaction_id, invoice_uuid)  same invoice, must be approveAdvance; required once 'paid'
invoices ──< submissions               also (invoice_uuid, freelancer_address): submitter = the invoice's freelancer
```

Chain identity: `invoices` is unique on `(chain_id, contract_address, invoice_id)`. The on-chain id alone is only
unique per deployment. Users are identified through `user_wallets.address` ↔ `invoices.client_address` /
`freelancer_address` (lower-case `0x` + 40 hex).

## Tables

- **invoices**: chain ids, parties, `amount`, `criteria_hash` (bytes32), `criteria_version`, title/description/due date, creation tx hash, cached chain status.
- **invoice_criteria**: `(invoice_uuid, position)` primary key, `criterion_key` (the canonical `id`), `text`, `mandatory`.
- **submissions**: freelancer user + address, private `storage_path`, file name/size/type, note. Optional GitHub code submission (migration 9): `repository_url` (canonical `https://github.com/owner/repo`) + `commit_sha` (full lower-case 40-hex), both or neither, immutable like the rest of the row.
- **evaluations**: submission, invoice, `criteria_hash`/`criteria_version` evaluated against, `model`, `prompt_version`, `state`, `score` 0..100, `passed`, `criteria_results` (ordered JSON array), `summary` (rationale), `pass_rule`, `simulated`, timestamps.
- **advance_requests**: invoice, requester user/address, evaluation used, `status` (pending/paid/failed/denied), `amount`, `reason`, `idempotency_key`, `transaction_id`.
- **transactions**: invoice, `chain_id`, `action` (createInvoice/fundInvoice/depositReserve/approveAdvance/approveWork/disputeInvoice), `status`, `tx_hash`, block number/hash/timestamp, log index, decoded `receipt`, `simulated`.
- **user_wallets**: user ↔ address, with `verified_at`, `verification_method`, `verification_nonce`.
- **wallet_challenges**: single-use nonce, address, message, expiry, `used_at`.

## Guarantees enforced in SQL

| Rule | Mechanism |
|---|---|
| Exact amounts | `uint256` domain = `numeric` with `value = trunc(value)`, `0 ≤ value ≤ 2^256-1`. Not `numeric(78,0)`, which silently rounds `1.5` to `2`. Never float. |
| Invoice terms never change | trigger blocks edits to ids, parties, amount, `criteria_hash`, version; invoices cannot be deleted |
| Criteria cannot be silently edited or extended | rows reject UPDATE/DELETE; `invoices.criteria_count` and `criteria_canonical` (the exact hashed text) are immutable; inserts with `position >= criteria_count` are rejected, so the set can never grow; no submission is accepted until exactly `criteria_count` rows exist |
| Rows can't reference inconsistent invoices | composite foreign keys: submission ↔ invoice and its freelancer address; evaluation ↔ its submission's invoice and the invoice's `criteria_hash`/`criteria_version`; advance request ↔ a submission of that invoice by the requester, an evaluation of *that submission*, and a transaction of that invoice |
| Advance basis is fixed | advance amount must equal `floor(invoice amount * 90 / 100)`; invoice, requester, submission, evaluation, amount and key are immutable after insert; a linked transaction must be an `approveAdvance` |
| Evaluation audit history | evaluations are append-only; only a `running` row can be finalized; completed rows reject UPDATE/DELETE; `completed` requires score, pass flag, results, summary |
| No false finality | `confirmed` transaction requires `tx_hash`, `block_number`, `confirmed_at`, `simulated = false`; confirmed/failed are final; `(chain_id, tx_hash)` unique; simulated rows cannot carry a hash |
| One advance per invoice | partial unique index on `advance_requests(invoice_uuid)` where status in (pending, paid); `paid` requires a transaction reference; `(requester, idempotency_key)` unique. The contract must still reject duplicates independently. |
| Advance can't exceed invoice | `advance_amount <= amount` |
| Wallet ownership | a wallet can be **verified** for only one user (partial unique index); unverified claims can't squat an address; verified ownership can't be reassigned or un-verified; `verified_at` and `verification_method` are set together |
| Deny by default | RLS enabled and forced on every table; after migration 5 browsers get SELECT-only policies for invoice parties with a verified wallet, and no write grants anywhere |

## Deliberately NOT enforced in the database (backend owns these)

- That the referenced evaluation **passed**, is the **latest** for the submission, and that every mandatory criterion passed.
- On-chain eligibility (funded, undisputed, unsettled, no prior advance on chain, reserve available).
- That `criteria_canonical` hashes to `criteria_hash` and matches the `invoice_criteria` rows (the canonical encoding is not frozen yet).
- That the wallet really belongs to the session user (wallet verification phase).
- That all criteria rows are inserted together: use one atomic RPC/transaction. Until all rows exist, submissions are refused.

## Read this before writing API code (Phase 3+)

- **numeric over JSON:** PostgREST returns `numeric` as a JSON number, which is lossy above 2^53 in JavaScript.
  Read amounts with `select=amount::text` (or an RPC/view) and send/receive decimal strings. Never `Number()` them.
- **Writes are service-role only; browsers can read** their own invoices once migration 5 is applied. The service role bypasses RLS, so the server must do
  authentication, wallet-binding and chain-state checks itself.
- **Submissions and evaluations are immutable**, so privacy erasure requests need a deliberate admin procedure.
