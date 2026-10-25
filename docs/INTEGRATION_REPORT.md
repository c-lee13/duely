# Duely Integration Report

| Phase | State |
|---|---|
| 1. Integration audit | complete (section "Phase 1" below, kept as written) |
| 2. Foundations (build, lockfile, lint, types, token, hashing, migration 9, deployment isolation) | **complete, awaiting review** (this section) |
| 3. Backend <-> chain (adapter, evidence verifier, evaluator signer, reconciliation) | **complete and verified** (section "Phase 3" below) |
| 4. Frontend <-> wallet/chain (+ operator dispute resolution) | **implemented and tested against a simulated chain; not yet exercised in a browser or on the live chain** (section "Phase 4" below) |
| 5. End-to-end tests, docs, optional approved live run | not started |

---

# Phase 4 - Frontend + MetaMask (2026-10-25)

Scope respected: no contract change or redeploy, **no transaction of any kind was sent** to any chain, migration 9 **not applied**, nothing committed or pushed.
Every wallet workflow was built and tested incrementally; each got its own tests before the next began.

## Verified results (recorded from runs)

| Check | Command | Result |
|---|---|---|
| Install | `npm ci` | exit 0 |
| Lint / typecheck | `npm run lint` / `npm run typecheck` | exit 0 / exit 0 |
| Production build | `npm run build` | exit 0 (routes now include `/api/operator/invoices`) |
| Track B (backend, wallet flows, UI wiring) | `npm test` | **479 passed**, 0 failed, 0 skipped, 91 suites (was 396; +83: 82 new tests, +1 from splitting one existing test in two) |
| Chain SDK + scripts | `npm run test:chain` | **304 passed**, 0 failed |
| Foundry | `cd contracts && forge fmt --check && forge test` | **81 passed**, 0 failed |
| ABI / manifest | `export-abi.mjs --check`; dUSD manifest sha256 | up to date; unchanged (`1fd19320...`) |
| Client bundle secret scan | scanned all 44 files in `.next/static` for the values of every server secret in `.env` | **no secret value in any client file** (the only string match is a variable *name* inside Track B's own error text) |
| Production server smoke | `next start`, unauthenticated | `/`, `/client/invoices/new`, `/platform`, `/activity`, `/freelancer` -> 200; `GET /api/operator/invoices`, `/api/advances/:id`, `/api/invoices` -> 401; `POST /api/advances` without Origin -> 403 |

New Phase 4 test files: `wallet-chain` 16, `tx-runner` 12, `live-client-flows` 15, `live-lifecycle-flows` 22, `frontend-live-wiring` 12, `operator-api` 5.
Two existing live-data tests were rewritten on purpose because their premise ("every wallet action throws NOT_IMPLEMENTED") is exactly what Phase 4 replaces; the intent (no faked chain result, no widening by view role) is kept.

**What these tests are:** the real browser repository + wallet gate + SDK + backend handlers + chain adapter + Postgres schema, wired to ONE simulated chain whose contract double applies InvoiceAdvance's documented transitions and events (`tests/helpers/sim-contract.ts`). They prove the integration and the consumption of the contract's rules, **not** that the UI renders correctly in a browser nor that MetaMask behaves as modelled.

## Implementation by workflow

* **Wallet + network (goal 1)** `lib/frontend/wallet-chain.ts`: reads MetaMask without prompting (`eth_accounts`/`eth_chainId`), explicit `connectWallet`, `switchToExpectedChain` (adds XRPL EVM Testnet with the public RPC and explorer if unknown), and `requireWallet`, the gate in front of every transaction: NO_WALLET / WALLET_NOT_CONNECTED / WRONG_NETWORK (must be 1449000) / WRONG_ACCOUNT (must be the exact account allowed to act). `components/duely/wallet-status.tsx` shows account, network and the configured deployment (symbol, decimals, demo/not) in live mode.
* **Transaction lifecycle (goals 6, 7)** `lib/frontend/tx-runner.ts`: one transaction from wallet prompt to a *verified* outcome. Returns only for `confirmed` (SDK `trackTransaction`: mined, succeeded, expected event with the submitted arguments). Pending/unknown -> `TX_UNCONFIRMED` ("do not send it twice"), reverted/replaced/unverified -> `TX_FAILED`, rejection -> `USER_REJECTED`; every SDK error code has a specific UI code (compile-time exhaustive). `lib/frontend/tx-log.ts` keeps this browser's record (deployment-scoped, survives reload, resumable via the SDK's serialized form). `components/duely/tx-progress.tsx` shows each step (waiting for wallet / submitted / confirmed / failed / not confirmed) with explorer links.
* **Client: create + fund (goal 2)** `ApiDuelyRepository.createInvoice/fundInvoice`: criteria ids are positional (`c1..cn`), hashed with the shared `computeMetadataHash`; `createInvoice` tx -> confirmed -> `POST /api/invoices` (the server re-verifies the transaction, creator and hash); then, if needed, an **exact-amount** allowance and `fundInvoice`. Pre-flight reads (balance, paused token, status) refuse before any prompt. If registration fails after the on-chain creation, the user is told nothing is lost and the next dashboard load registers it (idempotent, only for verified-confirmed transactions).
* **Freelancer (goal 3)** unchanged endpoints, now backed by Phase 3: evidence needs chain-proven funding; evaluation; `requestAdvance` returns `paid` only if the server saw the confirmed `AdvancePaid`, else `pending` with the hash; the page polls every 4 s while pending (the server settles it against the chain on each read).
* **Client: approve / dispute (goal 4)** `approveInvoice` (`approveCompletion`) and `disputeInvoice` (`raiseDispute`): wallet must be the invoice's client; the chain status must allow it (Funded/Advanced) or the action is refused before the wallet opens.
* **Operator (goal 5)** `GET /api/operator/invoices` (authorized by the **on-chain** `OPERATOR_ROLE` of a verified wallet; statuses read from the chain; other deployments, fixtures and failed reads excluded). Platform page: reserve deposit (exact allowance + `depositReserve`), advances outstanding / at risk, and `resolveDispute` with the **actual contract semantics**: *Pay the freelancer* = settle normally; *Refund the client* = whole escrow back, invoice becomes **Cancelled**, advance **not** clawed back (the reserve bears it). Confirm dialogs say exactly this.
* **Displays (goals 6, 7)** balances/escrow/reserve are read from the chain; a failed read says "unavailable" rather than 0; the invoice transaction list shows real hashes with explorer links and labels a pending one "Sent, not final yet"; every action calls `reload` after it settles; stale "not connected / simulated" copy replaced by live wording (dispute copy now matches the contract).

## Bugs found by the integration tests (and fixed)
1. **Checksummed addresses vs. the database's lower-case domain.** The SDK returns EIP-55 addresses; `register_invoice` and `attachPendingTransaction` store only lower-case. Registration would have failed with a check violation, and, worse, **after** the evaluator had already broadcast `approveAdvance` (the pending transaction row would not have been recorded). Fixed at the boundary: the chain adapter and the signer return lower-case; covered by tests that run the real schema.
2. **Live token formatting** used the module-level data mode, so a live repository could print mock "DEMO" amounts. The live repository now pins the live token display.
3. **Invoice id missing on the creation log entry**, so the invoice page could not show it. Fixed.

