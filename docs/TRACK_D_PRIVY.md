# TRACK D — Privy Authentication & Wallet Abstraction

**Project:** Duely — Freelance Escrow & Early Payments  
**Owner:** Track D / Privy Integration  
**Stack:** Existing Next.js / TypeScript / viem / XRPL EVM application (verify in repository)  
**Tool:** Claude Code  
**Priority:** Hackathon MVP

## 0. Mission

Duely already has a working frontend, backend, deployed smart contracts, native crypto wallet connectivity, and customer/freelancer escrow and early-payment flows. Your task is to add **Privy email authentication and embedded EVM wallets** without rebuilding or breaking those systems.

Users must be able to:

1. Continue with email and have a Privy embedded wallet provisioned.
2. Return later to the **same** wallet and application account.
3. Alternatively connect an existing external crypto wallet.
4. Use existing customer and freelancer contract workflows on XRPL EVM with either wallet type.
5. See accurate balances, signing prompts, transaction status, and errors.

**There is no liquidity-provider functionality in the current application.** Do not assume any LP role, UI, backend model, vault, deposits, withdrawals, or contracts exist. Do not create them. This track concerns **customers and freelancers only**.

## 1. Scope and exclusions

### In scope

- Privy SDK integration and email login.
- Embedded wallet provisioning and returning-user recovery.
- Compatibility with the existing external-wallet connection flow.
- Session persistence, logout, and account switching.
- Secure application-user identity and wallet association.
- XRPL EVM custom-chain configuration and signing through existing viem transaction infrastructure.
- Existing customer escrow and freelancer advance/payout interactions.
- Minimal changes to existing UI and backend authentication/authorization as needed.
- Tests, environment configuration, and a handoff document.

### Out of scope

- **All liquidity-provider functionality**, including LP roles, dashboards, vaults, accounting, deposits, or withdrawals.
- MoonPay, Mastercard, bank withdrawals, fiat on/off-ramps.
- Swaps, bridges, new token support, and cross-chain functionality.
- New contracts, contract modifications, and redeployments.
- Changes to escrow, underwriting, advances, settlement, or financial accounting.
- Gas sponsorship/paymasters/relayers unless separately approved.
- A frontend or backend rewrite.

## 2. Architectural principle

```text
                         Duely frontend
                               |
                      Login / Connect
                        /           \
                 Email login     External wallet
                     |            existing connector
                 Privy auth            |
                     |                 |
               Embedded EVM wallet     |
                        \             /
                         Wallet adapter
                               |
                 Existing viem / transaction SDK
                               |
                       XRPL EVM testnet
                               |
                   Existing escrow / advance
                       /               \
                   Customer          Freelancer
```

This is conceptual; inspect the real repository before deciding where calls and providers belong. Privy provides authentication, wallet provisioning, and signing. Existing contracts govern funds and financial state.

## 3. D1 — Audit and plan (approval gate)

**Do not change source code until the plan is approved.** First inspect:

- Next.js version, app routing, providers, UI conventions, state/query caching.
- Wallet connectors, EIP-1193 providers, wagmi/viem/ethers usage, hooks, and signers.
- Existing backend framework, user records, sessions, protected APIs, and role enforcement.
- Customer invoice/escrow creation, token approval, deposit, approval/dispute flows.
- Freelancer invoice assignment, beneficiary address, advance request, and payout flows.
- XRPL EVM chain ID, RPC, explorer, gas token, token addresses, ABIs, deployed contract addresses, and test scripts.
- Existing automated tests, scripts, CI checks, and environment-variable conventions.

Verify against **current official Privy documentation**: SDK versions, email auth, embedded EVM wallet behavior, custom EVM chain support, provider/viem integration, external wallet compatibility, token verification on the backend, and recovery. Do not infer XRPL EVM support merely from EVM compatibility; test the actual provider and network.

**Plan deliverable:** Current architecture; compatibility findings; minimal integration design; exact files to create/edit; dependencies; environment variables; identity/ownership model; phase-by-phase tests; risks and blockers; decisions requiring approval. Stop and wait for approval.

## 4. D2 — Email authentication and wallet lifecycle

Provide clear options in the existing login/connect surface:

- **Continue with Email** — Privy authentication, then provision or retrieve the user's embedded EVM wallet.
- **Connect Crypto Wallet** — preserve the current external-wallet experience.

Requirements:

- New email user receives one persistent wallet; returning users recover the same address.
- Do not create a new embedded wallet at every login or unnecessarily create one for external-wallet users.
- Logout ends the app session, clears sensitive state, and invalidates user-specific cached data.
- Handle expired sessions, failed verification, interrupted login, disconnection, and wallet/account changes.
- Preserve role-aware navigation for **customer** and **freelancer** only.
- Do not promise gasless transactions or frictionless recovery beyond Privy's actual supported configuration.

**Done when:** A customer and a freelancer can each sign up with email, receive a wallet, log out, and return to the same wallet; existing external-wallet login still works.

