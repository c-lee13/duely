# CLAUDE.md — Duely | XRPL EVM Hackathon MVP

> **Team contract.** All coding agents must read this file before editing. This document defines the current MVP and cross-team interfaces, not the post-MVP roadmap. If actual repository files conflict with the suggested layout, inspect and preserve the existing project; do not reorganize without team approval.

## 1. Product goal and demo

Duely lets a client lock payment for freelance work, a freelancer submit evidence against criteria agreed in advance, and the platform evaluate the submission with AI. **After a passing evaluation AND an explicit freelancer request**, an authorized platform signer releases an advance equal to **90% of the invoice** from a separately **platform-prefunded reserve**. Client approval then settles the invoice: escrow reimburses the reserve for the amount actually advanced and pays the remaining escrow to the freelancer.

**Demo:** client escrows 1,000 mock payment tokens; platform has prefunded >=900 reserve tokens. Freelancer submits evidence; AI passes; freelancer requests an advance; reserve pays 900. Client approves; 900 of escrow is internally reallocated to reserve and 100 is transferred to freelancer. If client disputes before approval, ordinary settlement is frozen. The already paid advance is not clawed back; the platform bears its risk pending manual resolution.

**Important:** This is escrow-backed early payment financing, not financing an unfunded invoice. The client escrow and platform reserve are *separately accounted balances in one contract*. Escrow cannot fund advances before settlement.

## 2. Hard MVP boundaries

