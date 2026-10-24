# Paste into Claude Code at the Duely repository root

You are my senior full-stack engineer implementing the Duely **Product + AI MVP**. Work sequentially across **frontend → persistent database/storage → authenticated API → AI evaluation → wallet/contract integration → demo hardening**. Start with a completely clickable product powered by deterministic **mock data** so frontend work is never blocked by Supabase or XRPL deployment.

## Read first; do not assume repo shape

1. Read the repository-root `CLAUDE.md` in full. Also follow `.claude/rules/frontend.md` whenever modifying UI files. The root team contract is authoritative for product behavior, shared types, API/ABI constraints, and financial rules.
3. This is a **single Next.js repository, not a monorepo**. If Next.js does not exist anywhere, report the gap and scaffold one app **at the agreed root**, without overwriting existing project or teammates' files. If an app exists nested inside a legitimate project structure, explain it and preserve it until ownership is clear.
4. Respect ownership: I am handling **frontend/UX and backend/AI work** sequentially, which the team contract calls Tracks C and B. **Do not modify Track A Solidity, deployment scripts, contract ABI, or on-chain state machine.** `lib/shared`, `lib/chain`, the env template, and cross-track contract schemas belong to the integration owner; inspect and propose changes but do not silently break them.
5. First report a concise repository audit: actual app root, commands that exist, what is implemented, dependencies/credentials missing, files you intend to touch, and interface blockers. Then implement the unblocked phases, without repeated requests for permission. If a credential or confirmed ABI is unavailable, **use a clearly labeled mock adapter** and continue with the rest. Make no assertions about deploying or executing real transactions without verification.

## Non-negotiable product semantics

- Client defines an invoice with full acceptance criteria and escrows the **full amount** in an ERC-20 **demo token** on XRPL **EVM** testnet. The criteria have a canonical representation and an on-chain criteria hash (once the integration owner finalizes hashing).
- Platform maintains a **separate prefunded reserve**. After evidence submission, an AI evaluation must **pass**, then the **freelancer must explicitly request** an advance. A protected signer/contract workflow pays exactly `floor(invoice base units * 90 / 100)` **from reserve**, never from escrow.
- After client approval, escrow credits the reserve for the amount actually advanced and pays the remaining escrow to the freelancer. With no advance, escrow pays freelancer 100%.
- Dispute before settlement freezes normal settlement. It does not claw back an advance; never simulate an automatic resolution or refund.
- The AI recommendation is not a signature or final arbitration. `Submitted` / `Evaluated` are off-chain metadata; monetary status is read from contract/receipts. Use decimal strings / `bigint`, not floats, for token math. Never advertise demo tokens as RLUSD or real dollars.

## Execution order and gates

### PHASE 0 — Audit, setup, interfaces

- Inventory files and identify the actual package root. Repair straightforward setup issues without destructive refactors.
- Confirm dependencies already present: Next.js App Router, TypeScript, Tailwind / shadcn or Base UI, Supabase, Zod, wagmi/viem, OpenAI. Install only what a concrete subsequent phase needs; use the existing package manager and lockfile.
- Write a short implementation checklist in your response; don't generate an elaborate planning bureaucracy. Identify **proposed** data shapes/routes consistent with root `CLAUDE.md`. If shared interfaces have not been frozen, isolate them behind adapters rather than editing integration-owned contracts.

**Gate:** the app starts (or blockers are precisely documented) and the next phase can proceed.

### PHASE 1 — Frontend FIRST, with mocks; no external credentials

Build a polished, responsive, usable UI with these complete experiences:

- Welcome/onboarding with demo role switch (client / freelancer), visible simulated/demo status and wallet placeholder.
- Client dashboard with overview, invoice list, status labels, invoice details, and create invoice form with ordered acceptance criteria.
- Freelancer dashboard with assigned invoices, invoice detail, evidence upload flow and latest evaluation.
- Evaluation screen showing 0–100 score, criterion-level results and explanations, recommendation, and eligibility.
- Freelancer's **separate explicit advance request** with calculated 90%, pending/success/failure/denied states.
- Client approval / dispute views, comprehensible payment lifecycle timeline, and transaction history (real links only for confirmed real chain transactions).