## 5. D3 — User identity and wallet ownership

Reuse the existing user model rather than creating duplicate identity stores. A conceptual model is:

```typescript
type DuelyRole = 'customer' | 'freelancer';
type WalletKind = 'embedded' | 'external';

type DuelyUser = {
  id: string;
  privyUserId?: string;
  email?: string;
  role: DuelyRole;
  activeWalletAddress: `0x${string}`;
  walletKind: WalletKind;
};
```

Adapt to the actual schema; this is **not** a mandatory migration.

- Keep app identity distinct from wallet address.
- Verify Privy access tokens server-side on endpoints relying on Privy auth.
- Never trust a frontend-supplied user ID, role, or wallet address as proof of ownership.
- Preserve existing authorization for external-wallet users; use appropriate wallet-signature proof where required.
- Do not silently merge an email account with a pre-existing wallet account.
- Do not transfer ownership or rewrite on-chain beneficiaries when a user changes wallets.
- Explicitly identify whether users can link wallets; if a new linking/migration flow is required, request approval.

**Done when:** Customer and freelancer identities, roles, authorized wallet addresses, and financial records remain consistent and secure across sessions.

## 6. D4 — Shared wallet adapter

Existing contract operations should work regardless of the signing provider. Prefer adapting the existing wallet context/hooks rather than introducing an independent second wallet state.