## What is live vs mocked after Phase 4

| Piece | State |
|---|---|
| Chain SDK + deployed RLUSD/dUSD contracts | live-verified earlier (A6.6.4b); read-only smoke again in Phase 3 |
| Backend chain adapter / signer / reconciliation | real code; automated tests on mock chain; never ran against the live chain |
| Browser wallet layer + all UI flows | real code; **never run in a browser**; tested through the repository against a simulated chain |
| MetaMask behaviour (prompts, `wallet_addEthereumChain`, account/chain events) | **modelled** by a fake EIP-1193 provider; unverified |
| Gemini evaluation, Supabase | Track B real integrations; no new live call made in Phase 4 |
| Evaluator signing | `EVALUATOR_PRIVATE_KEY` is **still empty** in `.env`: advances answer 503 until it is set |

## Remaining blockers before a live end-to-end demo
**P0**
1. Set `EVALUATOR_PRIVATE_KEY` (server-only, `.env`) for the account `0x276acaB037BB048a682E0E7ad900F3fFDCe65ECb` (the signer refuses any other key). Without it the advance step cannot work.
2. A **first real browser run** with MetaMask: nothing about the rendered UI or MetaMask prompts has been seen by a person yet. Expect cosmetic and flow bugs; budget time for them.
3. MetaMask accounts: the **client** (imported, per you), the **operator** `0x6e83F6Bb6758Ced46e60be88271D72C22B84482E` (deposit + dispute resolution) and a **freelancer** wallet (to sign in, submit evidence and request the advance; it needs no funds). The server authorizes every view by the verified wallets of the current sign-in, and an action signed by an account that is not one of them is refused with a clear message (WRONG_ACCOUNT). Whether one sign-in can hold several verified wallets was **not exercised**, so plan to sign out and sign in again with each account (client, freelancer, operator).

**P1**
4. Evidence for Gemini must be `.txt` or `.md`.
5. The reserve holds 5 RLUSD (enough for 5 one-RLUSD invoices at 0.9 each, restored after each settlement).
6. Migration 9 is not applied. Phase 4 does not need it (client wallet transactions are recorded only in the browser; the server records `approveAdvance` and caches `Advanced`). It is needed before the server ever caches `Cancelled` or records the new action names.
7. Not built (not in the Phase 4 goals): `cancelInvoice` and `withdrawReserve` UI, event-indexed history across devices (the activity list is per browser), polling on the client page only reloads pending *wallet* transactions.

**P2** Playwright/browser E2E suite; delegated or hardware signing for the evaluator; stricter rate limits on the advance endpoint.

## Exact requirements for the live demo (Phase 5)
Order: operator deposits (if the reserve < 0.9 RLUSD per planned invoice) -> client creates and funds a 1 RLUSD invoice -> freelancer uploads a `.txt` -> evaluates -> requests the advance (0.9 RLUSD arrives after confirmation) -> client approves (0.1 RLUSD paid, reserve restored). Second invoice: client disputes; operator refunds. Each step needs your explicit approval before any broadcast; I will give the account, the exact transaction and the expected on-chain result before each.

---

# Phase 3 - Backend <-> blockchain (2026-10-25)

Scope respected: no contract change or redeploy, **no transaction of any kind was sent** (all write paths are tested against mocked signers/RPC), migration 9 **not applied**,
nothing committed or pushed. Nothing falls back to mock data: an unreachable chain is `502 CHAIN_ERROR`, an absent/wrong evaluator key is `503 INTEGRATION_UNAVAILABLE`.

## Verified results (recorded from runs, not estimated)

| Check | Command | Result |
|---|---|---|
| Track B backend/auth/evidence/AI | `npm test` | **396 passed**, 0 failed, 0 skipped, 73 suites (was 333; +63 new) |
| New Phase 3 files | `tsx --test tests/<file>` | advance-signer 13, chain-adapter 22, reconcile 24, evaluation-hash 4 (all pass) |
| Chain SDK + scripts | `npm run test:chain` | **304 passed**, 0 failed |
| Foundry | `cd contracts && forge test` | **81 passed**, 0 failed |
| Production build | `npm run build` | exit 0; routes include the new `/api/advances/[id]` |
| Lint / typecheck | `npm run lint` / `npm run typecheck` | exit 0 / exit 0 |

Also run read-only against the **live RLUSD deployment** with the real adapter (no transaction): invoices #1 and #2 read back `Settled`, amount 1 RLUSD, advance 0.9 RLUSD;
a non-existent invoice is `ChainInvoiceNotFoundError`; the dUSD contract address is refused with `ChainScopeError`; reserve 5 RLUSD; the A6.6.4b creation transaction decodes as
`confirmed`, creator = the client wallet, 1 RLUSD; the A6.6.4b advance transaction checked against a *wrong* evaluation hash is `unverified` (never `confirmed`).

## Implementation

* `lib/backend/chain-adapter.ts` (`createChainAdapter`, server-only): the backend's only chain reader, built on the SDK (`getInvoice`, `getAvailableReserve`, `getTransactionStatus`/`trackTransaction`, `decodeInvoiceAdvanceEvents`).
  Invoice reads are pinned to one block and include the contract's own client/freelancer/`metadataHash`/`evaluationHash`. Refuses (ChainScopeError) any reference for another chain/contract/token and an RPC on the wrong chain.
  `getInvoiceCreation` attributes a creation only if the receipt was sent to this deployment's contract, carries exactly one `InvoiceCreated`, and its `client` equals the sender.
  `getAdvanceTransaction` is `confirmed` only when the SDK verified sender + contract + `AdvancePaid(invoiceId, evaluationHash)`; the payout facts (recipient, amount) come from that decoded event.
  `findAdvancePaid` scans the last 5,000 blocks of `AdvancePaid` logs (crash recovery).
* `createChainFundingVerifier`: evidence funding gate on the same adapter. Anything but a chain-read status for this deployment (RPC error, missing invoice, wrong deployment, party mismatch, dev fixture) is `unavailable`.
  `lib/evidence/server.ts` now **requires** chain proof by default (`EVIDENCE_REQUIRE_CHAIN_VERIFICATION` must be the literal `false` to relax it, for dev fixtures).
* `lib/backend/advance-signer.ts` (`createEvaluatorSignerFromEnv`, server-only): signs `approveAdvance(invoiceId, evaluationHash)` with `EVALUATOR_PRIVATE_KEY`. The key must belong to the deployment's evaluator address, the account must hold `EVALUATOR_ROLE` on-chain,
  the SDK simulates first (state/role/reserve reverts never broadcast) and blocks in-process duplicates; the signer never waits, never retries, never logs, and never exposes the key (tests: not serialized, not in errors, only `lib/backend/server.ts` imports it, no `NEXT_PUBLIC_*` variant).