Architecture: pages/components → typed **repository/service interface** → `MockDuelyRepository` now; `ApiDuelyRepository` later. Build one mock data configuration switch, `NEXT_PUBLIC_DATA_MODE=mock|api`, with local mock the default until external services are configured. Do **not** import static fixtures directly in pages. Create deterministic fixtures and a mock state store persisted across browser refresh (with safe hydration) and a Reset Demo control. Make it possible for one browser to toggle **demo actors** without implying this authorizes real backend actions.

Scenarios must include: (A) 1,000 demo-token invoice; reserve prefunded at least 900; freelancer submits evidence → simulated AI pass → **freelancer requests** 900 advance → client approves → 900 escrow credit to reserve + remaining 100 paid to freelancer; (B) dispute freezes settlement and never retracts a paid advance; (C) client approves without any advance → full 1,000 to freelancer; (D) AI fails or reserve is insufficient, so advance CTA is disabled with an explanation. Model financial status and off-chain submission separately. Keep a mock data banner; **no fake real tx hashes or claims of on-chain settlement**.

**Gate:** every listed page and CTA works and updates the mock state, persists across refresh and back navigation, and builds before work on Supabase starts.

### PHASE 2 — Supabase Postgres, Storage, and auth foundations

Create **versioned SQL migrations** and Supabase integration, preserving any existing schema. Tables should cover at minimum:

- `wallet_accounts` / verified wallet-to-user associations (or carefully reuse an existing auth model);
- `invoices` (invoice ID, client and freelancer wallet, base-unit amount, criteria hash, frozen ordered criteria, description, chain ID/address metadata, timestamps);
- `submissions` (invoice reference, freelancer identity, storage object path, metadata, created time);
- `evaluations` (submission, invoice, criteria hash/version, model/prompt version, integer score, overall pass, criterion results, rationale, timestamp);
- `advance_requests` (invoice, requester, idempotency/eligibility status, transaction reference, timestamp);
- `transactions` / payment events (invoice, chain ID, hash, action, pending/confirmed/failed, receipt metadata).

Add appropriate foreign keys, indexes, unique constraints for duplicate advance attempts, timestamps, **RLS policies**, private evidence bucket, ownership checks and server-only storage access patterns. Do **not** trust supplied wallet addresses; require a verified session-to-wallet binding (signed challenge or existing secure auth binding), especially for all protected writes. Keep secrets and Supabase service-role keys out of the browser. Never persist an unconfirmed transaction as settled.

Create typed browser/server Supabase clients only where needed. Document env variable **names** in the env template via integration-owner coordination; don't invent actual credentials. Add and verify a small seed/test fixture path that does not leak into production, plus steps for migration execution.

**Gate:** when configured, invoice/submission/evaluation metadata and private evidence objects can persist and be loaded after refresh under correct authorization. If no credentials are available, migrations and clients compile, and remote verification is marked blocked—not falsely passed.

### PHASE 3 — Authenticated backend HTTP APIs

Implement Next.js App Router route handlers with Zod, documented JSON errors `{ error: { code, message } }`, owner/role checks, stable return types, and state reconciliation:

| Endpoint | Request | Contract/authorization behavior |
| --- | --- | --- |
| `POST /api/invoices` | `{ invoiceId, txHash, description, criteria }` | **Off-chain registration only** after verifying transaction and immutable on-chain criteria hash; do not create chain invoice here |
| `GET /api/invoices/:id` | invoice ID | Authorized invoice metadata + relevant submissions/evaluations + verified chain snapshot if chain available |
| `POST /api/submissions` | `{ invoiceId, storagePath }` | Verify authenticated freelancer, evidence object ownership, funded/eligible invoice |
| `POST /api/evaluate` | `{ submissionId }` | Server retrieves frozen criteria/evidence, evaluates, persists and returns server-generated result |
| `POST /api/advances` | `{ invoiceId }` | Verify explicit registered freelancer request, newest passing eligible evaluation, sufficient reserve and allowed chain state; return `requestId`, status, optional confirmed/submitted txHash |

