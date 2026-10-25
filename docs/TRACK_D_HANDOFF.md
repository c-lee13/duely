# TRACK D — Privy Integration Handoff

**Status:** Phase 2 code-complete. Phase 3/4 require a configured Privy app id and a funded testnet account for in-browser verification; see §9 below.

## 1. What was done

Added Privy email login + embedded EVM wallet alongside the existing MetaMask flow. Email users receive a Duely-managed wallet; both wallet kinds complete the same backend sign-in, feed the same viem transaction pipeline, and talk to the same contracts.

- No smart contract changes (per TRACK_D §1).
- No Supabase migrations.
- No changes to `/api/auth/wallet/{challenge,verify}` or any `app/api/*` route.
- No LP, paymaster, fiat, swap, or bridge code.

## 2. Architecture

```
                     Duely frontend
                           |
                 LoginChoice (login card)
                     /            \
         "Continue with Email"   "Connect wallet"
                 |                    |
      PrivyProvider · modal      window.ethereum
                 |                    |
      embedded EVM wallet       MetaMask (injected)
                 \                    /
             hybrid WalletPort (lib/privy/wallet-port.ts)
                           |
             requireWallet() / viem createWalletClient
                           |
                 /api/auth/wallet/challenge
                 /api/auth/wallet/verify  → Supabase Auth session cookie
                           |
                        app/api/*  (unchanged)
                           |
                InvoiceAdvance.sol on XRPL EVM Sidechain Testnet
```

Both paths produce a `personal_sign`-ed challenge for the same server endpoint. The server never sees Privy; it sees a signed EVM address and binds it to a Supabase Auth user via `bind_verified_wallet` exactly as before.

## 3. Files added