Conceptual API (reuse the project's real viem types):

```typescript
interface DuelyWallet {
  address: `0x${string}`;
  kind: 'embedded' | 'external';
  getChainId(): Promise<number>;
  signMessage(message: string): Promise<`0x${string}`>;
  sendTransaction(transaction: TransactionRequest): Promise<`0x${string}`>;
}
```

Responsibilities:

- Active address, chain, provider, signer, connection status.
- Contract reads, ERC-20 approvals, and contract writes via existing viem utilities.
- Propagate rejection, revert, wrong-chain, insufficient-gas, and provider errors.
- Preserve hashes and wait for confirmed receipts before reporting success.
- Refresh balances and invalidate queries after confirmed writes or wallet changes.
- Do not rewrite existing contract hooks without explaining why and getting approval.

**Done when:** The same existing contract action works with an embedded and an external wallet.

## 7. D5 — XRPL EVM network and signing

Use the **exact testnet configuration from the repository**. Verify chain ID, RPC, native gas token, explorer, contracts, tokens, and Privy's ability to sign and broadcast transactions on that chain.

Required:

- Read native and ERC-20 balances.
- Approve ERC-20 allowances.
- Submit existing contract transactions.
- Display transaction hash and confirmed status.
- Reject or safely handle wrong-chain requests.
- Surface gas shortages and reverted transactions clearly.

An embedded wallet may require testnet XRP for gas. **Do not add a paymaster, gas sponsorship, token swaps, or bridging without approval.** Never log or store private keys, seed phrases, or wallet recovery secrets.

**Done when:** At least one real XRPL EVM testnet transaction is signed by a Privy embedded wallet and confirmed on-chain, with chain/address/hash recorded.

## 8. D6 — Customer integration

Connect the embedded wallet to **existing**, not newly invented, customer flows:

1. Sign up with email and access the customer dashboard.
2. Create an invoice/escrow through existing UI and backend.
3. Approve the supported token, if required.
4. Fund the escrow with the embedded wallet.
5. View the confirmed transaction and updated escrow state.
6. Use existing approval/dispute actions where already implemented.

Preserve invoice conditions, escrow funding amounts, authorization, contract state transitions, and settlement accounting. Do not mark a deposit successful on transaction submission alone.

**Done when:** A customer can complete the existing escrow path through a Privy embedded wallet without breaking external-wallet functionality.

## 9. D7 — Freelancer integration

Connect the embedded wallet to existing freelancer flows:

1. Sign up with email and access the freelancer dashboard.
2. View assigned invoices.
3. Request an early payout through existing logic.
4. Sign required transactions through Privy where applicable.
5. Receive payout at the contract-authorized beneficiary wallet.
6. View wallet balances and transaction status.

**Critical:** Existing invoices may reference an external wallet as beneficiary. Do not silently redirect payouts to a newly created embedded wallet. Inspect how beneficiary addresses are set and authorized. If linking/migration is necessary, propose a separate safe design and ask for approval.

Do not change eligibility, underwriting, payout calculations, or settlement.

**Done when:** A freelancer can complete the existing early-payout flow using an embedded wallet, with correct beneficiary authorization.

## 10. D8 — Minimal UI changes

Reuse the current design system and screens. Add or adapt:

- Email and crypto-wallet login options.
- Authenticated state, logout, and wallet address display.
- Wallet balance display where already supported.
- Clear states for awaiting signature, submitted, confirming, confirmed, failed, wrong network, and insufficient gas.
- Account switching and stale-cache invalidation.

Do not build new dashboards, a separate Privy app, or any LP screens. Avoid exposing seed phrases, RPC configuration, and private-key details to ordinary users.

## 11. D9 — Backend security

Where protected backend requests use Privy authentication, verify access tokens with Privy's supported server SDK and map the verified identity to the existing user. Enforce customer/freelancer authorization and wallet ownership on financial operations. Keep secrets server-side. Prevent spoofed wallet addresses, cross-user invoice access, duplicate account creation, and stale authenticated caches. Preserve the current external-wallet auth flow.

Remember: **being logged in is not proof of control of an arbitrary wallet**. Signing and application authorization must both remain correct.

## 12. D10 — Testing

| Test | Expected result |
|---|---|
| New customer email signup | Embedded wallet created |
| New freelancer email signup | Embedded wallet created |
| Logout / email re-login | Same wallet recovered |
| Existing external-wallet login | Works unchanged |
| Session expiration | Protected operations rejected |
| Account or wallet switch | Correct identity, address, and balances |
| Wrong chain | Safely blocked or switched with user consent |
| Insufficient gas | Clear error; no false success |
| ERC-20 approval | Confirmed correct allowance |
| Customer escrow funding | Existing contract succeeds |
| Freelancer advance/payout | Authorized wallet receives funds |
| Existing invoice with different beneficiary | No unauthorized redirection |
| Transaction rejection/revert | Correct failure state |
| Invalid backend token | Rejected |
| Wallet address spoofing | Rejected |

Run existing lint, type checks, tests, and production build. Test real contract writes on the configured XRPL EVM **testnet** using approved test accounts and assets. Record receipts and hashes. Clearly distinguish mocked, simulated, and actual on-chain tests. Do not execute production transactions.

## 13. Deliverables

- Working Privy authentication and embedded wallet integration.
- Preserved native wallet connections.
- Shared signing/transaction integration with existing viem code.
- Customer and freelancer workflows connected to embedded wallets.
- Appropriate backend token verification and wallet authorization.
- `.env.example` updated with required **names**, not real secrets.
- Focused tests and successful build.
- `TRACK_D_HANDOFF.md` including architecture, changed files, dependencies, env vars, login/wallet lifecycle, compatibility findings, customer and freelancer test results, transaction hashes, blockers, limitations, and remaining setup.

Never commit credentials, API secrets, private keys, or sensitive tokens.

## 14. Phases and approval gates

**Phase 1 — Audit and plan:** Inspect code and current Privy docs. Produce exact-file plan and compatibility findings. **Stop for approval.**

**Phase 2 — Authentication:** Email login, wallet provisioning, returning-user recovery, logout, existing wallet regression. **Checkpoint:** both roles can log in and recover wallets.

**Phase 3 — Wallet adapter:** Privy provider to existing viem transactions; XRPL EVM configuration; testnet signing. **Checkpoint:** confirmed testnet write.

**Phase 4 — Existing workflows:** Customer escrow and freelancer advance/payout. **Checkpoint:** both roles complete their already-implemented contract paths.

**Phase 5 — Verification and handoff:** Tests, build, regression, docs, and reviewable PR.

After each phase, run relevant tests, report verified behavior and blockers, and avoid claiming untested work is complete.

## 15. Shared repository rules

- Work on `feat/privy-integration`, not `main`.
- Coordinate edits to shared providers, hooks, SDK interfaces, and auth middleware.
- Do not modify or redeploy smart contracts.
- Do not change financial accounting.
- Do not add LP-related code, types, roles, screens, or documentation as part of this task.
- Do not overwrite teammates' changes or force-push shared branches.
- Prefer minimal changes and small reviewable commits.
- Do not merge without approval.

## 16. Definition of done

- [ ] Customer email signup and wallet provisioning work.
- [ ] Freelancer email signup and wallet provisioning work.
- [ ] Returning users recover the same wallet.
- [ ] External wallet connection and signing remain functional.
- [ ] Correct XRPL EVM testnet chain is used.
- [ ] Privy embedded wallet signs a confirmed real testnet transaction.
- [ ] Existing viem transaction code is reused.
- [ ] Customer escrow flow works through Privy.
- [ ] Freelancer advance/payout flow works through Privy.
- [ ] Beneficiary ownership and backend authorization remain secure.
- [ ] Existing tests and production build pass.
- [ ] Handoff document records verified results and limitations.
- [ ] No smart contract/accounting changes or LP features were introduced.

## 17. Starting instruction for Claude Code

Read `TRACK_D_PRIVY.md` in full. Enter **Plan Mode**. Thoroughly inspect the repository and verify current Privy compatibility with the project's XRPL EVM testnet. Present a detailed, minimal-change implementation plan listing files, dependencies, architecture, risks, security decisions, and test checkpoints. **Do not modify code until I approve the plan.**

The end goal is for **customers and freelancers** to sign up by email, receive a persistent embedded wallet, and use the existing Duely XRPL EVM workflows without installing an external wallet, while preserving existing crypto-native connections. **There is no LP functionality in scope.**