You may add an **authorized upload-init/signed-upload endpoint** and a **read/list endpoint** only when the UI requires them; document additions before coding. Never weaken a protected API so a demo role switch can pass as auth. Keep mock mode completely separate from production API security. Ensure idempotency/concurrent-request protection.

**Gate:** API integration tests cover invalid requests, wrong wallet/session, wrong invoice owner, wrong storage path, old passing evaluation, duplicates, unfunded/disputed/settled cases, and consistent error shapes.

### PHASE 4 — OpenAI structured evaluation

Implement server-only OpenAI evaluation returning a validated structured result compatible with the shared `EvaluationResult`. Compare submitted evidence **only against the frozen criteria**. Save criterion pass/fail + reason, integer score, rationale, overall pass and evaluation metadata. Use an explicit, documented demo pass policy (propose `score >= 80` **and** all mandatory criteria passed; flag to team for confirmation) enforced **on the server**, not trusted from the client/model. The signer is not given an AI key, and AI is not given signing keys.

Keep a deterministic test-only evaluator behind an explicit mock/test injection seam, never silently replace a failed real OpenAI request with a pass. Ensure evaluation failure is visible, retriable, and not authorize an advance.

**Gate:** UI can display a real persisted result when configured; mocked and live evaluations are visibly distinguishable.

### PHASE 5 — Wallet + verified on-chain adapter

Integrate MetaMask via the project's wagmi/viem setup and **only team-confirmed** XRPL EVM testnet chain ID, contract address, token decimals, and compiled ABI. Add wrong-network and rejected-transaction feedback. Integrate typed chain reads and wallet writes for invoice creation, ERC-20 approval/funding, client approval/dispute, and a **server-authorized** advance signer flow. Use chain receipts/events for finality; show pending, confirmed, or failed without optimistic financial success. Track A/integration owner supplies contract artifacts; do not guess them or modify Solidity.

Keep the mock adapter usable as a fallback demo environment if the chain is unavailable, but never misrepresent mock settlement as real payment.

**Gate:** report real deployed/tested wallet-to-contract-to-backend execution **only when actually observed**. Otherwise list exactly which external artifacts are needed.

### PHASE 6 — Demo readiness and verification

- Add onboarding text, payment-flow visual timeline, realistic empty/loading/retry/disabled states, appropriate labels, accessible controls, mobile responsiveness, and clear demo-token disclosures.
- Run root `npm run build`, `npx tsc --noEmit`, lint/tests if available, and record actual outputs. Run route/security tests. Add a lightweight UI smoke/e2e test **if testing tools already exist**, else provide a reproducible manual script.
- Rehearse three flows: 90% advance and remaining 10% settlement; dispute freeze; settlement without advance.
- Provide a final handoff: changed files, route map, DB migrations, API request/response shapes, how to run **mock mode**, how to switch to live mode, `.env.example` variable names, commands executed, passing/failing checks, and exact chain/credential integration blockers.

## Engineering constraints and collaboration

- Do not alter, discard, or rebase teammates' work; do not force push. Make the smallest coherent changes and respect package roots and current structure.
- All blockchain-derived IDs/amounts in JSON must be strings; deterministic acceptance-criteria serialization/hashing must follow the integration owner's frozen standard, not unstable JSON stringify.
- Reuse existing stack and primitives rather than installing many packages. Keep protected logic in server-only modules.
- Do not fabricate test results, chain addresses, ABIs, receipts, transaction hashes, successful funding, reserve deposits, or OpenAI calls.
- Don't pause at a planning-only response. After auditing, implement the unblocked phases in order. Give a concise status after each phase showing exactly what was completed and tested, and use mocks to move forward when external integrations are blocked.

**Start now with repository discovery and PHASE 1.**