| Path | Purpose |
|---|---|
| `lib/privy/config.ts` | Materialized viem `Chain` for Privy + `isPrivyConfigured()`. |
| `lib/privy/active-wallet.ts` | Module-level accessor so `wallet-port.ts` can read Privy state without React. |
| `lib/privy/wallet-port.ts` | Hybrid `WalletPort` + `signInHybrid` + `signOutHybrid`. |
| `lib/privy/stripe-stub.ts` | No-op shim for `@stripe/stripe-js` (Privy's unused fiat-onramp dep). |
| `components/duely/privy-provider.tsx` | `<PrivyAppProvider>` wrapping `PrivyProvider` with XRPL EVM chain and email+wallet login methods. |
| `components/duely/privy-bridge.tsx` | Writes Privy wallet snapshots into the module accessor and registers Privy's logout. |
| `components/duely/login-choice.tsx` | Login card with "Continue with Email" + "Connect wallet". |
| `tests/privy-wallet-port.test.ts` | 9 unit tests for the hybrid WalletPort / sign-in / sign-out (mocked EIP-1193 provider + mocked fetch). |

## 4. Files modified (surgical)

| Path | Change |
|---|---|
| `components/providers.tsx` | Wrap `DuelyProvider` with `PrivyAppProvider`. |
| `components/duely/live-auth.tsx` | Render `<LoginChoice>` instead of the single "Connect wallet" button. |
| `lib/frontend/create-repository.ts` | Inject `hybridWalletPort`, `signInHybrid`, `signOutHybrid` into `ApiDuelyRepository`. |
| `tests/live-data.test.ts` | Adjusted the `create-repository.ts` source-pin regex to the new structure (same invariant: mock is default, api requires env var). |
| `next.config.ts` | Turbopack alias for `@stripe/stripe-js` → the local stub. |
| `.env.example` | Added `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`. |

## 5. Files that were not touched

- `contracts/*` — hard off-limits per TRACK_D §1.
- `supabase/migrations/*` — no schema changes needed; `user_wallets` already carries any wallet address once verified.
- `lib/chain/*`.
- `lib/frontend/wallet-chain.ts`, `lib/frontend/tx-runner.ts`, `lib/frontend/api-repository.ts`.
- `lib/auth/wallet-{client,verify,session}.ts`.
- `app/api/*`.
- `components/duely/wallet-status.tsx` — review-pending; see §10.

## 6. Dependencies

- `@privy-io/react-auth@3.51.0` (installed with `--legacy-peer-deps` due to a `permissionless` optional-peer version skew against viem's bundled `ox@0.14.57`; `permissionless` is an unused Account Abstraction helper and is not loaded at runtime).

## 7. Chain configuration (locked)

```
Name:              XRPL EVM Sidechain Testnet
Default RPC URL:   https://rpc.testnet.xrplevm.org
Chain ID:          1449000
Currency symbol:   XRP (18 decimals)
Block explorer:    https://explorer.testnet.xrplevm.org
```

Materialized as a plain viem `Chain` in `lib/privy/config.ts` for Privy's `defaultChain` and `supportedChains` props. Chain id / RPC are read from `lib/chain/config.ts` so there is one source of truth.

## 8. Environment variables

| Name | Scope | Required? | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID` | browser | **yes** (to enable email login) | Privy application id from the Privy dashboard. If left blank, the app renders only the "Connect wallet" option (backwards-compatible fallback). |
| `PRIVY_APP_SECRET` | server | no | Reserved for optional server-side access-token verification. Not used today. |

## 9. Verification status

### Automated (all passing on this branch)

- `npm run typecheck` — clean.
- `npm run lint` — clean (0 errors, 0 warnings).
- `npm run build` — clean. Turbopack produces a static build; the Privy bundle resolves through the Stripe stub.
- `npm run test` — **493 passed, 0 failed** (+9 new Privy-specific tests in `tests/privy-wallet-port.test.ts`).
- `npm run dev` — `/` renders HTTP 200. Without `NEXT_PUBLIC_PRIVY_APP_ID`, `PrivyAppProvider` short-circuits to a passthrough; the existing MetaMask flow is unchanged.

### Manual, remaining (requires Privy app id + testnet XRP)

The following checkpoints from the plan file (`/Users/paulahirsch/.claude/plans/read-track-d-privy-md-thoroughly-inspect-immutable-flame.md`) still need to be walked by a human in a real browser. They **cannot be exercised without**:

1. A Privy app id (free from https://dashboard.privy.io/) added to `.env.local` as `NEXT_PUBLIC_PRIVY_APP_ID`.
2. Testnet XRP in the newly provisioned embedded wallet (XRPL EVM public faucet, see §12).

| Check | How to run |
|---|---|
| Email signup → embedded wallet appears in `user_wallets.verified_at` | Sign up on `/`; inspect Supabase `user_wallets` row. |
| Logout + email re-login → same embedded address | Click "Sign out" in the live banner; sign in again with the same email. |
| MetaMask flow regression | Click "Connect wallet"; sign the challenge; verify normal login works. |
| Wrong-chain state on embedded wallet | Expected to resolve automatically — Privy's `switchChain(1449000)` fires from `hybridWalletPort.switchNetwork()`. |
| First embedded-wallet testnet tx | Fund the embedded wallet with XRP; create an invoice as a customer; `fundInvoice()` should emit a confirmed receipt via `TxProgressPanel`. **Record the tx hash below once run.** |
| Freelancer advance payout | Request advance on a Privy-created invoice; the payout should hit the embedded wallet address. |
| Beneficiary mismatch guard | Have a legacy MetaMask invoice; log in as the freelancer via Privy (different embedded address); expect `WRONG_ACCOUNT` surfaced via `useToast()` — no silent redirection. |

> **Record of real testnet tx hashes:** _pending human verification_.
>
> - Phase 3 smoke (ERC-20 approve or fundInvoice): `__TBD__`
> - Phase 4 customer fundInvoice: `__TBD__`
> - Phase 4 freelancer advance payout: `__TBD__`

## 10. Known limitations and follow-ups

- **Testnet gas for embedded wallets.** New email users have 0 XRP and must receive testnet XRP before any contract write. No paymaster is in scope.
- **`components/duely/wallet-status.tsx` copy.** Still says "MetaMask" in a few spots; harmless but worth relabeling to a wallet-kind-aware string once the embedded path has been QA'd. Left as a follow-up to keep this diff surgical.
- **Account linking.** A single Supabase Auth user can hold multiple verified wallets (both an embedded and an external). We do not yet expose a UI to link additional wallets after sign-up; the server endpoint already supports it (see `lib/auth/wallet-session.ts:35-42`).
- **Stripe stub.** `next.config.ts` aliases `@stripe/stripe-js` to a no-op. If anyone later needs real fiat onramp, remove the alias and install the real package.
- **Server-side Privy token verification** was deliberately not implemented (plan §Design decision). The signed-challenge wallet-ownership proof is the load-bearing auth check; a Privy JWT verification would be redundant for authorization. Add it later if we want to attribute Supabase sessions to Privy users for analytics or lockout.

## 11. How to run the demo

```bash
# 1. Set required env
cp .env.example .env.local
# edit .env.local to set NEXT_PUBLIC_PRIVY_APP_ID
# plus the same Supabase + chain vars you were already using

# 2. Install (first time)
npm install --legacy-peer-deps

# 3. Dev
npm run dev
# visit http://localhost:3000
```

Click **Continue with Email**; enter an email; receive a code; enter it. Privy provisions an embedded wallet (first-time) or recovers the same one (returning user). The app then signs the standard challenge from the embedded wallet, and Supabase Auth sets your session cookie. You land in the dashboard as any other verified-wallet user.

## 12. Faucet

Public XRPL EVM Sidechain Testnet faucet: https://bridge.testnet.xrplevm.org or the XRPL EVM docs faucet page. Fund the embedded wallet address shown at the top of the dashboard before attempting any `fundInvoice` / advance call.
