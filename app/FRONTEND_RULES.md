---
paths:
  - "app/**/*.tsx"
  - "components/**/*"
  - "hooks/**/*"
  - "lib/mocks/**/*"
  - "lib/frontend/**/*"
---

# Duely frontend rules — product/UX implementation

These rules supplement the repository-root `CLAUDE.md`. The root team contract wins if anything here is unclear. The scope is **UI files and UI-facing adapters**; do not apply these instructions to `app/api/**`, Solidity, privileged server code, or compiled ABI generation.

## Your mission

Build a convincing, complete **client ↔ freelancer** product flow for Duely's XRPL **EVM** hackathon MVP. **Build and test with deterministic mocks before relying on Supabase, AI, wallets, or deployed contracts.** A judge must be able to click from invoice creation through evidence review and final payment outcome with no blockchain connection in mock mode.

The product is **escrow-backed early payment**: a client escrows the whole invoice; after an AI pass and a **separate explicit freelancer advance request**, a platform-prefunded reserve advances 90%; when client approves, escrow credits the reserve for the amount actually advanced and pays the remainder to the freelancer. The AI **recommends**; it never signs transactions. A dispute freezes normal settlement; never promise automatic refunds, arbitration, or advance clawback.

## UI stack and conventions

- Use the repository's existing **Next.js App Router, React, TypeScript**, Tailwind, and installed shadcn/Base UI component system. Inspect `package.json` and existing styles first; do not blindly add a new UI library, move folders, or create a monorepo.
- Favor server components for static layout and client components only for forms, wallet interactions, and interactive views.
- Make focused, typed, accessible, reusable components. Avoid giant pages; avoid building an abstract design system for a hackathon.
- Use a consistent visual language: modern fintech SaaS; legible numbers and labels, strong hierarchy, spacious layouts, responsive desktop/mobile, visible focus states, empty/loading/error/success states, and clear CTAs.
- Treat addresses, amounts, transaction hashes and chain statuses as domain data, not decorative strings. Format token units for display only; keep raw token amounts as **decimal strings** and convert using `bigint` and token decimals; never JS floats for monetary calculations.
- Follow root `CLAUDE.md` shared domain types if present. Do not redefine or silently change published types, route contracts, ABI, or criteria hashing. If shared types are not yet frozen, create **temporary mock-only types/adapters** and document the mapping needed, without modifying integration-owned files.

## Required clickable screens

Use the actual repo's routing conventions, but cover all these views:

1. **Welcome / role entry**: demo entry, client/freelancer navigation, wallet status and a prominent **Demo mode** indicator when mocks are active.
2. **Client dashboard**: invoice list; funded, pending, advanced, disputed and settled states; quick metrics drawn from real/mock repository data; create-invoice CTA.
3. **Create invoice**: freelancer wallet, clear description, demo token amount, ordered acceptance criteria with mandatory indicators, review step. Make criteria visibly immutable once committed; until chain integration, call creation/funding **simulated**.
4. **Client invoice detail**: agreed criteria, escrow state, submission/evaluation evidence, explicit approve/dispute actions, reserve and escrow settlement explanation, timeline.
5. **Freelancer dashboard**: assigned work, submission status, eligible advance opportunities, money received/remaining shown only as actual or labeled mock state.
6. **Freelancer invoice detail / evidence upload**: requirements, secure upload UI, file type/size guidance, preview and submission status.
7. **AI evaluation**: score 0–100, each criterion's pass/fail and reason, overall rationale, visible 'AI recommendation, not final arbiter' language, retry/review and failing results.
8. **Advance request**: user-initiated confirmation, exact 90% reserve advance in demo token units, reserve availability, disabled/denied eligibility reasons, transaction progress.
9. **Approval / dispute**: client approval result, non-advance settlement path, dispute-freeze explanation, transaction receipt links only when real chain hashes exist.

Keep global header/navigation and contextual account role consistent. The mock role switcher is demo-only and **must not authorize** anything when persistence/chain is live.

## Frontend data boundary: make mock → live switch easy

Pages and components **must not import fixture objects directly**. Put data access behind a small, typed **UI service/repository interface** (names and location may follow existing patterns) with methods conceptually equivalent to:

- `listInvoices(role, wallet)` / `getInvoice(invoiceId)` / `createInvoice(input)`
- `submitEvidence(input)` / `getEvaluation(submissionId)` / `requestEvaluation(submissionId)`
- `requestAdvance(invoiceId)` / `approveInvoice(invoiceId)` / `disputeInvoice(invoiceId)`
- `getTimeline(invoiceId)`

Provide a **mock adapter** first and a future **API adapter** exposing the same interface. Keep form/UI logic independent of whether data comes from memory/localStorage or API. Use `NEXT_PUBLIC_DATA_MODE=mock|api` (default `mock` only for local demo); read that value in one place, not across every component. Never let a public environment variable enable backend authorization bypass. In live mode all money-changing actions require authenticated, authorized backends/contracts.

### Mock-mode rules

- Seed deterministic **clearly fictional** invoices, wallets and demo-token balances. Include both a fresh client/freelancer happy path and failure states. Example: invoice 1,000 demo tokens; separate reserve ≥900; after an explicitly requested mock advance show 900 sent from reserve; on client approval show 900 escrow-to-reserve accounting credit and 100 to freelancer. A no-advance approval pays the full 1,000. A dispute blocks settlement and does **not** claw back the advance.
- Model **on-chain-like financial status** (`Created`, `Funded`, `Advanced`, `Disputed`, `Settled`) separately from **off-chain submission status** (`NotSubmitted`, `Submitted`, `Evaluated`). Derive CTA eligibility from both, not one overloaded status.
- Mock evaluation can be a deterministic fixture; label it **simulated AI evaluation**. Do not imply OpenAI was called.
- Mock wallet and transaction states must be labeled simulated. **Do not manufacture explorer-linked tx hashes or say funds moved on-chain**. Mock timeline entries must say simulated.
- Make interactions update shared state across screens, and persist mock state across refresh (e.g. via safe client-side localStorage hydration). Provide a **Reset demo** action that restores fixtures. Mock persistence is not an auth/security guarantee.
- Cover no submission, AI pass, AI fail, insufficient reserve, duplicate advance attempt, pending/failed simulated transaction, client dispute, and no-advance approval.
- Show skeleton/loading, useful error messages, toasts/confirmations, disabled buttons, and retries where appropriate. Do not hide failures behind happy-path UI.

## Integration requirements

- The endpoint contract is defined by root `CLAUDE.md` (`POST /api/invoices`, `GET /api/invoices/:id`, `POST /api/submissions`, `POST /api/evaluate`, `POST /api/advances`); use typed response adapters, not ad hoc shapes.
- For wallet actions, use existing wagmi/viem setup when available; require correct **XRPL EVM testnet** chain ID/config confirmed by the chain owner; never guess a testnet chain ID, contract address, or ABI. Clear wrong-network feedback.
- Advance eligibility needs **latest eligible server-generated passing evaluation + explicit request + verified chain state + reserve available**; the frontend may preview status but server/contract are authoritative.
- File uploads must ultimately use private Supabase Storage and verified ownership. Do not expose service-role tokens or secret keys in client modules.
- Display `pending` once a transaction is submitted, `confirmed` only on verified receipt/event, and `failed` on error. Do not set on-chain settled/advanced states optimistically.
- Use accessible labels and error descriptions; avoid color-only pass/fail indicators.

## UI verification / definition of done

- From the app's **actual** package root, run available TypeScript/build/lint scripts. If a dependency or command is missing, investigate and report it; don't claim a check ran.
- In **mock mode**, demo the entire sequence without a wallet or Supabase credentials: client creates invoice → funds (simulated) → freelancer uploads (mock) → receives AI evaluation (simulated) → freelancer requests advance → client approves → timeline shows the split settlement.
- Demonstrate dispute freeze and settlement without an advance as separate scenarios.
- Exercise refresh persistence, back navigation, responsive layouts, empty/error states, and role separation.
- After each meaningful implementation phase, report changed files, what clicks through, checks actually run, and integration blockers. Avoid scope creep beyond MVP.