- XRPL **EVM** testnet, Solidity/Foundry/OpenZeppelin; **not** native XRPL Escrow.
- **One `InvoiceAdvance.sol` contract**, a simple ERC-20 demo token, and platform-funded reserve. **NO external LPs, ERC-4626 vault, lending protocol, yield distribution, or public depositors.**
- Two payment-token deployments exist on XRPL EVM testnet, each with its own immutable `InvoiceAdvance`, selected by `DUELY_DEPLOYMENT=dusd|rlusd` (default `dusd`): **dUSD** (mock, 6 decimals, labeled *demo token*) and **RLUSD** (the issuer's real testnet token, 18 decimals, live-tested end to end in A6.6.4b). Never label dUSD as RLUSD, and never label RLUSD a demo token. RLUSD is issuer-controlled (pause, clawback, upgrade); this is documented, not mitigated. Details: `docs/CHAIN_SDK_HANDOFF.md`, `docs/TRACK_B_A7_HANDOFF.md`.
- Next.js App Router + TypeScript + shadcn/Base UI, wagmi/viem, Supabase Postgres/Storage, OpenAI structured evaluation, MetaMask.
- No x402, LangGraph orchestration, Privy, Mastercard fiat integration, credit underwriting, or automated arbitration in MVP.
- AI returns a recommendation; it does not possess a signing key or directly call contracts. A protected backend validates eligibility and an authorized signer submits the transaction.
- Optimize for a complete, honest demo, not production claims.

## 3. Actual repository layout (single Next.js project, NOT a monorepo)

```text
/
├── CLAUDE.md
├── app/                      # Next.js routes and app/api/* handlers
├── components/               # UI
├── hooks/                    # UI hooks
├── lib/
│   ├── shared/               # types.ts, schemas.ts, constants.ts
│   ├── chain/                # ABI, addresses, client, typed adapters
│   ├── ai/                   # scoring service (server-only)
│   └── supabase/             # browser/server clients
├── contracts/
│   ├── src/InvoiceAdvance.sol
│   ├── test/
│   ├── script/
│   └── foundry.toml
├── public/
├── package.json
├── package-lock.json
└── .env.example
```

These are **target locations, not instructions to overwrite or relocate existing code**. The root is the directory containing `package.json`. Do not create `apps/web`, `packages/shared`, or another nested `duely/`. Check actual file locations before starting.

## 4. Ownership and delegation

| Track | Owns | Does not modify without agreement |
|---|---|---|
| A — Solidity / chain | `contracts/src`, `contracts/test`, deploy scripts, ABI export, contract state machine | API schemas, dashboards |
| B — Backend / AI | `app/api`, `lib/ai`, `lib/supabase`, database migrations, evaluation and advance orchestration | Contract signatures, frontend page contracts |
| C — Frontend / UX | `app/(client)`, `app/(freelancer)` or agreed actual route folders, `components`, `hooks` | Privileged API internals, contract ABI |
| Integration owner (can be one of A–C) | `lib/shared`, `lib/chain`, environment template, integration tests, end-to-end wiring | Must coordinate breaking changes with all tracks |

**First team action:** choose the integration owner and freeze the interface tables below. Agents work in separate branches; do not simultaneously edit shared interface files. Shared file changes require a brief proposal including old/new fields and affected consumers. Never force-push another track's branch.

## 5. Locked MVP workflow and state boundaries

1. Client connects wallet, creates an invoice with freelancer wallet, amount, description and explicit acceptance criteria. Full criteria live in Supabase; a deterministic `metadataHash` (commits to the full agreement, including criteria) is committed on-chain.
2. Client approves the ERC-20 spending allowance and calls `fundInvoice(invoiceId)` to lock the entire invoice amount in escrow.
3. Team/platform separately calls `depositReserve(amount)` using platform-funded demo tokens.
4. Freelancer connects the registered wallet and submits evidence; server stores private file and submission metadata in Supabase.
5. Backend reads immutable criteria, retrieves evidence securely, calls OpenAI, and stores the **server-generated** structured result. Passing rule is an explicit server policy, not an untrusted client boolean.
6. Freelancer explicitly requests the advance. Backend checks session-to-wallet binding, invoice ownership, latest eligible evaluation, funded/undisputed/unsettled chain state, no previous advance, and reserve availability. The `EVALUATOR_ROLE` platform signer calls `approveAdvance(invoiceId, evaluationHash)`.
7. Contract pays the freelancer exactly `floor(amount * 9000 / 10000)` token base units from the reserve. Backend marks success only after a confirmed receipt/event.
8. Client calls `approveCompletion(invoiceId)`. If an advance occurred, escrow **internally credits** the reserve by the advanced amount and transfers the remainder to freelancer. Without an advance, full escrow goes to freelancer.
9. If client calls `raiseDispute` before settlement, regular advance/settlement is frozen. The operator then calls `resolveDispute(invoiceId, releaseToFreelancer)`: `true` settles normally; `false` refunds the full escrow to the client. A prior advance is never clawed back; it remains an operator reserve loss (`unrecoveredAdvance` in `DisputeResolved`). A client may `cancelInvoice` only while `Created`.

**On-chain financial state** is authoritative. Off-chain `Submitted`/`Evaluated` are separate metadata, not on-chain statuses. Never infer financial finality from a database row or optimistic UI.

## 6. Shared TypeScript interface (integration owner publishes in `lib/shared/types.ts`)

```ts
export type Address = `0x${string}`;
export type Bytes32 = `0x${string}`;
export type InvoiceId = string;     // uint256 in decimal string form
export type TokenAmount = string;   // ERC-20 base units; NEVER floating point

export type OnchainInvoiceStatus =
  | 'Created' | 'Funded' | 'Advanced' | 'Settled' | 'Disputed' | 'Cancelled'; // enum order matches Solidity
export type SubmissionStatus = 'NotSubmitted' | 'Submitted' | 'Evaluated';

export interface InvoiceRecord {
  invoiceId: InvoiceId;
  client: Address;
  freelancer: Address;
  amount: TokenAmount;
  advanceAmount: TokenAmount; // actual amount advanced, 0 before advance
  metadataHash: Bytes32; // commits to the full invoice agreement incl. criteria
  onchainStatus: OnchainInvoiceStatus;
  submissionStatus: SubmissionStatus;
  description?: string;
}

export interface CriterionResult {
  criterion: string;
  passed: boolean;
  reason: string;
}
export interface EvaluationResult {
  invoiceId: InvoiceId;
  submissionId: string;
  score: number;             // integer 0..100
  passed: boolean;
  criteriaResults: CriterionResult[];
  summary: string;
}
```

**Hashing rule:** define one canonical criteria representation (e.g., a versioned ordered array of `{id, text}` entries, normalized UTF-8) and one shared Keccak-256 encoding algorithm. Frontend/backend/contract integration must produce the same bytes32; do not hash unstable arbitrary JSON. Criteria must not be edited after the invoice is created/funded; changes require a new invoice in MVP.

## 7. Solidity interface (authoritative source: `docs/CONTRACT_SPEC.md` v1.1; this section summarizes it)

```solidity
function createInvoice(address freelancer, uint256 amount, bytes32 metadataHash)
    external returns (uint256 invoiceId);
function cancelInvoice(uint256 invoiceId) external;   // client only; Created only
function fundInvoice(uint256 invoiceId) external;     // client only
function depositReserve(uint256 amount) external;     // OPERATOR_ROLE
function withdrawReserve(uint256 amount) external;    // OPERATOR_ROLE
function approveAdvance(uint256 invoiceId, bytes32 evaluationHash) external; // EVALUATOR_ROLE
function approveCompletion(uint256 invoiceId) external; // client only
function raiseDispute(uint256 invoiceId) external;      // client only; Funded/Advanced
function resolveDispute(uint256 invoiceId, bool releaseToFreelancer) external; // OPERATOR_ROLE
function getInvoice(uint256 invoiceId) external view returns (Invoice memory);
function availableReserve() external view returns (uint256);
```
Roles: `DEFAULT_ADMIN_ROLE`, `OPERATOR_ROLE` (reserve, dispute resolution), `EVALUATOR_ROLE` (backend signer, advances only). Enum: `Created, Funded, Advanced, Settled, Disputed, Cancelled`. Token: one immutable ERC-20 per deployment: dUSD (6-decimal demo token) or RLUSD (18 decimals); the contract is decimals-agnostic.

**Before coding consumers, freeze:** invoice struct/enum and getter tuple; event argument names/types/indexing; ERC-20 token address (single token, immutable for MVP); signer/role initialization; chain ID; and exact dispute conditions. Contract owner exports the *compiled* ABI to `lib/chain/generated/` and publishes deployed address/chain config. Do not hand-maintain an ABI that can diverge from compiled code.

Events (exact signatures in the spec §6): `InvoiceCreated`, `InvoiceFunded`, `InvoiceCancelled`, `ReserveDeposited`, `ReserveWithdrawn`, `AdvancePaid`, `InvoiceSettled`, `InvoiceDisputed`, `DisputeResolved`. Contract's `Advanced` state must still allow client approval/dispute. A settled invoice is terminal.

### Contract invariants (mandatory Foundry tests)

- Client escrow is segregated in accounting and cannot finance advances.
- Reserve can never be overdrawn; no double advances or double settlements.
- Client can fund only its invoice; only `EVALUATOR_ROLE` advances; only the recorded client approves/disputes.
- Advance is 90% in base units with floor rounding; settlement repays **actual** advance and pays remaining escrow.
- Settlement without advance pays the full invoice to freelancer.
- Disputed invoice cannot use ordinary settlement; advance cannot be triggered after dispute.
- Token transfers use SafeERC20 and non-reentrant, checks-effects-interactions-compatible accounting.
- Test reserve/escrow balance invariants before and after every transition, unauthorized callers, wrong statuses, duplicate requests, and insufficient funds.

## 8. HTTP API contract — draft freeze (Track B confirms)

All mutations require authenticated sessions, Zod input validation, verified wallet ownership/association, and server-side authorization. Database RLS is required. Never trust caller-provided score, address, amount, or passed flag.

| Endpoint | Input | Output / guarantee |
|---|---|---|
| `POST /api/invoices` | `{ invoiceId, txHash, description, criteria }` | Verify chain receipt, creator, and `metadataHash`; persist metadata; return `InvoiceRecord` |
| `GET /api/invoices/:id` | URL `invoiceId` | Return authorized invoice metadata + submissions/evaluations + verified chain snapshot |
| `POST /api/submissions` | `{ invoiceId, storagePath }` after authorized upload | Verify freelancer, file ownership, invoice eligibility; return `{ submissionId }` |
| `POST /api/evaluate` | `{ submissionId }` | Server retrieves immutable criteria and file; stores evaluation; returns `EvaluationResult` |
| `POST /api/advances` | `{ invoiceId }` | Verify explicit freelancer request + latest passing evaluation + chain eligibility; return `{ requestId, status, txHash? }` |

Use one documented JSON error shape: `{ error: { code: string, message: string } }`. Avoid multiple competing invoice write paths. `POST /api/invoices` is an off-chain registration after wallet transaction, **not** the on-chain invoice creator.

### Evaluation / advance policy

- For demo, use a fixed, documented pass rule (e.g., score >= 80 **and** every mandatory criterion passed). Team must agree on the exact threshold before implementation; it is **not** specified by the original product requirement.
- An evaluation must identify the invoice, submission, criteria hash/version, model and prompt version, and timestamp for auditability. Persist these as metadata even if omitted from the public response type.
- Backend checks the **latest eligible** evaluation and submission; do not allow an old passing evaluation to authorize a different submission.
- Use idempotency and DB locking for concurrent requests. Smart contract must independently reject duplicates.
- AI service never receives the signing key. Privileged signer only runs in a protected server-side transaction module; keys are never browser-exposed.
- After transaction submission, show `pending`; show `paid` only after chain receipt and event confirmation. On revert, do not claim success.

## 9. Security, money, and environment rules

- Use `bigint` in viem and decimal strings across JSON; do not use JS floating-point for token amounts.
- Never expose `OPENAI_API_KEY`, Supabase service-role credentials, or private signing keys via `NEXT_PUBLIC_*`.
- Use server-only modules for secrets. Do not commit `.env`, `.env.local`, wallets, keys, or real user data. Commit `.env.example` with **names only**.
- Supabase Storage should be private; verify access via auth/RLS and issue short-lived signed URLs as needed.
- Use contract reads and receipts/events for balances, invoice status and transaction finality; Supabase may cache indexed data.
- Demo tokens (dUSD) are not real dollars; all UI copy and demos must make that explicit. Read symbol, decimals and `isDemoToken` from `paymentTokenInfo`; never hard-code 6 decimals or the string "dUSD".
- Before real funds or external LPs: separate security, economic, legal and audit work is required. None of that is claimed by this MVP.

## 10. Parallel development protocol

1. **At start:** read this file, inspect existing code, identify track, branch, files to edit, and any blocked interfaces.
2. **Before implementing:** integration owner publishes confirmed `types.ts`, `schemas.ts`, compiled ABI, chain configuration and API response examples. Until confirmed, use mocks/adapters at boundaries; do not invent incompatible field names.
3. **During work:** stay inside owned files; prefer small commits and short-lived branches. Coordinate shared-file changes before merging.
4. **For each PR:** include files changed, API/ABI/type changes, commands run, tests passed/failed, demo impact, and unresolved TODOs. Never claim tests passed if they were not run.
5. **On integration:** test the actual wallet-to-chain-to-backend flow. A UI-only simulated payout is not a successful payment demo.
6. **No scope creep:** do not add LP vaults, x402, Privy, Mastercard, new chains, or agent frameworks without explicit team approval.

## 11. Acceptance tests and demo completion

**Contracts:** `cd contracts && forge build && forge test` including role failures, funding, underfunded reserve, duplicate advance, dispute freeze, no-advance settlement, and accounting invariants.

**Web/backend:** from repository root run `npm run build` and `npx tsc --noEmit`; run lint/tests if scripts exist. Validate auth, Zod schemas, upload ownership, score handling, idempotency, and transaction reconciliation.

**End-to-end acceptance:**
1. Platform prefunds 900+ mock tokens.
2. Client creates and escrows invoice for 1,000.
3. Freelancer submits evidence; AI produces a persisted passing evaluation.
4. Freelancer requests advance; confirmed on-chain transfer pays 900.
5. Client approves; escrow credits reserve by 900 and transfers 100 to freelancer.
6. Repeat a second scenario with dispute: settlement stays frozen and no refund is invented.
7. Verify client approval **without advance** transfers full 1,000 to freelancer.

**Definition of done:** demonstrable UI, verified testnet contract transactions, consistent invoice/evaluation records, correct token accounting, and clear labeling of mock tokens. No external LP integration is needed.

## 12. Claude Code rules

- Read this file first and inspect repository state; do not assume a file exists.
- Do not rewrite project structure, change shared signatures, or install unrelated dependencies without approval.
- Before editing, state intended files and track; ask when interface ownership is ambiguous.
- Implement and test incrementally. Be explicit about mocks, assumptions and incomplete work.
- Never fabricate a transaction hash, AI evaluation, balance, deployed address or successful test.
- Favor the secure, complete MVP workflow over post-MVP feature work.