* `lib/shared/evaluation-hash.ts`: `evaluationHash = keccak256(JSON {v:1, evaluationId, submissionId, criteriaHash, score})`, deterministic from immutable DB rows, so it is never stored and a restart can recognise and verify its own transaction.
* `lib/backend/advances.ts`: before signing it now also checks the on-chain parties and criteria commitment against the registered invoice (`INTEGRITY_MISMATCH`), uses the SDK's `advanceAmountFor`, passes the evaluation hash, then reconciles (bounded wait `confirmWaitMs`, 15 s in production).
* `lib/backend/reconcile.ts` (`reconcileAdvance`): the only code that can set an advance to `paid`: only from a confirmed receipt whose event matches invoice, evaluation hash, freelancer **and** amount. Reverted/replaced -> `failed` (slot released).
  Unverified/unknown/RPC error -> stays `pending` (mismatches add a "manual review" reason). Interruptions: a pending request with no hash is judged only after 120 s: invoice still `Funded` on-chain -> "never broadcast" -> failed; an advance with *our* evaluation hash -> recovered from events and confirmed; a different hash -> manual review. Writes are conditional and idempotent (a crash between steps is repaired by the next call).
* New `GET /api/advances/:id` (parties only; settles against the chain first). `GET /api/invoices/:id` also settles pending advances. `POST /api/advances` on a live pending request reconciles instead of signing again.

## What is live vs mocked after Phase 3

| Piece | State |
|---|---|
| Chain reads (invoice state, reserve, creation tx, advance tx, event scan) | **Real code over the SDK**; smoke-tested read-only against live RLUSD; automated tests use the SDK's mock chain |
| Evidence funding gate | **Real chain proof required**; tests with mock chain |
| Evaluator signing | **Real code; never run against the live chain.** Tested with a mocked wallet. `EVALUATOR_PRIVATE_KEY` is **empty** in `.env`, so the signer is unavailable (503) until you set it |
| Reconciliation | Real code, tested with a fake chain reader over the real schema (PGlite) |
| Supabase | Live project reached read-only; migration 9 not applied (not required by Phase 3) |
| Gemini | Real evaluator already integrated (Track B); no live call made here |

## Remaining P0 after Phase 3
* Phase 4: browser wallet layer, create/fund/approve/dispute/deposit/resolve flows, operator UI, pending/confirmed/failed UI (frontend still throws "not implemented" in live mode).
* `EVALUATOR_PRIVATE_KEY` must be provided in `.env` (server only) before any live advance.
* Decision pending: approve and apply migration 9 before the first live `Cancelled`/`approveCompletion`/`raiseDispute`/`resolveDispute` transaction rows are recorded (the current DB check rejects those action names).

---

# Phase 2 - Foundations (2026-10-25)

Scope respected: no Phase 3 signing, no Phase 4 wallet flows, no value-transferring transaction, **migration 9 prepared and tested but NOT
applied to the live Supabase project**, nothing committed or pushed. No contract or deployment behaviour changed (Foundry sources untouched).

## Result against the acceptance list

| Requirement | Result | Evidence |
|---|---|---|
| `npm ci` succeeds | **PASS** | fresh `npm ci` (node_modules removed and reinstalled): exit 0, 669 packages, 0 vulnerabilities |
| `npm run build` | **PASS** | `next build`: compiled, "Finished TypeScript", 11 static pages + all `/api/*` routes |
| Source lint | **PASS** | `npm run lint`: exit 0, 0 problems (was 1,435) |
| `npm run typecheck` | **PASS** | 0 errors (was 8 x TS2688 + 3 hidden real errors) |
| Foundry | **PASS** | 81 passed, 0 failed (unchanged) |
| Chain SDK + scripts (`npm run test:chain`) | **PASS** | 304 passed (301 before + 3 new tooling tests), 0 failed |
| Track B (`npm test`) | **PASS** | 333 passed (286 before + 47 new), 0 failed |
| Hash vectors cross-checked | **PASS** | `cast keccak` equals `computeCriteriaHash`; the live RLUSD contract's `createInvoice` accepts it (eth_call only, nothing sent) |
| dUSD manifest unchanged | **PASS** | sha256 `1fd19320...b720e` unchanged; `git status` shows it untouched |

No suite was weakened or skipped. One existing Track B test (`tests/live-data.test.ts`, "an on-chain id shared by two of the caller's invoices")
was **rewritten on purpose** because deployment isolation changes the behaviour it asserted (see Deployment isolation); the test count is unchanged.
Construction sites of `BackendDeps` / `EvidenceDeps` in tests gained the now-mandatory `scope` field (setup only, no assertion changed).

## What changed

### 1. Build and genuine type errors
* `tsconfig.json`: `compilerOptions.types = ["node"]`. Root cause of the 8 TS2688 errors: TypeScript auto-loads every `@types/*` it can see,
  including **ancestor** directories (`~/node_modules/@types/*` are empty stubs from a stray pnpm install). The build is now independent of the machine's home directory.
* The 3 real errors hidden behind it were `spawnSync(..., { env: { PATH } })` calls rejected by Next's `ProcessEnv` typing:
  `scripts/chain-integration.test.ts` (2), `lib/chain/deployments.test.ts` (1, mine). Fixed with one documented helper, `lib/chain/test/child-env.ts`.
* Regression test: `scripts/deployment-tooling.test.ts` ("tsconfig restricts ambient types").

### 2. Lockfile
`npm install --package-lock-only` added only the two missing entries (`viem@2.57.11`, `web-streams-polyfill@3.3.3`) plus the resulting dependency edge
(108 insertions, 1 line re-punctuated); `package.json` is unchanged. Regression test: lock root == package.json, every direct dependency locked.

### 3. Lint scope
`eslint.config.mjs` now ignores `contracts/lib/**`, `contracts/out|cache|broadcast/**`, `coverage/**` and `lib/chain/generated/**` (generated).
Source is **not** weakened: project files are asserted linted-and-clean in a test, and `npm run lint` over `app components hooks lib scripts tests proxy.ts` was already clean.

### 4. Hardcoded DEMO token -> deployment-aware token
* `lib/frontend/token.ts`: new `tokenDisplay()` / `tokenNotice()`. **Live mode** reads `paymentTokenInfo` (dUSD: 6 decimals, demo; RLUSD: 18 decimals,
  *not* a demo token). **Mock mode** keeps an explicit simulated `MOCK_TOKEN` ("DEMO", 18 decimals) and the mock ledger/fixtures are pinned to it, so a mock is never labelled RLUSD.
  `DEMO_TOKEN` is removed (test asserts no source references it). `formatToken` / `parseTokenInput` / `tokens` take an optional token for testing.
* UI copy that said "DEMO tokens aren't RLUSD" now comes from `tokenNotice()`: RLUSD is described as the issuer's testnet token that can be paused/clawed back.
* Persisted mock state key bumped to `duely.mock-state.v2` (stale simulated data with legacy action names is ignored; it is not user data).

### 5. Shared types, statuses and transaction actions
* New `lib/shared/types.ts` (CLAUDE.md section 6): `ONCHAIN_INVOICE_STATUSES` in the contract's order **including `Cancelled`**, and `TX_ACTIONS` = the nine state-changing contract functions
  (`createInvoice, cancelInvoice, fundInvoice, depositReserve, withdrawReserve, approveAdvance, approveCompletion, raiseDispute, resolveDispute`). `lib/frontend/domain.ts` re-exports them (single definition).
* `approveWork`/`disputeInvoice` renamed to `approveCompletion`/`raiseDispute` in the UI, mock ledger and labels. `Cancelled` handled everywhere TypeScript flagged a non-exhaustive map
  (status badges, hints, money breakdown, freelancer next-step `cancelled`, advance eligibility `INVOICE_CANCELLED`).
