# Duely V2: contract integration guide for Track B

**Status:** live on XRPL EVM Testnet and independently verified (`contracts/script/verify_v2.py`: 73 checks, all
passing, pinned to block 9,234,931). V2 is **additive**: the V1 contracts, manifests, ABIs, SDK and environment
variables are untouched, and nothing here requires an immediate migration.

Sources of truth, in this order: the compiled ABIs (`contracts/deployments/abi/*.json`, also typed in
`lib/chain/generated/`), the deployment manifest (`contracts/deployments/xrpl-evm-testnet-v2.json`), then this
guide. Where this guide and the chain disagree, the chain wins; run the verifier to see which.

The pooled-vault design and its risk review are in `docs/VAULT_IMPLEMENTATION_SPEC.md` and
`docs/V2_SECURITY_REVIEW.md`. This guide is only about how to integrate.

---

## 1. Addresses and network

| | |
|---|---|
| Network / chain id | XRPL EVM Testnet / **1449000** |
| Explorer | https://explorer.testnet.xrplevm.org |
| RLUSD (payment token, 18 decimals, issuer token, **not** a demo token) | `0x27b57a9D0b8d24EB97259c4E2279e45255e016f3` |
| **DuelyVault** (ERC-4626, shares `dvRLUSD`, 24 decimals) | `0x5f8B53B32acab32F8c283CB40a4B7ac04792B6E8` |
| **InvoiceAdvanceV2** (escrow) | `0x2E1598D6DBDa061EB6CafCa5D7AEe1630A04Ba96` |
| Vault deploy tx / block | `0xa29c18b9d31b42d5983de0c63fd36c1f7d46b55ff5b341112589106da7bf8c70` / 9,234,793 |
| Escrow deploy tx / block | `0xc73eb1ecf99041a38ea63a0554956fabaadcb122662d104a7c4be45791d386b5` / 9,234,835 |
| Link tx (`setEscrow`) / block | `0xc5331536ed041b595e8674ea1ffa22a5d5c5653497956caa8f6cc512ffc5b6a5` / 9,234,849 |
| **Start indexing at block** | **9,234,793** (the vault's deployment) |

Roles (testnet MVP): admin = operator = pauser = `0x6e83F6Bb6758Ced46e60be88271D72C22B84482E` (one key, the
deployer); evaluator = `0x276acaB037BB048a682E0E7ad900F3fFDCe65ECb` (separate; the same address as V1's evaluator,
so the **existing** `EVALUATOR_PRIVATE_KEY` signs V2 advances; no new key). Not suitable for production.

Parameters, identical in both contracts: financing fee **300 bps** of the invoice amount; advance **90%** of the
invoice; vault utilization cap **80%** of NAV; per-invoice exposure cap **25%** of NAV.

### Environment variables for V2 (additive; V1 variables are not overwritten)

```bash
# public (browser + server)
NEXT_PUBLIC_V2_VAULT_ADDRESS=0x5f8B53B32acab32F8c283CB40a4B7ac04792B6E8
NEXT_PUBLIC_V2_ESCROW_ADDRESS=0x2E1598D6DBDa061EB6CafCa5D7AEe1630A04Ba96
NEXT_PUBLIC_V2_TOKEN_ADDRESS=0x27b57a9D0b8d24EB97259c4E2279e45255e016f3
NEXT_PUBLIC_V2_DEPLOY_BLOCK=9234793
```

Reused unchanged: `NEXT_PUBLIC_XRPL_EVM_RPC_URL`, `NEXT_PUBLIC_XRPL_EVM_CHAIN_ID` (browser); `XRPL_EVM_RPC_URL`
(server, secret); `EVALUATOR_PRIVATE_KEY` (server only, never `NEXT_PUBLIC_*`). `NEXT_PUBLIC_CONTRACT_ADDRESS`,
`NEXT_PUBLIC_TOKEN_ADDRESS` and `DUELY_DEPLOYMENT` keep describing V1. Prefer importing the typed constants
instead of the env vars (they come from the verified manifest):

```ts
import { duelyVaultAbi, invoiceAdvanceV2Abi, deploymentV2 } from "@/lib/chain/generated/v2"
```

> The V1 SDK (`@/lib/chain`: `createInvoice`, `fundInvoice`, `trackTransaction`, ...) is bound to the V1
> `InvoiceAdvance` ABI and deployment selection and **cannot** be pointed at V2. V2 needs thin adapters over viem
> using the ABIs above (this deliverable does not add application code).

---

## 2. Wallets and signers

| Actor | Key | Signs |
|---|---|---|
| **Client** | their wallet (MetaMask, chain 1449000) | `RLUSD.approve(escrow)`, `createInvoice`, `fundInvoice`, `cancelInvoice`, `approveCompletion`, `raiseDispute` |
| **Freelancer** | their wallet | nothing is required except an optional `claim`. **Advances are requested off-chain** (HTTP to the backend); there is no on-chain "request advance" function |
| **LP** | their wallet | `RLUSD.approve(vault)`, `deposit`/`mint`, `redeem`/`withdraw`, share `transfer` |
| **Evaluator** (backend) | server-side `EVALUATOR_PRIVATE_KEY` | `approveAdvance` only |
| **Operator** | the deployer key (use CLI/keystore for the hackathon, not the web app) | `resolveDispute`, vault `pause`/`unpause`/`pauseAdvances`/`unpauseAdvances` |
| **Anyone** | any wallet | `claim(recipient)` (always pays the recipient) |

Never put the evaluator or operator key in a `NEXT_PUBLIC_*` variable or in the browser.

---

## 3. Data model

Amounts are `uint256` RLUSD base units (18 decimals): **bigint in viem, decimal strings in JSON, never floats**.
`1,000 RLUSD = 1000000000000000000000`. Vault shares have 24 decimals. Always read `decimals()` rather than hard-coding.

```ts
// InvoiceAdvanceV2.getInvoice(id)   (struct field order)
{ freelancer: Address, client: Address, amount: bigint, advanceAmount: bigint, advanceFee: bigint,
  metadataHash: Hex, evaluationHash: Hex, status: 0|1|2|3|4|5 }
// status: 0 Created, 1 Funded, 2 Advanced, 3 Settled, 4 Disputed, 5 Cancelled

// DuelyVault.getAdvance(id)
{ freelancer: Address, invoiceAmount: bigint, principal: bigint, fee: bigint,
  principalRepaid: bigint, feeEarned: bigint, loss: bigint, status: 0|1|2|3 }
// status: 0 None, 1 Open, 2 Repaid, 3 Lost
```

Invoice ids start at 1 and increase by 1 (`nextInvoiceId()` is the next id). The on-chain **financial** state is
authoritative; off-chain "Submitted/Evaluated" are separate metadata.

---

## 4. Read methods

**InvoiceAdvanceV2**

| Method | Returns / use |
|---|---|
| `getInvoice(id)` | the struct above (reverts `InvoiceNotFound` for unknown ids) |
| `quoteAdvance(amount)` (pure) | `(advance, fee, vaultRepayment, freelancerRemainder)`: the quote to show a freelancer |
| `claimable(address)` / `totalClaimable()` | credited, unclaimed RLUSD per payee / in total |
| `totalEscrow()` | RLUSD of funded, unsettled invoices |
| `nextInvoiceId()` | next id (also `createInvoice`'s return value) |
| `vault()`, `paymentToken()`, `FEE_BPS()`, `ADVANCE_BPS()` | wiring and parameters |
| `hasRole(role, account)`, `OPERATOR_ROLE()`, `EVALUATOR_ROLE()`, `DEFAULT_ADMIN_ROLE()` | permissions |

**DuelyVault** (ERC-4626 + Duely)

| Method | Use |
|---|---|
| `asset()`, `decimals()`, `name()`, `symbol()` | `RLUSD`, 24, `Duely Vault Share`, `dvRLUSD` |
| `totalAssets()` | **NAV** = RLUSD held + outstanding principal |
| `totalSupply()`, `balanceOf(a)` | shares |
| `convertToAssets(shares)`, `convertToShares(assets)` | value of a position / share price (`convertToAssets(10n ** 24n)`); an estimate, not a redemption guarantee |
| `previewDeposit/Mint/Withdraw/Redeem(x)` | exact outcome of that call at this block (ignores liquidity limits) |
| `maxDeposit(a)`, `maxMint(a)` | unlimited (uint256 max) unless the vault is fully paused (then 0) |
| `maxRedeem(a)`, `maxWithdraw(a)` | **what this LP can take out right now**: capped by the 80% utilization rule; 0 when paused |
| `availableLiquidity()` | RLUSD the vault holds (cash) |
| `withdrawableLiquidity()` | most all LPs together can withdraw now: `cash − ceil(outstandingPrincipal / 4)` (0 at/above the cap) |
| `outstandingPrincipal()` | open advances at par |
| `totalFeesEarned()`, `totalRealizedLosses()` | cumulative realized fees / losses |
| `utilizationBps()` | `outstandingPrincipal × 10000 / totalAssets` |
| `maxAdvanceNow()` | largest advance the vault would accept now (0 if paused/advances paused/no cash) |
| `getAdvance(id)` | the advance record above |
| `escrow()`, `paused()`, `advancesPaused()`, `advancesEnabled()` | linkage and pause state |
| `FEE_BPS()`, `MAX_ADVANCE_BPS()`, `MAX_UTILIZATION_BPS()`, `MAX_INVOICE_EXPOSURE_BPS()` | parameters |

**RLUSD** (standard ERC-20 plus issuer controls): `balanceOf`, `allowance`, `decimals`, `symbol`, **`paused()`**.
The existing `paymentTokenAbi` in `lib/chain/generated` is a valid ERC-20 ABI for it.

---

## 5. Write methods

| Contract.method(args) | Caller | Preconditions | Emits | Notable reverts |
|---|---|---|---|---|
| `RLUSD.approve(escrow, amount)` | client | none | `Approval` | token paused |
| `escrow.createInvoice(freelancer, amount, metadataHash)` → `invoiceId` | any (becomes the client) | freelancer ≠ caller/zero/escrow/vault/token; `amount > 0`; `metadataHash ≠ 0` | `InvoiceCreated` | `InvalidAddress`, `InvalidInvoiceParties`, `InvalidAmount`, `InvalidHash` |
| `escrow.fundInvoice(id)` | the client | status Created; allowance ≥ amount; balance ≥ amount | `InvoiceFunded` | `NotInvoiceClient`, `InvalidStatus`, token errors |
| `escrow.cancelInvoice(id)` | the client | status **Created** only | `InvoiceCancelled` | `NotInvoiceClient`, `InvalidStatus` |
| `escrow.approveAdvance(id, evaluationHash)` | **evaluator** | status Funded; `evaluationHash ≠ 0`; advance > 0; vault accepts it (below) | vault `AdvanceFunded`, then escrow `AdvancePaid` | see below |
| `escrow.approveCompletion(id)` | the client | status Funded or Advanced | vault `AdvanceRepaid` (if advanced); escrow `InvoiceSettled`, `ProceedsCredited` | `NotInvoiceClient`, `InvalidStatus`, token errors if an advance exists |
| `escrow.raiseDispute(id)` | the client | status Funded or Advanced | `InvoiceDisputed` | `NotInvoiceClient`, `InvalidStatus` |
| `escrow.resolveDispute(id, releaseToFreelancer)` | **operator** | status Disputed | `DisputeResolved` and (`InvoiceSettled`+`ProceedsCredited`) or (`ProceedsCredited`+`InvoiceCancelled`), vault `AdvanceRepaid`/`AdvanceLossFinalized` | `AccessControlUnauthorizedAccount`, `InvalidStatus` |
| `escrow.claim(recipient)` → `amount` | **anyone** | `claimable(recipient) > 0`; token working | `ProceedsClaimed` | `NothingToClaim`, token errors |
| `RLUSD.approve(vault, amount)` | LP | none | `Approval` | token paused |
| `vault.deposit(assets, receiver)` / `mint(shares, receiver)` | LP | not fully paused | `Deposit`, share `Transfer` | `EnforcedPause`, `ERC4626ExceededMaxDeposit/Mint`, token errors |
| `vault.redeem(shares, receiver, owner)` / `withdraw(assets, receiver, owner)` | LP (or an approved spender of the shares) | within `maxRedeem` / `maxWithdraw`; not fully paused | `Withdraw`, share `Transfer` | `EnforcedPause`, `ERC4626ExceededMaxRedeem/Withdraw`, token errors |
| `vault.transfer(to, shares)` | LP | none (shares are plain ERC-20) | `Transfer` | `ERC20Insufficient*` |

`approveAdvance` is gated by the vault: it reverts `EnforcedPause` (full pause), `AdvancesAreDisabled`
(advance-only pause), `InsufficientLiquidity(required, available)`, `ExceedsInvoiceExposureLimit(principal, maxPrincipal)`
(single advance above 25% of NAV), `ExceedsUtilizationLimit(outstandingAfter, maxOutstanding)` (above 80% of NAV),
or a token error. All state changes in a failed transaction roll back.

The vault's `fundAdvance`, `recordRepayment`, `finalizeLoss` and `setEscrow` exist in the ABI but only the escrow
(or, once, the admin) can call them. **Track B never calls them.**

### Allowances

| Who | Spender | Why | Amount |
|---|---|---|---|
| client | **escrow** | `fundInvoice` pulls the invoice amount | at least `invoice.amount` |
| LP | **vault** | `deposit`/`mint` pull RLUSD | at least the assets paid |
| (internal) escrow | vault | settlement lets the vault pull `principal + fee`; set and consumed inside `approveCompletion`/`resolveDispute` | never leaves a standing allowance |
| freelancer, evaluator, operator | none | | |

Redeeming your own shares needs no allowance; redeeming someone else's needs a share allowance (`vault.approve`).
RLUSD blocks `approve` while the issuer has it paused.

---

## 6. Workflows

### 6.1 Invoice creation and funding (client)

1. Backend validates the agreement and computes `metadataHash` (the shared deterministic hash of the full agreement,
   including criteria; see `CLAUDE.md` §6). It must be non-zero.
2. Client wallet: `escrow.createInvoice(freelancer, amount, metadataHash)`; read `invoiceId` from `InvoiceCreated`
   (or the return value via simulation). Backend `POST /api/invoices` verifies the receipt, creator and hash.
3. Client wallet: `RLUSD.approve(escrow, amount)` (skip if allowance is enough), then `escrow.fundInvoice(id)`.
   Status becomes Funded and `totalEscrow` rises. The client can still `cancelInvoice` only while Created.

### 6.2 Freelancer evidence, AI evaluation, advance

1. Freelancer submits evidence; backend stores it and runs the evaluation (unchanged from V1). The freelancer
   explicitly asks for an advance **over HTTP**; nothing is signed on-chain by the freelancer.
2. **Quote to show:** `quoteAdvance(amount)`. For 1,000: advance 900 now, fee 30, 70 after approval, vault repaid 930.
3. **Preflight (server, before spending gas):** invoice status is Funded; `vault.advancesEnabled()`;
   `vault.maxAdvanceNow() >= advance`; `RLUSD.paused() == false`. If any fails, report it; do not send.
4. Backend, as the evaluator: `escrow.approveAdvance(id, evaluationHash)` where `evaluationHash` is the stored
   evaluation's hash (non-zero). The **vault pays the freelancer directly**; the client's escrow is untouched.
5. Show `paid` only after the receipt succeeded **and** the `AdvanceFunded` + `AdvancePaid` events were observed.
   `AdvancePaid.amount` is the advance (principal), and `AdvancePaid.fee` the fixed fee.

Liquidity sizing: a 900 advance needs NAV ≥ 3,600 RLUSD (25% exposure rule) and 900 in cash. With smaller vault
funding, use smaller invoices (advance ≤ 25% of NAV). The vault starts **empty**: until LPs deposit,
`maxAdvanceNow()` is 0 and `approveAdvance` reverts.

### 6.3 Client approval

`escrow.approveCompletion(id)` (client). With an advance: the vault pulls `principal + fee` (930) from the escrow in
the same transaction, and the freelancer's remainder (70) is **credited**, not sent. Without an advance: the full
amount is credited. Then anyone calls `claim(freelancer)` to pay it out.

### 6.4 Disputes

1. Client: `raiseDispute(id)` any time while Funded or Advanced. Ordinary approval and new advances are then blocked.
2. Operator: `resolveDispute(id, releaseToFreelancer)`:
   - `true` (freelancer wins): identical to approval.
   - `false` (client wins): the full invoice amount is credited to the client; if an advance exists the vault records
     the **whole principal as a realized loss** and earns no fee; the freelancer keeps the advance.
3. Credits are paid by `claim`.
There is no timeout: an undisputed invoice can only be settled by its client, and a dispute only by the operator.

### 6.5 Freelancer and client claims

`claimable(address)` is the amount owed to that address across **all** its invoices and roles. `claim(recipient)`
pays the whole balance to `recipient` and nowhere else; the caller only chooses when. If the token transfer fails
(issuer pause or blacklist) the call reverts and the credit is untouched. Show "claimable" separately from
"paid"; a credited amount is not money received.

### 6.6 LP deposits and withdrawals

Deposit: `RLUSD.approve(vault, assets)` → `previewDeposit(assets)` (show expected shares) → `vault.deposit(assets, lp)`.
Withdraw: read `maxRedeem(lp)`; `previewRedeem(shares)`; `vault.redeem(shares, lp, lp)` with `shares <= maxRedeem`.
Withdrawals are paid from cash only and never push utilization above 80%, so part of a position can be unavailable
while advances are open. Value display: position = `convertToAssets(balanceOf(lp))`, NAV = `totalAssets()`.
Never promise a guaranteed APY or principal protection; show realized fees and losses separately from any estimate.

---

## 7. Financial outcomes (checked against the implementation)

**Successful invoice (advance taken, client approves)** for a 1,000 RLUSD invoice:

| Step | Client | Freelancer | Vault cash | Escrow holds | Vault NAV |
|---|---:|---:|---:|---:|---:|
| Client funds 1,000 | −1,000 | | | 1,000 | |
| Vault advances 900 (evaluator tx) | | +900 | −900 | 1,000 | unchanged (principal 900 outstanding) |
| Client approves | | | **+930** (principal 900 + fee 30, pulled by the vault) | 70 reserved as the freelancer's credit | **+30** |
| Freelancer claims 70 | | +70 (total 970) | | 0 | |

The LPs together earn the 30 (shared pro rata by shares, not to one LP). Client paid 1,000; freelancer received 970.

**Client-win dispute** (advance already paid): the client's 1,000 refund is **credited** (claimable, not instant);
the freelancer **keeps the 900** advance; the vault realizes a **900 loss** (NAV −900, shared pro rata); **no fee**
is earned. After the client claims, the escrow holds 0.

Variants: no advance + approval → freelancer credited the full 1,000, vault untouched. Freelancer-wins dispute →
same as approval. Client-win dispute without an advance → refund credit only, vault untouched. Fee and advance use
floor rounding (`advance = floor(amount × 9000 / 10000)`, `fee = floor(amount × 300 / 10000)`), so tiny invoices can
carry a zero fee, and a 1-wei invoice cannot be advanced.

---

## 8. Events and indexing

Index both contracts (and RLUSD `Transfer` only if you need token-level audit) from block **9,234,793**.

**InvoiceAdvanceV2**

| Event | Args (`indexed` marked) |
|---|---|
| `InvoiceCreated` | `invoiceId`*, `freelancer`*, `client`*, `amount`, `metadataHash` |
| `InvoiceFunded` | `invoiceId`*, `client`*, `amount` |
| `InvoiceCancelled` | `invoiceId`* |
| `AdvancePaid` | `invoiceId`*, `freelancer`*, `amount` (the advance), `fee`, `evaluationHash` |
| `InvoiceSettled` | `invoiceId`*, `vaultPrincipalRepaid`, `vaultFeePaid`, `freelancerCredited` |
| `ProceedsCredited` | `invoiceId`*, `recipient`*, `amount` (freelancer remainder **or** client refund) |
| `ProceedsClaimed` | `recipient`*, `caller`*, `amount` |
| `InvoiceDisputed` | `invoiceId`*, `client`*, `advanceAlreadyPaid` |
| `DisputeResolved` | `invoiceId`*, `releasedToFreelancer`, `vaultLoss` |
| `RoleGranted` / `RoleRevoked` | `role`*, `account`*, `sender`* |

**DuelyVault**

| Event | Args |
|---|---|
| `Deposit` | `sender`*, `owner`*, `assets`, `shares` |
| `Withdraw` | `sender`*, `receiver`*, `owner`*, `assets`, `shares` |
| `Transfer` / `Approval` (shares) | `from`*/`owner`*, `to`*/`spender`*, `value` (a mint is `from = 0x0`, a burn `to = 0x0`) |
| `AdvanceFunded` | `invoiceId`*, `freelancer`*, `invoiceAmount`, `principal`, `fee`, `outstandingPrincipalAfter` |
| `AdvanceRepaid` | `invoiceId`*, `principalRepaid`, `feeEarned` |
| `AdvanceLossFinalized` | `invoiceId`*, `principalLoss` |
| `EscrowSet` | `escrow`* |
| `Paused` / `Unpaused` | `account` (full pause) |
| `AdvancesPaused` / `AdvancesUnpaused` | `account`* |
| `RoleGranted` / `RoleRevoked` | `role`*, `account`*, `sender`* |

Rules for the indexer:
- **Idempotency key:** `(blockNumber, transactionHash, logIndex)`; ingestion must be safe to replay. Do not rely on the
  order of events from different contracts within one transaction beyond their `logIndex`.
- **Confirmations:** wait for the receipt and apply events only from successful transactions. XRPL EVM is expected to
  finalize blocks by consensus (no routine reorgs), but treat the indexer as a cache: key rows by block hash too and be
  able to re-derive from a block range.
- **Backfill/ranges:** page `eth_getLogs` in modest block ranges (the RPC may cap them); filter by contract address.
- **What each business event looks like on chain:**
  - advance: vault `AdvanceFunded` + escrow `AdvancePaid` (same tx);
  - approval / release: vault `AdvanceRepaid` (if advanced), escrow `InvoiceSettled`, `ProceedsCredited(freelancer)`;
  - client-win: escrow `DisputeResolved(false, vaultLoss)`, `ProceedsCredited(client)`, `InvoiceCancelled`, and vault
    `AdvanceLossFinalized` if advanced;
  - payout: escrow `ProceedsClaimed`.
- Percentages and money: store base-unit decimal strings; never floats.

---

## 9. Backend synchronization and block-pinned reads

Read every number of one screen or one reconciliation at the **same block**:

```ts
const blockNumber = await client.getBlockNumber()
const at = { blockNumber }
const [nav, cash, principal, supply] = await Promise.all([
  client.readContract({ address: vault, abi: duelyVaultAbi, functionName: "totalAssets", ...at }),
  client.readContract({ address: vault, abi: duelyVaultAbi, functionName: "availableLiquidity", ...at }),
  client.readContract({ address: vault, abi: duelyVaultAbi, functionName: "outstandingPrincipal", ...at }),
  client.readContract({ address: vault, abi: duelyVaultAbi, functionName: "totalSupply", ...at }),
])
```

After a transaction, verify at **its receipt block** (`blockNumber: receipt.blockNumber`), not at "latest". Invariants
you can assert at one pinned block (all hold in every reachable state; a failure means stale data or an incident):

1. `vault.totalAssets() == RLUSD.balanceOf(vault) + vault.outstandingPrincipal()`.
2. `vault.outstandingPrincipal() == Σ getAdvance(id).principal` over advances with status Open.
3. `RLUSD.balanceOf(escrow) >= escrow.totalEscrow() + escrow.totalClaimable()` (can fail only if the issuer claws back).
4. `escrow.totalEscrow() == Σ invoice.amount` over invoices Funded, Advanced or Disputed.
5. `escrow.totalClaimable() == Σ claimable(address)` over the payees you know.
6. `vault.totalSupply() == Σ balanceOf(holder)`.
7. Utilization: `outstandingPrincipal × 10000 <= 8000 × totalAssets` (can exceed only after an issuer clawback).

The database may store projections and history; it must never become the source of truth for vault balances,
settlement or claims. Run `python3 -I contracts/script/verify_v2.py` (from `contracts/`) at any time for a read-only
deployment check.

---

## 10. Errors and transaction status

Always decode reverts with the ABI (viem `decodeErrorResult`) and **simulate before sending** (`simulateContract`).

| Error | Meaning | Suggested handling |
|---|---|---|
| `InvalidStatus(id, actual)` | invoice not in the required state (0..5 above) | refresh state; do not retry |
| `NotInvoiceClient(id)` | wrong wallet | prompt the client wallet |
| `AccessControlUnauthorizedAccount(account, role)` | caller lacks the role | evaluator/operator misconfiguration |
| `InvoiceNotFound(id)` | unknown id | |
| `InvalidAddress` / `InvalidAmount` / `InvalidHash` / `InvalidInvoiceParties` | bad input | validate in the UI |
| `ZeroAdvance` | invoice too small to advance | no advance possible |
| `NothingToClaim(recipient)` | nothing credited | hide the claim button |
| `EnforcedPause` / `AdvancesAreDisabled` | vault paused (full / advances only) | retry later; LP exits are blocked only by the full pause |
| `InsufficientLiquidity(required, available)` | vault has too little cash | retry after LP deposits |
| `ExceedsInvoiceExposureLimit(principal, max)` | advance above 25% of NAV | use a smaller invoice or wait for more liquidity |
| `ExceedsUtilizationLimit(after, max)` | vault would exceed 80% utilization | wait for repayments or deposits |
| `AdvanceAlreadyExists` / `AdvanceNotOpen` | duplicate or wrong-state vault call | should not occur through the escrow; investigate |
| `ERC4626ExceededMaxDeposit/Mint/Withdraw/Redeem(owner, requested, max)` | above the allowed amount | show the `max` and offer it |
| `ERC20InsufficientAllowance` / `ERC20InsufficientBalance` / `SafeERC20FailedOperation` | allowance, balance, or the token refused (issuer pause or blacklist) | check approvals; check `RLUSD.paused()` |
| `UnsupportedTokenBehavior` | the token moved a different amount than requested | stop and escalate |
| `ReentrancyGuardReentrantCall` | should never reach a user | escalate |

Transaction status machine (per submitted tx): `submitted → pending → confirmed | reverted | replaced | unknown`.
Show `pending` immediately; show `confirmed`/`paid` only when `receipt.status == "success"` **and** the expected event is
present at the receipt block. Persist an operation record with a unique key **before** sending an evaluator
transaction, never auto-retry after an ambiguous failure (reconcile from chain first), and make `approveAdvance`
idempotent per invoice (a second attempt reverts `InvalidStatus`, which is safe).

---

## 11. Security boundaries

- **Only the escrow** can move vault money (`fundAdvance`, `recordRepayment`, `finalizeLoss`). The evaluator, operator,
  admin and every user are rejected; the evaluator can only call `approveAdvance` and cannot move funds directly.
- The **evaluator** can approve an advance for any Funded invoice within the vault's limits; the contracts cannot check
  the AI result, so the backend must enforce an explicit freelancer request and a passing evaluation first.
- The **operator** decides disputes (a refund ruling books the loss on LPs) and can pause. Unconstrained on-chain.
- The **admin** can grant itself any role; on this deployment admin = operator = pauser = deployer (testnet only).
- **Pausing:** a full pause blocks LP deposits/withdrawals and advances; the advance-only pause blocks only advances.
  Neither blocks settlement, rulings or claims.
- **RLUSD is issuer-controlled** (pause, blacklist, clawback, upgrade). An issuer pause blocks funding, LP flows,
  claims and settlement of *advanced* invoices until lifted.
- Known, accepted MVP risks to reflect in the UI copy (full list in `docs/V2_SECURITY_REVIEW.md`): LPs bear advance
  default risk and cannot always withdraw; open advances are valued at par until resolved; no invoice timeout; a
  depositor joining just before a repayment captures part of that fee; a donation to an almost-empty vault is not
  recoverable.

---

## 12. Clarifications relative to the brief

These are not defects; they are places where a plain reading of the brief would be inaccurate:

1. **"Freelancer advance requests"** are an off-chain backend action. There is no on-chain request function; the
   freelancer signs nothing for an advance.
2. **"Vault receives 930 on settlement"** is correct, but it is a **pull**: the vault takes 930 from the escrow inside the
   client's `approveCompletion` transaction. The freelancer's 70 is **credited**, and reaches their wallet only on `claim`.
3. **"Client receives a 1,000 refund claim"** is exact: the refund is a credit, not an immediate transfer.
4. **"LP vault earns 30"**: the 30 raises NAV and is shared pro rata by shares among all LPs.
5. **`AdvancePaid.amount`** is the advance (principal), not the invoice amount.
6. The vault is deployed **empty**; no advance can be funded until LPs deposit (see 6.2 for sizing).
7. V1's `CLAUDE.md` text "no external LPs, ERC-4626 vault" describes V1 only; V2 is governed by
   `docs/VAULT_IMPLEMENTATION_SPEC.md`.

---

## 13. Quick checks

```bash
cd contracts
python3 -I script/verify_v2.py                              # 73 read-only checks pinned to one block
node script/export-abi-v2.mjs --check                      # ABIs, typed constants and manifest are current
cast call 0x5f8B53B32acab32F8c283CB40a4B7ac04792B6E8 "escrow()(address)" --rpc-url xrpl_evm_testnet
cast call 0x2E1598D6DBDa061EB6CafCa5D7AEe1630A04Ba96 "quoteAdvance(uint256)(uint256,uint256,uint256,uint256)" 1000000000000000000000 --rpc-url xrpl_evm_testnet
# expected quote for 1,000 RLUSD: 900e18, 30e18, 930e18, 70e18
```
