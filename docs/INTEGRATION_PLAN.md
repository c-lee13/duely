# Duely — Full-Stack Integration & End-to-End Testing

You are the lead integration engineer for **Duely**, an XRPL EVM hackathon project. Track A (smart contracts + blockchain SDK) and Track B (Next.js frontend + Supabase + AI evaluation) have been merged.

Your task is to **integrate, debug, and comprehensively test the entire application**, ensuring that the frontend, backend, database, AI evaluator, and smart contracts work together.

Do not merely run existing tests. Trace actual application workflows, identify missing connections, implement fixes, and verify that the complete product works.

## 0. First: Inspect the repository

Read and understand:

- `CLAUDE.md`
- `docs/CONTRACT_SPEC.md`
- `docs/CHAIN_SDK_HANDOFF.md`
- `docs/TRACK_B_A7_HANDOFF.md`
- `package.json`
- `.env.example`
- Relevant frontend, API, Supabase, SDK, and Foundry source files

Inspect the Git state, branch history, deployment manifests, and existing tests.

Identify the actual implemented architecture. Do not assume the documentation perfectly matches the code.

Before making changes, produce a concise integration checklist identifying:
1. Components already connected
2. Missing integrations
3. Incompatible interfaces or data models
4. Critical blockers to a working demo

Then proceed with implementation without waiting for approval unless a destructive action, real-money transaction, or missing credential requires it.

## 1. Standardize RLUSD deployment configuration

**RLUSD on XRPL EVM Testnet is the primary demo deployment.**

Expected configuration:

```dotenv
DUELY_DEPLOYMENT=rlusd
NEXT_PUBLIC_DUELY_DEPLOYMENT=rlusd

NEXT_PUBLIC_XRPL_EVM_CHAIN_ID=1449000
NEXT_PUBLIC_XRPL_EVM_RPC_URL=https://rpc.testnet.xrplevm.org
XRPL_EVM_RPC_URL=https://rpc.testnet.xrplevm.org

NEXT_PUBLIC_CONTRACT_ADDRESS=0x1B972ec6B1B5E0b592010e7484beF0accC382792
NEXT_PUBLIC_TOKEN_ADDRESS=0x27b57a9D0b8d24EB97259c4E2279e45255e016f3

CONTRACT_ADDRESS=0x1B972ec6B1B5E0b592010e7484beF0accC382792
TOKEN_ADDRESS=0x27b57a9D0b8d24EB97259c4E2279e45255e016f3
```

Verify these addresses against the actual deployment manifests and chain. Do not blindly overwrite working configuration.

Ensure:
- Frontend and backend select the same deployment.
- All token amounts use the correct 18-decimal RLUSD precision.
- No dUSD addresses are accidentally used in RLUSD workflows.
- dUSD remains a functional fallback.
- No private keys are exposed through `NEXT_PUBLIC_*` variables.
- Environment variables are validated with actionable errors.

Preserve existing secrets in `.env` / `.env.local`. Never print, commit, or log them.

## 2. Integrate frontend ↔ blockchain SDK

Inspect the existing SDK in `lib/chain/` and reuse it wherever possible.

Connect the frontend to real blockchain functionality:

- Wallet connection and XRPL EVM Testnet network switching
- Client invoice creation and escrow funding
- RLUSD allowance/approval
- Invoice creation and on-chain invoice ID retrieval
- Operator reserve funding
- Freelancer early-payment request
- Evaluator authorization
- Freelancer advance payout
- Client approval and final settlement
- Client rejection/dispute handling, limited to implemented contract capabilities
- On-chain invoice status and transaction history

Do not duplicate existing SDK logic.

Ensure all blockchain transactions:
1. Are submitted through the correct wallet or authorized backend signer.
2. Display pending status.
3. Wait for transaction confirmation.
4. Handle reverted/failed transactions.
5. Update the UI and database only after confirmation.

**Never mark an invoice as paid or settled merely because a transaction hash exists.**

Verify contract roles and signer permissions. Do not attempt privileged transactions from an unauthorized wallet.

## 3. Integrate Supabase

Inspect the existing Supabase schema, migrations, API routes, and data-access layer.

Ensure frontend, database, and blockchain agree on:
- Invoice IDs and on-chain invoice IDs
- Client/freelancer wallet addresses
- Invoice amounts and token denomination
- Payment status
- Evaluation status
- Advance amount
- Escrow status
- Settlement status
- Transaction hashes and confirmation status

Define a clear mapping between off-chain UI states and on-chain contract states.

Prevent:
- Duplicate invoice creation
- Duplicate advance payouts
- Duplicate settlement attempts
- Database state claiming payment succeeded when the chain transaction failed
- Inconsistent states after refresh or retry

Preserve the existing schema where practical. Use migrations for necessary changes; do not reset or delete existing data.

## 4. Integrate AI evaluation (A7)

Inspect the existing Gemini/OpenAI implementation and the evaluator handoff documentation.

The intended workflow is:

1. Client defines invoice deliverables and acceptance criteria.
2. Freelancer submits completed work.
3. Backend retrieves the invoice criteria and submission.
4. AI evaluator assesses the submission against those criteria.
5. Evaluation result is stored with reasoning and score.
6. A deterministic backend policy decides whether an advance is eligible.
7. Authorized evaluator signer submits the relevant on-chain transaction.
8. Backend waits for confirmation.
9. UI displays the confirmed evaluation/payment result.

Important requirements:
- AI output must not directly authorize an on-chain transfer without backend validation.
- Keep evaluator private keys server-side.
- Validate invoice state, eligibility, amounts, and roles before signing.
- Handle malformed AI output, API failures, timeouts, and retries.
- Do not expose private keys or sensitive credentials to the browser.
- Do not silently substitute a mock evaluation for a real one.
- If AI credentials are unavailable, explicitly report that live evaluation is blocked and test using a clearly labeled mock mode.

Reuse the existing Supabase/backend infrastructure instead of creating a duplicate service.

## 5. Verify financial correctness

Duely's intended financial model:

**Example: 100 RLUSD invoice**

- Client deposits 100 RLUSD into escrow.
- Operator/LP reserve advances 90 RLUSD to freelancer.
- Client approves completed work.
- Escrow repays 90 RLUSD to the reserve.
- Remaining 10 RLUSD goes to freelancer.

For client-favorable dispute outcomes:
- Client receives the escrow refund.
- The advance already paid to the freelancer is not clawed back automatically.
- The reserve/LP bears the loss.

Verify that the actual contract implements these rules and that the UI represents them accurately.

Check:
- No double payment
- No unauthorized withdrawals
- No settlement before valid authorization
- No incorrect 6-vs-18-decimal conversions
- No reserve underflow or insolvency caused by arithmetic errors
- No contradictory invoice states
- Correct event emission and interpretation
- Correct balance changes for each role

Do not implement an imaginary dispute arbitrator or production LP vault if those components do not exist. Clearly identify MVP limitations.

## 6. Test the complete application

Run existing tests first, then add missing integration tests.

### A. Smart contracts
- Foundry unit tests
- Authorization and role tests
- Invoice lifecycle tests
- Reserve accounting
- Approval/settlement
- Rejection/dispute
- Reverts and edge cases

### B. Blockchain SDK
- ABI consistency
- Deployment selection
- Decimal conversion
- Wallet/signer handling
- Transaction confirmation
- Event parsing
- Error handling

### C. Backend
- API route tests
- Supabase data access
- AI evaluation validation
- Evaluator authorization
- Duplicate requests
- Failed transactions
- Retry/recovery behavior

### D. Frontend
- Build and TypeScript checks
- ESLint
- Wallet connection
- Invoice creation
- Freelancer submission
- Evaluation results
- Payment statuses
- Transaction links
- Refresh/state persistence
- Error and loading states

### E. End-to-end
Test the complete lifecycle:

**Client creates invoice → escrow funded → freelancer submits work → AI evaluates → advance authorized → freelancer receives RLUSD → client approves → escrow settles → UI and Supabase reflect confirmed chain state.**

Also test a client-favorable rejection/dispute path, if supported by the current contract.

Use mocked signers/RPC responses for automated tests where appropriate. Use the live XRPL EVM Testnet for read-only verification.

Do not execute new live value-transferring transactions without explicit approval. Existing successful RLUSD transaction reports may be used as regression evidence, but do not present them as proof that the newly integrated frontend works.

## 7. Resolve issues and rerun tests

For every failure:
1. Identify the root cause.
2. Fix it in the appropriate layer.
3. Add a regression test.
4. Rerun affected tests.
5. Check that the fix does not break another component.

Preserve functionality from both teammates.

Do not remove tests, disable type checks, or weaken security checks just to obtain passing results.

If the browser is available, perform actual UI walkthroughs. Otherwise, distinguish automated coverage from unverified manual browser flows.

## 8. Deliverables

Create `docs/INTEGRATION_REPORT.md` containing:

### Architecture
- Final frontend/backend/blockchain integration diagram
- API and SDK interfaces
- Database/on-chain state mapping

### Changes made
- Files modified
- Bugs fixed
- Missing integrations completed

### Test results
For each test suite, report:
- Command executed
- Passed/failed/skipped counts
- Relevant error messages
- Fixes applied

### End-to-end verification
- Workflows actually executed
- Mocked versus live components
- Transaction hashes, if existing or explicitly authorized
- Remaining unverified steps

### Remaining blockers
Classify each as:
- P0: Blocks the demo
- P1: Important but workaround exists
- P2: Post-hackathon improvement

### Demo readiness
Provide an exact, reproducible demo walkthrough, including which wallet/account performs each action.

## 9. Final requirements

- Prioritize a **working end-to-end RLUSD demo** over unnecessary refactoring.
- Preserve the working A6.6 blockchain implementation.
- Preserve Track B's existing frontend and Supabase architecture.
- Do not add unnecessary dependencies.
- Do not expose credentials.
- Do not deploy replacement contracts unless strictly necessary and explicitly approved.
- Do not claim success for untested flows.
- Do not commit or push changes automatically.

**Start by inspecting the repository, then integrate and test systematically. Continue until all fixable P0 issues are resolved.**