* Tests: `tests/status-alignment.test.ts`; `tests/migration-9.test.ts` also asserts the TS lists equal the SDK's `INVOICE_STATUSES` and `WRITE_REQUIREMENTS`.

### 6. One shared criteria hash (`metadataHash`)
* New `lib/shared/criteria.ts` is the single implementation (browser, backend, tests); `lib/backend/criteria.ts` and `lib/frontend/criteria-digest.ts` now delegate to it
  (the old mock-only FNV placeholder is gone).
* **Verified compatible with the contract**: the encoding is `JSON.stringify({v:1, criteria:[{id,text,mandatory}...]})` (NFC + trim, order preserved), hashed with Keccak-256 over UTF-8.
  InvoiceAdvance stores any non-zero `bytes32` as `metadataHash` and emits it in `InvoiceCreated`; it imposes no format. Evidence: `cast keccak` reproduces vector 1 exactly; an `eth_call`
  of `createInvoice` with that hash on the live RLUSD contract succeeds; the SDK's `createInvoice` puts the exact 32 bytes in the calldata (test).
* Frozen vectors (`tests/shared-criteria.test.ts`): V1 `0x798688a0...3160`, V2 (Unicode/emoji/decomposed e-acute) `0xb0735c9f...e5ae`, V3 (trim + JSON escapes) `0x749334b6...e4fe`.
  Naming: contract/SDK call it `metadataHash`; DB, API and UI keep `criteriaHash`; both are the same bytes (documented in the module).

### 7. Migration 9 (prepared, NOT applied remotely)
`supabase/migrations/20261025000009_dual_token_alignment.sql`, additive and idempotent:
1. `invoices.onchain_status` check now allows `Cancelled` (all existing values stay valid).
2. `transactions.action` check now allows the nine contract function names; legacy `approveWork`/`disputeInvoice` stay valid.
3. New check `invoices_real_deployment_check`: a non-fixture invoice (`chain_id <> 0`) must have non-zero contract **and** token addresses.
4. New index `invoices_deployment_idx (chain_id, contract_address, token_address)`.
No column dropped/rewritten, no row touched, RLS untouched. Tested in `tests/migration-9.test.ts` (PGlite, real schema): accepts every contract status/action, rejects junk,
fixtures still allowed, same on-chain id on two deployments coexists, **idempotent on re-run, and applied on top of a database that already holds legacy rows (Settled invoice, `approveWork`/`disputeInvoice` transactions, a fixture) keeps every row**.
Read-only pre-check of the live project: 1 invoice (the `chain_id = 0` fixture), 0 transactions; 0 rows violate the new check. **Awaiting your approval of the SQL before it is applied.**

### 8. Deployment isolation (dUSD vs RLUSD)
* `lib/shared/deployment-scope.ts` (`DeploymentScope`, `invoiceInScope`) and `lib/backend/scope.ts` (`activeDeploymentScope()` from `DUELY_DEPLOYMENT`; throws `DeploymentConfigError`, never falls back).
* `scope` is a **required** field of `BackendDeps` and `EvidenceDeps`; production builders set it (`lib/backend/server.ts`, `lib/evidence/server.ts`), a test asserts both, and the type makes an unscoped path a compile error.
* Enforced in: invoice list (other deployments filtered out), by-on-chain-id resolution (so dUSD #1 can never shadow RLUSD #1), `loadInvoiceAsParty` (UUID access -> `409 WRONG_DEPLOYMENT` for a *party*, `404` for strangers so existence is not revealed),
  advances, evaluation, evidence upload, and invoice registration (a creation transaction from another contract/token is rejected and stores nothing).
* `AMBIGUOUS_INVOICE` can no longer occur across deployments (the unique key `(chain, contract, invoice_id)` covers within one). `chain_id = 0` dev fixtures belong to no deployment and stay visible (still flagged in the UI).
* Tests: `tests/deployment-isolation.test.ts` (13): same on-chain id on both deployments with amounts in each one's decimals; list/detail per server; advance refused before any chain call or signing; evaluator not invoked; evidence refused; registration refused.

## New and changed files
New: `lib/shared/{types,criteria,deployment-scope}.ts`, `lib/backend/scope.ts`, `lib/chain/test/child-env.ts`, `supabase/migrations/20261025000009_dual_token_alignment.sql`,
`tests/{token-display,shared-criteria,deployment-isolation,migration-9,status-alignment}.test.ts`.
Changed: `tsconfig.json`, `eslint.config.mjs`, `package-lock.json`, `.env.example` (names only), `lib/frontend/{token,domain,criteria-digest,api-mappers,eligibility}.ts`,
`lib/backend/{access,advances,api-error,criteria,evaluation,invoices,ports,server}.ts`, `lib/evidence/{service,server}.ts`, `lib/mocks/{ledger,fixtures,mock-repository}.ts`,
`lib/supabase/database.types.ts`, `supabase/SCHEMA.md`, UI: `app/(app)/{client/page,client/invoices/new/page,freelancer/page,platform/page}.tsx`, `components/duely/{app-shell,invoice-parts,primitives}.tsx`,
tests: `scripts/chain-integration.test.ts`, `scripts/deployment-tooling.test.ts`, `lib/chain/deployments.test.ts`, `tests/{backend-api,evidence,gemini-evaluator,live-data}.test.ts`, `tests/helpers/backend.ts`.

## Remaining blockers / not done (unchanged from Phase 1 unless noted)
* **Not started by design:** chain adapter, evidence funding verifier, evaluator signer + `evaluationHash` + key custody (env-held key decided; unused until Phase 3), receipt reconciliation, browser wallet layer, operator dispute resolution (Phase 4).
  `POST /api/invoices` and `/api/advances` therefore still answer `503 INTEGRATION_UNAVAILABLE`; create/fund/approve/dispute remain "not implemented" in live mode.
* **Migration 9 is not applied to the live Supabase project** (awaiting your SQL approval). Until it is, a live `Cancelled` write or a `approveCompletion` transaction row would be rejected by the old checks; nothing writes them yet.
* Dispute UI copy still says "nothing is refunded automatically" (contradicts `resolveDispute`); deliberately left for Phase 4 together with the operator resolution UI.
* Track B docs (`supabase/API.md`, `LIVE_MODE.md`, `README.md`) still describe migrations 4-8 as unapplied and an unconnected chain; refreshed in Phase 5.
* Unverified: browser/MetaMask behaviour, live Gemini, runtime bundling of `lib/chain` in the client (the production build compiles it; it has not been exercised in a browser).
* Environment note: `~/node_modules` and `~/pnpm-lock.yaml` (stray) still exist on this machine; the build no longer depends on them, but Next prints a harmless `turbopack.root` warning.

---

# Phase 1 - Integration Audit (as delivered)

Status: **Phase 1 complete (audit only). No application code, migration, configuration or dependency manifest was modified.**
Branch `integration` at `dbc276c` (merge of `frontend` into `integration`; Track A SDK + A6.6 RLUSD work, Track B frontend/Supabase/AI).
Date of audit: 2026-10-25. Method: read the merged code end to end, traced every connection, ran the baseline tests, and
checked live configuration with **read-only** calls (RPC, Supabase REST). Nothing was broadcast, deployed, written to Supabase or committed.

Environment note: four Track B packages declared in `package.json` were not installed in `node_modules` (`tsx`, `@google/genai`,
`@supabase/*`, `@electric-sql/pglite`, `server-only`), so `npm test` could not start. I ran
`npm install --no-save --no-package-lock --ignore-scripts` to install them. This changed only `node_modules`; `package.json` and
`package-lock.json` are byte-identical to before (verified).

---

## 1. Executive summary

| Question | Answer |
|---|---|
| Does the merged app run end to end against the chain today? | **No.** The Track A chain SDK and Track B app are merged but **not connected**: nothing in `app/`, `components/`, `hooks/`, `lib/backend`, `lib/frontend` or `lib/evidence` imports `lib/chain` (only `lib/auth/*` and `lib/backend/criteria.ts` use `viem`). |
| What works | Wallet sign-in (live), private evidence upload, Gemini evaluation + deterministic pass policy, Supabase persistence/RLS, the full **mock** workflow in the browser; and, separately, the whole RLUSD contract lifecycle through the SDK (live-tested in A6.6.4b with keystore signers). |
| What is missing | The three adapters that join them: **chain reader**, **evidence funding verifier**, **advance signer** are all "unavailable" stubs; the browser has **no wallet-transaction code**; no **receipt reconciliation** (`pending` → `paid`); the UI hard-codes a placeholder `DEMO` token. |
| Is the production build green? | **No (P0).** `npm run build` fails in the type-check step (see §5). |
| Is the RLUSD configuration correct? | **Yes.** `.env` selects `rlusd` on both server and browser, addresses match the manifest and the chain, reserve is 5 RLUSD, token not paused (§4). |
| Demo readiness | **Blocked** on P0-1 … P0-7 below. All are fixable without redeploying contracts. One needs your decision (evaluator key custody). |

---

## 2. Architecture as found

```
Browser (Next.js client)                                   Server (Next.js route handlers)                         External
-----------------------------------------------------      -------------------------------------------------      ------------------------
pages (app/(app)/*) ──► hooks/use-duely.tsx                app/api/*/route.ts (thin wrappers)
                         │  useRepository()                      │
                         ▼                                       ▼
              lib/frontend/create-repository.ts          lib/backend/handlers.ts  (origin → zod → session)
                 NEXT_PUBLIC_DATA_MODE                           │
              ┌──────────┴──────────┐                            ▼
   MockDuelyRepository      ApiDuelyRepository          services: invoices / evaluation / advances / evidence
   (localStorage ledger,    (fetch → /api/*) ───────────►        │  via PORTS (lib/backend/ports.ts)
    fully simulated)               │                            ├─ db        → Supabase (service role)  ✅ real, migrations 1–8 applied
                                   │                            ├─ objects   → Supabase Storage (private bucket `evidence`) ✅
   wallet: lib/auth/wallet-client  │                            ├─ evaluator → Gemini (DUELY_EVALUATOR_MODE=gemini) ✅ implemented
   (MetaMask personal_sign only)   │                            ├─ chain     → unavailableChainAdapter   ❌ STUB
                                   │                            ├─ signer    → unavailableSigner         ❌ STUB
                                   │                            └─ evidence funding verifier → noChainAdapter ❌ STUB
                                   ▼
        createInvoice / fundInvoice / approveInvoice /     lib/chain (Track A SDK, NOT imported by any of the above)
        disputeInvoice / depositReserve / getBalances  ──► ✅ reads, writes, lifecycle, pause, deployment selection (301 tests, live-tested)
        = throw NOT_IMPLEMENTED ("needs the blockchain")   ✅ InvoiceAdvance (RLUSD) 0x1B97…2792 and (dUSD) 0x328f…50E0 on chain 1449000
```

### Connection matrix

| Link | State | Evidence |
|---|---|---|
| UI → repository (mock/api switch) | ✅ works | `lib/frontend/create-repository.ts`; `.env` has `NEXT_PUBLIC_DATA_MODE=api` |
| UI → wallet sign-in → session | ✅ implemented, tests pass | `lib/auth/*`, `/api/auth/*`; live DB has 1 verified wallet |
| UI → create invoice | ❌ throws `NOT_IMPLEMENTED` | `api-repository.ts` `createInvoice()` |
| UI → fund / approve / dispute / deposit reserve | ❌ throw `NOT_IMPLEMENTED` | `api-repository.ts` |
| UI → balances / transaction history | ❌ `getBalances` throws; `listTransactions` returns `[]` | `api-repository.ts` |
| UI → evidence upload → Supabase Storage → `submissions` | ✅ works (2 rows exist live) | `lib/evidence/*` |
| API → AI evaluator → `evaluations` | ✅ implemented; 1 real Gemini row exists; text/markdown evidence only | `lib/ai/*`, `lib/backend/evaluation.ts` |
| AI result → deterministic pass policy | ✅ server-side `decidePassed` (score ≥ 80 and all mandatory) | `lib/backend/evaluation.ts` |
| API → register invoice (`POST /api/invoices`) | ⚠️ implemented but always `503` (chain stub) | `lib/backend/invoices.ts` |
| API → advance request → `approveAdvance` | ⚠️ implemented but always `503` (chain + signer stubs); signer port has the **wrong signature** | `lib/backend/advances.ts`, `ports.ts` |
| Receipt reconciliation (`pending`→`paid`) | ❌ not built (documented as follow-up) | `supabase/API.md` |
| SDK → smart contract | ✅ live-verified (two RLUSD settlements, A6.6.4b) | `docs/CHAIN_SDK_HANDOFF.md` |
| Supabase → chain state sync | ❌ none; `onchain_status` is only a cache | `invoices.chain_synced_at` never written |

---

## 3. Incompatible interfaces and data models

| # | Where | Track B / frontend says | Contract / SDK says | Impact |
|---|---|---|---|---|
| I1 | Signer port `AdvanceSigner.submitApproveAdvance(ref)` | one arg | `approveAdvance(invoiceId, evaluationHash)` (CONTRACT_SPEC v1.1) | cannot be implemented as specified; an `evaluationHash` derivation is needed and persisted |
| I2 | Hash field | `criteriaHash` (UI, ports, DB column `criteria_hash`) | `metadataHash` (contract arg, `InvoiceCreated` event, SDK) | adapter must map; `computeCriteriaHash` must be what the client passes as `metadataHash` |
| I3 | Criteria hash source | `lib/backend/criteria.ts` (**PROPOSED** encoding); frontend `criteria-digest.ts` is a **mock-only placeholder** | one shared Keccak-256 encoding required (CLAUDE.md §6) | the browser must compute the *backend* hash before `createInvoice`, otherwise registration fails `CRITERIA_HASH_MISMATCH` |
| I4 | Invoice status enum | `Created, Funded, Advanced, Disputed, Settled` | `Created, Funded, Advanced, Settled, Disputed, Cancelled` | `Cancelled` missing in `domain.ts`, `ports.ts`, the DB check on `invoices.onchain_status`, and `checkOnchainEligibility` switch |
| I5 | Function/action names | `approveWork`, `disputeInvoice` (UI `TxAction`, DB check on `transactions.action`) | `approveCompletion`, `raiseDispute`, plus `cancelInvoice`, `resolveDispute`, `withdrawReserve` | DB check constraint would reject real actions; add/rename via migration |
| I6 | Token | `DEMO_TOKEN` = symbol `DEMO`, 18 decimals, hard-coded (`lib/frontend/token.ts`) used by 13 files | `paymentTokenInfo` (RLUSD, 18, `isDemoToken:false`; dUSD, 6, `true`) | right precision for RLUSD by accident; **wrong symbol/copy** ("DEMO tokens aren't RLUSD") and **wrong for the dUSD fallback** (6 decimals) |
| I7 | Advance math | `lib/backend/advances.ts` and `token.ts` re-implement `*90/100` | SDK `advanceAmountFor` (`*9000/10000`) | equal today; duplicated source of truth |
| I8 | Dispute semantics in UI copy | "nothing is refunded automatically", "manual resolution" (`app/(app)/page.tsx`, platform page) | `resolveDispute(id, releaseToFreelancer)` by the operator; `false` refunds the client's escrow; advance never clawed back | copy contradicts the contract; **no operator dispute-resolution UI/endpoint exists** |
| I9 | Public invoice identifier | UI routes by **on-chain id**; backend resolves it "among the caller's invoices" | on-chain ids repeat per deployment (RLUSD #1/#2 and dUSD #1 all exist) | `AMBIGUOUS_INVOICE` if one wallet pair holds both; list/detail do **not** filter by active deployment, so dUSD rows would render with RLUSD formatting |
| I10 | Two extra chain ports | `ChainFundingVerifier` in `lib/evidence/server.ts` (`noChainAdapter`) in addition to `ChainAdapter` | one SDK | two stubs to wire; with no adapter, evidence funding falls back to the **cached DB status** unless `EVIDENCE_REQUIRE_CHAIN_VERIFICATION=true` |
| I11 | AI provider | CLAUDE.md / IMPLEMENT_TRACK_B say **OpenAI** | code uses **Gemini** (`@google/genai`, `GEMINI_*`); `OPENAI_API_KEY` unused | doc drift only |
| I12 | `lib/shared/types.ts` | CLAUDE.md §3/§6 say the integration owner publishes it | does not exist; `lib/frontend/domain.ts` mirrors §6 (and is already stale vs I4) | no single shared type source |

---

## 4. RLUSD deployment configuration (verified read-only)

`.env` (names only; secrets not shown):

| Variable | Value | Check |
|---|---|---|
| `DUELY_DEPLOYMENT` / `NEXT_PUBLIC_DUELY_DEPLOYMENT` | `rlusd` / `rlusd` | ✅ agree (server = browser) |
| `NEXT_PUBLIC_XRPL_EVM_CHAIN_ID`, `CHAIN_ID` | `1449000` | ✅ |
| `NEXT_PUBLIC_CONTRACT_ADDRESS`, `CONTRACT_ADDRESS` | `0x1B972ec6B1B5E0b592010e7484beF0accC382792` | ✅ matches `xrpl-evm-testnet-rlusd.json` and on-chain |
| `NEXT_PUBLIC_TOKEN_ADDRESS`, `TOKEN_ADDRESS` | `0x27b57a9D0b8d24EB97259c4E2279e45255e016f3` | ✅ matches `InvoiceAdvance.paymentToken()` |
| `XRPL_EVM_RPC_URL` | authenticated provider URL (set, hidden) | ✅ server-only, not `NEXT_PUBLIC_*` |
| `NEXT_PUBLIC_XRPL_EVM_RPC_URL` | public RPC | ✅ |
| `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY` | set | ✅ service key not exposed to the browser |
| `GEMINI_API_KEY`, `GEMINI_EVALUATION_MODEL`, `DUELY_EVALUATOR_MODE=gemini` | set | ✅ real evaluator enabled |
| `EVALUATOR_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY`, `CLIENT_PRIVATE_KEY`, `DEPLOYER_PRIVATE_KEY` | **empty** | ⚠️ the A7 signer has no key (P0-5) |
| `NEXT_PUBLIC_DATA_MODE` | `api` | ✅ live mode; the write paths it needs do not exist yet |
| `EVIDENCE_REQUIRE_CHAIN_VERIFICATION` | unset (and absent from `.env.example`) | ⚠️ funding gate falls back to DB cache |

SDK resolution under this `.env` (Node, `--env-file=.env`): active deployment `rlusd`, token `RLUSD` / 18 decimals / `isDemoToken:false`,
`getChainEnvIssues()` = `[]`. On-chain (read-only): reserve **5 RLUSD**, escrow 0, contract balance 5 RLUSD, solvent, `nextInvoiceId` 3
(invoices #1, #2 settled in A6.6.4b), token `paused() = false`, operator/evaluator roles confirmed.
No dUSD address is used under RLUSD selection. `.env.example` keeps both deployments documented and the dUSD fallback is intact
(`DUELY_DEPLOYMENT` unset ⇒ dUSD). No private key is exposed through any `NEXT_PUBLIC_*` variable.
Note: `INTEGRATION_PLAN.md` lists `XRPL_EVM_RPC_URL=https://rpc.testnet.xrplevm.org`; the real value is an authenticated provider URL,
which is preferable and should stay.

**Supabase (read-only, service role, nothing printed):** tables `invoices, invoice_criteria, submissions, evaluations, advance_requests,
transactions, user_wallets, wallet_challenges` exist; PostgREST exposes `register_invoice`, `create_wallet_challenge`,
`consume_wallet_challenge`, `find_verified_wallet_owner`, `bind_verified_wallet` ⇒ **migrations 1–8 are applied** (Track B docs saying
"4–8 not applied" are stale). Bucket `evidence` exists and is **private**. Data: 1 invoice (a `chain_id = 0` **dev test fixture**, not an
on-chain invoice), 1 verified wallet, 2 submissions, 1 evaluation (real Gemini result, score 0, `simulated:false`), 0 advance requests,
0 transactions. No real on-chain invoice is registered yet.

---

## 5. Baseline test results (no code modified)

| Suite | Command | Result |
|---|---|---|
| Foundry | `cd contracts && forge test` | **81 passed**, 0 failed (8 suites) |
| Chain SDK + scripts | `npm run test:chain` | **301 passed**, 0 failed |
| Track B backend/auth/evidence/AI | `npm test` (after installing missing deps) | **286 passed**, 0 failed, 0 skipped (49 suites) |
| ESLint (project source) | `npx eslint app components hooks lib scripts tests proxy.ts` | **0 problems** |
| ESLint (as scripted) | `npm run lint` | ❌ 1,435 problems (1,142 errors) — it lints vendored `contracts/lib/**` (OpenZeppelin tests); P1 |
| TypeScript | `npm run typecheck` / `npx tsc --noEmit` | ❌ **8** × `TS2688` (was 9 before the dependency install) |
| TypeScript, stray types excluded | `npx tsc --noEmit --types node` | ❌ **3 real errors**, all in test files (below) |
| Production build | `npm run build` | ❌ **fails at "Running TypeScript"** (same TS2688 errors; compile step itself succeeded in 4.4 s) |
| Lockfile | `npm ci` | ❌ fails: `package-lock.json` is out of sync (missing `viem@2.57.11`, `web-streams-polyfill@3.3.3`) |
| Live dUSD read-only | `CHAIN_LIVE=1 … reads.live.test.ts` | 18/18 pass (last run A6.6.4; unaffected by the merge) |

Root causes:
* **TS2688** — `tsconfig.json` has no `compilerOptions.types`, so TypeScript auto-loads every `@types/*` it can see **including
  ancestor directories**. `/Users/caedylee/node_modules/@types/{connect,debug,diff-match-patch,lodash,ms,trusted-types,uuid,ws}`
  (a stray pnpm install in the home directory) are empty stubs. Machine-specific, but the config is fragile and breaks the build here.
* **3 real type errors** (hidden behind TS2688): `spawnSync(…, { env: { PATH, … } })` is rejected because Next's type augmentation makes
  `NODE_ENV` required in `ProcessEnv`: `scripts/chain-integration.test.ts:29`, `:234`, and `lib/chain/deployments.test.ts:185`
  (the last one is mine from A6.6.4a; my earlier scoped `tsc` used a tsconfig without the Next types, so it missed it).
* **Not run / unverified:** no browser walkthrough, no MetaMask, no `next dev` smoke, no live Gemini call (cost/credentials), no live
  Supabase write. Track B's own docs state the same ("Not tested: real browser with MetaMask; any live Supabase call").

---

## 6. Financial correctness (contract vs UI)

Verified by the 81 Foundry tests, the SDK suites and the A6.6.4b live runs (not by this audit's UI, which cannot transact yet):
* 100 RLUSD invoice → client escrow 100 → advance `floor(100 × 9000 / 10000)` = 90 from the **reserve** → on `approveCompletion` 90 is
  reclassified escrow→reserve, 10 paid to the freelancer; settlement without an advance pays the full invoice. Live: 1 RLUSD invoices, 0.9 advance, reserve restored to 5.
* Dispute: `raiseDispute` (client; Funded/Advanced) freezes; `resolveDispute(id, releaseToFreelancer)` by the operator — `true` settles,
  `false` refunds the full escrow to the client; an already-paid advance is **never clawed back** (`unrecoveredAdvance` is a reserve loss).
* Decimals: the contract is decimals-agnostic; RLUSD = 18. Backend uses `bigint` and decimal strings. The **UI** uses a hard-coded 18
  (correct for RLUSD, wrong for the dUSD fallback — I6).
* Backend guards already present: only the invoice's freelancer; latest submission only; evaluation must be real (non-simulated), pass, and match the invoice's criteria hash; one live advance per invoice (DB unique + idempotency key); on-chain status/amount/reserve re-checked before signing.
* MVP limits to state honestly: no LP vault; operator resolves disputes manually; RLUSD is issuer-controlled (pause/clawback/upgrade);
  Gemini reads text/markdown evidence only (PDF/image evidence returns 422 "needs manual review").

---

## 7. Findings by priority

### P0 — blocks the demo
| ID | Finding | Evidence |
|---|---|---|
| P0-1 | `npm run build` fails (TS2688 + 3 real test-file type errors) | §5 |
| P0-2 | `package-lock.json` out of sync (`npm ci` fails); fresh installs are not reproducible | §5 |
| P0-3 | **No chain adapter**: invoice registration and advances always 503; `GET` never verifies chain state | `getChainAdapter()` returns the stub; no code maps `InvoiceCreated`/`getInvoice`/reserve to the port |
| P0-4 | **No evidence funding verifier** wired (`getChainVerifier()` stub) | `lib/evidence/server.ts` |
| P0-5 | **No advance signer** and the signer port lacks `evaluationHash`; **evaluator key custody undecided** (`EVALUATOR_PRIVATE_KEY` empty; the only evaluator key is a Foundry keystore needing a password) | `ports.ts`, `.env` |
| P0-6 | **No browser wallet transaction layer**: create invoice, ERC-20 approve, fund, approve completion, dispute and operator reserve deposit all throw `NOT_IMPLEMENTED`; no chain add/switch to 1449000 | `api-repository.ts`, `wallet-client.ts` |
| P0-7 | **No receipt reconciliation**: an advance can only ever stay `pending`; transactions are never marked confirmed/failed in Supabase | `supabase/API.md` |
| P0-8 | Frontend hash ≠ backend hash (`criteria-digest.ts` mock vs `criteria.ts`): a client-created invoice could never register | I3 |
| P0-9 | Hard-coded `DEMO` token (symbol/labels/6-vs-18 decimals) | I6 |

### P1 — important, a workaround exists
| ID | Finding |
|---|---|
| P1-1 | DB/domain enum and action names stale (`Cancelled`; `approveWork`/`disputeInvoice` vs `approveCompletion`/`raiseDispute`; missing `cancelInvoice`, `resolveDispute`, `withdrawReserve`, `depositReserve` confirmations) — needs a migration (I4, I5) |
| P1-2 | Invoice list/detail not filtered by active deployment (chain id + contract); on-chain id ambiguity across deployments (I9) |
| P1-3 | No operator dispute-resolution endpoint/UI; UI copy contradicts the contract (I8) |
| P1-4 | `EVIDENCE_REQUIRE_CHAIN_VERIFICATION` not set/documented; funding falls back to the DB cache (I10) |
| P1-5 | `npm run lint` lints vendored `contracts/lib` (1,435 problems); needs an ignore |
| P1-6 | Evaluator reads text/markdown only: demo evidence must be `.txt`/`.md` |
| P1-7 | Chain activity, timeline and balances show nothing in live mode (`listTransactions` → `[]`, `getBalances` throws) |
| P1-8 | Duplicate sources of truth (advance math, `Address` types); `lib/shared/types.ts` absent (I7, I12) |
| P1-9 | Demo wallets: the freelancer address `0x0237…67F4` has no Foundry keystore; client/operator keys are in keystores, not MetaMask. The walkthrough needs MetaMask accounts for client, freelancer and operator (see §9) |

### P2 — post-hackathon
Track B docs stale (migrations "not applied", test counts); CLAUDE.md says OpenAI (code uses Gemini); `*_PRIVATE_KEY` placeholders in `.env.example`
contradict the keystore policy; Gemini retries/timeouts/cost controls; multi-tenant public identifier redesign; chain-indexed history
instead of per-request reads; browser E2E (Playwright) suite; production RLUSD issuer-risk mitigation; `turbopack.root` warning
(stray `pnpm-lock.yaml` in `~`).

---

## 8. Recommended implementation order (Phases 2–5)

Principle: smallest dependency-ordered steps, each leaving tests green; reuse `lib/chain`, change Track B only at its ports.

### Phase 2 — Foundations: green build, one config, aligned types (no behaviour change)
1. `tsconfig.json`: add `compilerOptions.types` (e.g. `["node"]`); fix the 3 test-file errors: `scripts/chain-integration.test.ts` (L29, L234), `lib/chain/deployments.test.ts` (L185). Regenerate `package-lock.json` via `npm install` (P0-1, P0-2). `eslint.config.mjs`: ignore `contracts/**` (P1-5).
2. New `lib/chain/index` consumers only: replace `lib/frontend/token.ts` internals with `paymentTokenInfo`/`formatTokenUnits` (symbol, decimals, `isDemoToken`); update the 13 consumers' copy (`components/duely/primitives.tsx`, `invoice-parts.tsx`, `app-shell.tsx`, `app/(app)/{page,client/page,client/invoices/new,freelancer/page,platform}/page.tsx`) and `lib/mocks/*` only where they import the old constants (P0-9, I6).
3. `lib/frontend/domain.ts`: add `Cancelled`, rename action names; add `lib/shared/types.ts` (re-export, per CLAUDE.md) (I4, I12).
4. New migration `supabase/migrations/20261025000009_dual_token_alignment.sql`: extend `invoices.onchain_status` and `transactions.action` checks; add an index/filter helper on `(chain_id, contract_address)`; **no data reset**. Update `lib/supabase/database.types.ts`, `tests/helpers/*`.
5. `lib/backend/server.ts` / `ports.ts`: filter list/detail by the active deployment (P1-2). `.env.example`: add `EVIDENCE_REQUIRE_CHAIN_VERIFICATION`, evaluator-key variable, and deployment notes.

### Phase 3 — Backend ↔ chain (server only)
1. New `lib/backend/chain-adapter.ts` (`server-only`): implements `ChainAdapter` with `lib/chain/server.ts` + `reads.ts` (`getInvoiceCreation` = receipt + `decodeInvoiceAdvanceEvents`; `getInvoiceState` = `getInvoice`; reserve = `getAvailableReserve`); maps `metadataHash`→`criteriaHash`; rejects any contract/token not equal to the active deployment (P0-3, I2).
2. `lib/evidence/server.ts`: `getChainVerifier()` backed by the same reader; set `EVIDENCE_REQUIRE_CHAIN_VERIFICATION=true` in the demo env (P0-4, P1-4).
3. `lib/backend/ports.ts` + new `lib/backend/advance-signer.ts` (`server-only`): `submitApproveAdvance(ref, evaluationHash)`; evaluator `Account` from a server-only secret; uses SDK `approveAdvance`, `submissionGuard`, `trackTransaction`; never retries; derive `evaluationHash = keccak256(evaluationId ‖ submissionId ‖ criteriaHash ‖ score)` and store it. **Needs your decision on key custody** (P0-5).
4. `lib/backend/advances.ts`: use the SDK's `advanceAmountFor`; pass `evaluationHash`; handle `Cancelled`; keep all existing eligibility checks.
5. New `lib/backend/reconcile.ts` + route `app/api/advances/[id]/route.ts` (and on-read refresh in `getInvoiceDetail`): confirm via `trackTransaction`; extend `BackendDb` (`confirmAdvance`, `failAdvance`, `markTransaction`) in `ports.ts`, `server.ts`, `tests/helpers/pg-store.ts`; write `transactions` rows with block/receipt data; `paid` only after the confirmed `AdvancePaid` event (P0-7).
6. Add `POST /api/disputes/:id/resolve` (operator only) only if you want the dispute path in the demo (P1-3); otherwise keep the operator resolution as a documented script.
7. Tests: new `tests/chain-adapter.test.ts`, `tests/advance-signer.test.ts`, extend `tests/backend-api.test.ts`, reusing `lib/chain/test/mock-chain.ts`.

### Phase 4 — Frontend ↔ wallet/chain
1. New `lib/frontend/wallet-chain.ts` (client): EIP-1193 provider, `wallet_switchEthereumChain`/`wallet_addEthereumChain` for 1449000, SDK `createWalletClientFromProvider`.
2. `lib/frontend/criteria-digest.ts` → use the single backend hash module (move the canonical encoder to `lib/shared/criteria.ts`, imported by both) (P0-8, I3).
3. `lib/frontend/api-repository.ts`: implement `createInvoice` (hash → `createInvoice` tx → `trackTransaction` → `POST /api/invoices`), `fundInvoice` (exact allowance → `fundInvoice`), `approveInvoice` (`approveCompletion`), `disputeInvoice` (`raiseDispute`), `depositReserve` (operator wallet), `getBalances`, `listTransactions`; show `pending` until `confirmed`; map `ChainWriteError` codes to `DomainError`. `lib/frontend/api-mappers.ts`: escrow/received/reserve figures from the verified chain block (P0-6, P1-7).
4. UI: `app/(app)/client/invoices/new/page.tsx`, `client/invoices/[id]/page.tsx`, `freelancer/invoices/[id]/page.tsx`, `platform/page.tsx`, `activity/page.tsx`, `components/duely/invoice-parts.tsx`, `live-auth.tsx`: remove the "blocked" notices in live mode, add pending/confirmed states and `explorerTxUrl` links, fix dispute copy to match the contract (I8).
5. Tests: extend `tests/live-data.test.ts` (fetch shim + fake provider) for each wallet action.

### Phase 5 — End-to-end verification and docs
1. `tests/e2e-lifecycle.test.ts`: PGlite + SDK mock chain + fake evaluator through create → fund → submit → evaluate → advance → confirm → settle, plus dispute (refund) and duplicate/failed-tx cases.
2. Update `docs/INTEGRATION_REPORT.md` (final), `supabase/API.md`, `supabase/LIVE_MODE.md`, `CLAUDE.md` (Gemini, final endpoints), `docs/TRACK_B_A7_HANDOFF.md`; write the demo script.
3. With your explicit approval only: one live UI-driven RLUSD run with MetaMask (client, freelancer, operator accounts) and the real signer; record hashes. Browser flows stay "unverified" until then.

### Decisions needed from you before Phase 3/4
1. **Evaluator key custody** for the server signer: env-held private key for the demo (simplest), or keystore + password file.
2. **MetaMask accounts**: confirm you can import the client (`0x8d93…459E`), operator (`0x6e83…482E`) and a freelancer account (`0x0237…67F4` has no keystore) into MetaMask for the demo.
3. **Dispute scope**: include operator `resolveDispute` in the UI/API, or demo only raise-dispute + a documented operator script.
4. **Migration**: OK to add migration 9 (extends two check constraints; no data changes) to the live Supabase project.
5. **Hash standard**: confirm the Track B canonical criteria encoding (versioned `{id,text,mandatory}`, NFC, Keccak-256) becomes the frozen `metadataHash` rule.

---

## 9. Planned demo walkthrough (after Phases 2–4; today it cannot run)

| Step | Account | Action |
|---|---|---|
| 0 | operator `0x6e83…482E` | (done) reserve holds 5 RLUSD; top up via the Platform page if lower |
| 1 | client `0x8d93…459E` | connect + sign in; create a 1 RLUSD invoice with criteria for freelancer `0x0237…67F4` |
| 2 | client | approve exactly 1 RLUSD, fund escrow |
| 3 | freelancer `0x0237…67F4` | sign in; upload a `.txt`/`.md` deliverable; request evaluation (Gemini) |
| 4 | freelancer | request the advance → backend signer (evaluator `0x276a…5ECb`) → 0.9 RLUSD arrives after confirmation |
| 5 | client | approve completion → 0.1 RLUSD to freelancer, reserve restored to 5 |
| 6 | (second invoice) client | raise a dispute; operator resolves with refund; advance is not clawed back |

---

## 10. What this audit did *not* verify
No browser/MetaMask run, no `next dev`/`next start` smoke test, no live Gemini call, no live Supabase write, no live transaction.
The build could not be completed past type-checking, so runtime bundling of `lib/chain` in the client is **unverified**.
Existing RLUSD transaction reports are regression evidence for the contract and SDK only; they say nothing about the integrated frontend.
