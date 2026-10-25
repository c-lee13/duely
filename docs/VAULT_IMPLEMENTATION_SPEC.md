# Duely V2 — Pooled LP Vault (Canonical Specification)

> **Status: A1.5 — specification and interface design only.** No V2 Solidity exists yet. Nothing here is deployed. The ABI in §7 is a **proposal**; the compiled ABI exported to `lib/chain/generated/` will be authoritative once A2+ lands.
>
> **Scope relative to V1.** V1 (`InvoiceAdvance.sol`, operator-funded reserve, `docs/CONTRACT_SPEC.md` v1.1) stays exactly as it is: source, tests, ABIs, and the dUSD and RLUSD deployments are preserved and are **not** modified by V2. V2 is **additive**: two new contracts (`DuelyVault.sol`, `InvoiceAdvanceV2.sol`) plus one interface (`IDuelyVault.sol`). Where this document and `CLAUDE.md` / `docs/CONTRACT_SPEC.md` disagree about LPs, vaults or reserves, **this document governs V2 and those govern V1.**

## 1. Goal

Replace the platform-funded reserve with **RLUSD supplied by external liquidity providers (LPs)** into **one pooled ERC-4626 vault on XRPL EVM testnet**.

- Clients escrow invoice funds in `InvoiceAdvanceV2`, as in V1.
- Freelancers submit work. The existing AI/risk pipeline evaluates eligibility, unchanged.
- The `EVALUATOR_ROLE` signer calls `approveAdvance` on the **escrow**. The escrow instructs the vault to pay the freelancer.
- On approval, escrow repays vault **principal + financing fee**; the remainder goes to the freelancer.
- On a dispute the client wins, the client is refunded in full and the vault **recognizes the loss of the whole principal**. LPs bear it through a lower share price.
- LPs deposit RLUSD and receive transferable ERC-20 shares, **`Duely Vault Share` (`dvRLUSD`)**. Shares are a proportional claim on net vault assets, **not** a claim on specific invoices and **not** a guaranteed redemption amount.

### Worked example (approved invoice, 1,000 RLUSD)

| Item | RLUSD |
|---|---:|
| Client escrow | 1,000 |
| Advance from vault to freelancer (90%) | 900 |
| Financing fee (300 bps of invoice value) | 30 |
| Escrow repayment to vault at approval (principal + fee) | 930 |
| Remaining escrow paid to freelancer | 70 |
| Freelancer total received (900 + 70) | 970 |
| Vault NAV change | +30 (when the 930 is received) |

### Worked example (disputed, client wins)

Freelancer received 900 from the vault. Client wins the dispute and is refunded the full 1,000 escrow. The vault recovers 0, so it recognizes a **900 loss** and no fee. NAV falls by 900. The advance is never treated as repaid.

### Worked example (disputed, freelancer wins)

Normal settlement: identical to the approved case (930 to the vault, 70 to the freelancer).

## 2. Final architectural decisions (A1.5, approved)

| # | Decision |
|---|---|
| 1 | New `InvoiceAdvanceV2.sol` and `DuelyVault.sol`. V1 contracts, deployments, ABIs and regression tests are preserved untouched. |
| 2 | Fee = **fixed 300 bps of invoice value**, computed and stored when the advance is funded. |
| 3 | Withdrawals: **uncommitted RLUSD only** (the vault's actual token balance; deployed principal is never redeemable). No queue. |
| 4 | Disputes are **binary**. Client wins → full escrow refund + vault loss recognition. Freelancer wins → normal settlement. |
| 5 | The operator-funded reserve is **removed** from V2. All advances come from the pooled vault. |
| 6 | Limits: max advance 90% of invoice value; max utilization 80% of vault NAV; max single-invoice exposure 25% of vault NAV. |
| 7 | Shares: transferable ERC-20, name `Duely Vault Share`, symbol `dvRLUSD`. |
| 8 | XRPL EVM testnet (chain 1449000), **RLUSD only** for V2. dUSD and V1 deployments are preserved. |
| 9 | Only the authorized V2 escrow may call `fundAdvance`, `recordRepayment` and `finalizeLoss`. The evaluator can only approve an eligible advance *through the escrow*. |

### Final clarifications (approved, A1.5 round 2)

| # | Topic | Decision | Where |
|---|---|---|---|
| C1 | Pause | **Two independent switches**: a full emergency pause (deposits, mints, withdrawals, redemptions, advance funding) and an advance-only pause (new advances only; LPs can still exit). Repayment and loss finalization are never blocked by either. | §4.8 |
| C2 | Deposit cap | No TVL cap. Standard ERC-4626 and token restrictions still apply. | §4.3 |
| C3 | Share decimals | OZ ERC-4626 virtual offset = 6 (24-decimal shares for 18-decimal RLUSD). A2 must validate rounding, dust and inflation resistance. | §4.3 |
| C4 | Donations | No sweep. `totalAssets` is based on the vault's **actual RLUSD balance**, so direct transfers raise share value for all LPs. Nothing is stranded and nothing is counted twice. | §4.2 |
| C5 | Demo liquidity | 25% per-invoice NAV cap is preserved. Size testnet invoices to the available RLUSD; limits are never weakened for the demo. | §4.5 |
| C6 | Impairment | `I = 0` confirmed. Losses reduce outstanding principal exactly once; no separate impairment deduction. Par carrying value may overstate realizable NAV before disputes resolve. | §4.2 |
| C7 | Stuck invoices | No timeout in V2. Explicit limitation plus an A3/A4 design decision. No operator write-off or unilateral escrow refund. | §9.1 |
| C8 | Ownership | Person A owns Solidity, generated ABIs and deployment manifests. Person B consumes the exported ABIs and owns frontend/backend. | §7, §8 |

### Resolutions of A1 ambiguities (derived from the decisions above)

- **Partial recovery**: not supported. Because 90% + 3% < 100% of escrow, settlement can always repay principal + fee in full, and the only loss path is a client-wins refund, which recovers 0. `finalizeLoss` therefore takes no `recovered` argument. Partial-recovery rulings are out of scope.
- **Fee on loss**: none. A fee is earned only when received.
- **Limit authority**: limits are **compile-time constants** in V2. Nobody can change them, so there is no "change limits" role. Changing a limit means a new deployment.
- **Who finalizes a loss**: the escrow, inside `resolveDispute(id, false)`. There is no separate operator "recognize loss" call, and an operator cannot force one.
- **V1 reserve functions** (`depositReserve`, `withdrawReserve`, `availableReserve`, `reserveBalance`) do **not** exist in V2.

## 3. Contracts and boundaries

```text
contracts/src/
  InvoiceAdvance.sol        # V1, untouched
  IInvoiceAdvance.sol       # V1, untouched
  MockUSDC.sol              # V1 demo token, untouched
  IDuelyVault.sol           # NEW: the only surface InvoiceAdvanceV2 uses on the vault
  DuelyVault.sol            # NEW: ERC-4626 pooled vault + advance ledger
  InvoiceAdvanceV2.sol      # NEW: escrow, invoice lifecycle, routes advance/settlement through the vault
```

| Concern | `InvoiceAdvanceV2` | `DuelyVault` |
|---|---|---|
| Client escrow custody (`totalEscrow`) | **Owns** | Never holds it |
| Invoice record, status machine, `metadataHash` | **Owns** | Does not read it |
| Advance/fee amounts (90%, 300 bps) | **Computes** | Re-validates against caps |
| LP deposits, shares, NAV, cash balance | Never | **Owns** |
| Per-invoice advance ledger (principal, fee, repaid, loss, status) | Reads | **Owns** |
| Utilization / exposure limits | Never | **Owns and enforces** |
| Roles | Admin, Operator (disputes), Evaluator (advances) | Admin, Operator (unpause, pause), Pauser (pause only) |
| Pause | None | **Owns** (full pause + advance-only pause, §4.8) |

**Trust edges.**
- Vault → escrow: the vault has one `escrow` address (set once, then locked). All three accounting writes revert for any other caller. The vault trusts the escrow's *instruction*, but it does not trust a reported *amount*: repayment amounts come from the vault's own stored advance record and are collected by pull with an exact balance-delta check (§5.4).
- Escrow → vault: `InvoiceAdvanceV2` takes the vault address as an `immutable` constructor argument and requires `vault.asset() == paymentToken`.
- The escrow never gives the evaluator, operator or admin any path to move vault funds directly.

**Two-contract deployment and one-time escrow authorization** (resolves the circular reference; the escrow takes the vault as an immutable, so the vault is deployed first):

1. Deploy `DuelyVault(rlusd, admin, operator, pauser)`. The vault starts with `escrow == address(0)`: LPs may deposit and redeem, but `fundAdvance`, `recordRepayment` and `finalizeLoss` revert (`EscrowNotSet`).
2. Deploy `InvoiceAdvanceV2(rlusd, vault, admin, operator, evaluator)`. Its constructor requires `vault.asset() == rlusd`.
3. The vault admin calls `vault.setEscrow(escrow)` **exactly once**. It reverts if the escrow is already set, if the address is zero or has no code, or if `escrow.vault() != address(vault)` or `escrow.paymentToken() != vault.asset()`. There is no way to change or clear the escrow afterwards; replacing it means redeploying the vault.
4. The deploy script verifies `vault.escrow() == escrow`, the role assignments (evaluator, operator, pauser and admin distinct), the RLUSD address/symbol/decimals (18), and that the V1 deployments are untouched, and writes `contracts/deployments/xrpl-evm-testnet-v2.json`.

Until step 3 completes, the system is not live for borrowers. After it, the `setEscrow` right is spent, so even a compromised admin cannot redirect the vault's accounting calls to another contract.

## 4. Financial rules (frozen)

All amounts are `uint256` RLUSD base units (testnet RLUSD: 18 decimals; always read `decimals()`).

### 4.1 Advance and fee

```text
advance = floor(amount * 9000 / 10000)   // same formula as V1 (_advanceFor)
fee     = floor(amount *  300 / 10000)   // computed once, stored at fundAdvance
vaultRepayment      = advance + fee
freelancerRemainder = amount - advance - fee   // always >= 0 and > 0 (amount*0.07 minus rounding)
```

Both are computed by the escrow and re-validated by the vault. For `amount == 1,000e18`: advance 900e18, fee 30e18. `advance == 0` reverts. A zero fee (tiny amounts) is allowed; the advance still works.

### 4.2 Accounting identities

Let `B` = `token.balanceOf(vault)` (the vault's actual RLUSD), `P` = `outstandingPrincipal`, and `I` = recognized impairment against still-outstanding principal.

```text
totalAssets() = B + P - I          with I == 0 in V2
```

- **Cash is the real token balance**, not an internal ledger. This is the standard ERC-4626 model: a direct RLUSD transfer to the vault raises `B`, therefore `totalAssets` and the share price for every LP. There is **no sweep** and nothing is stranded.
- **No double counting.** `B` contains only cash; `P` contains only advances that have left the vault and not yet returned or been written off. Every state transition moves value between the two terms atomically inside one `nonReentrant` call: `fundAdvance` transfers `principal` out (`B ↓`) and raises `P` by the same amount, so NAV is unchanged; `recordRepayment` pulls `principal + fee` in (`B ↑`) and lowers `P` by `principal`, so NAV rises by exactly `fee`.
- **Fees increase NAV only when received**: the fee is cash that arrives in `recordRepayment`. The advance's stored `fee` is a quote, never an asset, and is not part of `totalAssets` while the advance is open.
- **Losses lower NAV exactly once**: `finalizeLoss` lowers `P` by the principal and adds no cash, so NAV falls by the principal; `totalRealizedLosses` rises by the principal. The advance moves to `Lost`, so the loss cannot be recognized again.
- **Donations** are not fees and not profit from invoices: they raise `B` and so NAV for all existing shareholders pro rata at the moment they arrive. They do not change any advance record, `totalFeesEarned`, or `totalRealizedLosses`. The first-depositor/donation inflation attack is addressed by the ERC-4626 virtual offset (§4.3), not by ignoring donations. Because limits are measured against NAV (§4.5), a donation also loosens them; this is accepted, since donated RLUSD is real, loss-absorbing capital.
- **Repayment is verified by balance delta, not by the donation-inflated balance**: `recordRepayment` measures `B` immediately before and after pulling from the escrow and requires an increase of exactly `principal + fee`. A donation cannot satisfy or spoof a repayment, and a repayment cannot be partially credited.
- **Expected repayment comes from stored terms.** `recordRepayment(invoiceId)` takes no amounts: it uses the `principal` and `fee` the vault recorded at `fundAdvance`. A caller cannot supply, inflate or shrink a repayment or loss.
- **`I` is always 0 in V2.** The term is kept in the formula for forward compatibility only. Realized losses are removed from `P` directly; counting a loss in both `P` and `I` would subtract it twice. There is no separate impairment deduction and no mark-down of open advances.
- **MVP valuation limitation (par carrying value).** Open advances are carried at principal until repayment or loss. This may **overstate realizable NAV** before a dispute is resolved: an advance whose invoice is under dispute, or whose client is unresponsive, still counts at par. Consequences: LPs who redeem before a loss is recognized exit at an unimpaired price, shifting the loss onto remaining LPs; new LPs who deposit before recognition buy shares at an inflated price and absorb part of an already-likely loss; and fees are not accrued over time. LP disclosures must say so.

### 4.3 Shares and ERC-4626 behavior

- OpenZeppelin `ERC4626` with `_decimalsOffset() = 6` (virtual shares/assets), giving **24-decimal** `dvRLUSD` shares for 18-decimal RLUSD. **Person B must read `decimals()` from the vault**, never assume 18 or 24.
- **No TVL deposit cap.** `maxDeposit` and `maxMint` return `type(uint256).max` while the vault is not fully paused and 0 while it is. Standard ERC-4626 rules still apply (zero-amount and rounding behavior, token approvals and balance, and any RLUSD-side pause or restriction).
- `totalAssets()` is overridden per §4.2. Conversion must stay correct after gains, losses, donations and later deposits: a depositor after a loss gets more shares per RLUSD, after a gain fewer. Rounding follows ERC-4626: down for shares minted and assets paid out, up for shares burned in `withdraw` and assets required in `mint`.
- `previewDeposit`/`previewRedeem` and friends are NAV-based and **ignore liquidity**; liquidity is expressed only through `maxWithdraw`/`maxRedeem`.
- **A2 test obligations for the offset (not yet verified, no code exists):** (a) a first depositor donating a large amount before a victim's deposit cannot make the victim's shares round to 0 or lose more than dust; (b) 1-wei and other dust deposits and redemptions never mint or pay more than the exact conversion; (c) round trips (deposit then redeem) never return more than deposited absent gains; (d) share price stays monotonic non-decreasing under fees and donations and decreases only through `finalizeLoss`; (e) a 100% loss (`totalAssets == 0` with shares outstanding) leaves the vault usable for new deposits; (f) multi-LP deposits at different share prices stay pro rata; (g) the offset's effect on the 24-decimal display is covered by a decimals assertion.

### 4.4 Withdrawals

- Withdrawals are paid only from the vault's actual RLUSD balance: `availableLiquidity() = B`. `maxWithdraw(owner) = min(convertToAssets(balanceOf(owner)), B)` and `maxRedeem(owner) = min(balanceOf(owner), convertToShares(B))`. `redeem`/`withdraw` above the cap revert with the standard ERC-4626 `ERC4626ExceededMax*` errors. No queue, no partial fills, and no promise of instant withdrawal while capital is deployed.
- Both return 0 while the vault is fully paused (§4.8). The advance-only pause does not affect them.

### 4.5 Risk limits (constants, in the vault)

| Constant | Value | Check at `fundAdvance` |
|---|---:|---|
| `MAX_ADVANCE_BPS` | 9000 | `principal * 10000 <= invoiceAmount * 9000` |
| `MAX_UTILIZATION_BPS` | 8000 | `(P + principal) * 10000 <= totalAssets() * 8000` |
| `MAX_INVOICE_EXPOSURE_BPS` | 2500 | `principal * 10000 <= totalAssets() * 2500` |
| (liquidity) | n/a | `principal <= availableLiquidity()` (token balance) |

`totalAssets()` is measured **before** the advance (the advance leaves NAV unchanged). The limits apply at funding time only; a later NAV drop can push utilization above 80% without anything breaking, it just blocks further advances. `utilizationBps() = P * 10000 / totalAssets()` (0 if NAV is 0). Rounding in all checks uses the multiplication-first form above (no division-before-multiplication).

**A3 implementation notes.** `fundAdvance` checks, in order: escrow configured and caller is the escrow; full pause and advance-only pause; freelancer is not zero, the vault, the escrow or the token; `invoiceAmount` and `principal` nonzero; no existing advance for the invoice; `principal <= floor(invoiceAmount * 9000 / 10000)`; `fee == floor(invoiceAmount * FEE_BPS / 10000)` (the vault re-validates the fee the escrow quotes, so an escrow bug cannot mis-price a repayment); `principal <= cash`; the two NAV caps. The escrow is the trust anchor for `invoiceAmount` and `freelancer` (it is the only caller and cannot be changed once set); no V2 interface change is needed for the 90% check. Because `cash = NAV − P` exactly and utilization is capped below 100%, `principal <= cash` is always implied by the utilization cap, so `InsufficientLiquidity` is unreachable and kept only as defence in depth. `maxAdvanceNow()` is computed from the same caps as `fundAdvance` (it excludes the invoice-specific 90% term).

**Consequence for the demo (flagged):** funding a 900 RLUSD advance requires `totalAssets >= 3,600` (25% exposure rule, which is stricter than the 80% utilization rule), and `availableLiquidity() >= 900`. The testnet E2E therefore needs LPs depositing at least 3,600 RLUSD in total before the first advance.

### 4.6 Dispute outcomes

| Escrow outcome | Vault effect |
|---|---|
| `approveCompletion` (client) | `recordRepayment`: `P -= principal`, balance `+= principal + fee` (verified by balance delta), advance `Repaid`, `feeEarned = fee` |
| `resolveDispute(true)` (operator) | Same as approval |
| `resolveDispute(false)` | Escrow refunds full amount to the client; `finalizeLoss`: `P -= principal`, `totalRealizedLosses += principal`, advance `Lost`, `loss = principal`, fee not earned |
| No advance taken | No vault call in any outcome |

A prior advance is never clawed back from the freelancer.

### 4.7 Authorization matrix

| Action | Allowed caller |
|---|---|
| `deposit` / `mint` / `redeem` / `withdraw` | any LP (subject to full pause and available liquidity; unaffected by the advance-only pause) |
| `fundAdvance` / `recordRepayment` / `finalizeLoss` | `vault.escrow()` only |
| `setEscrow` | vault `DEFAULT_ADMIN_ROLE`, once |
| `pause()` / `pauseAdvances()` (vault) | vault `PAUSER_ROLE` or `OPERATOR_ROLE` |
| `unpause()` / `unpauseAdvances()` (vault) | vault `OPERATOR_ROLE` only |
| `approveAdvance` | escrow `EVALUATOR_ROLE` (backend signer; cannot touch vault funds directly) |
| `resolveDispute` | escrow `OPERATOR_ROLE` |
| `createInvoice` / `cancelInvoice` (Created only) / `fundInvoice` / `approveCompletion` / `raiseDispute` | the invoice client (create: any account) |
| Grant/revoke roles | respective `DEFAULT_ADMIN_ROLE` |

Evaluator, operator and admin should be distinct addresses (enforced in the deploy script, as in V1).

### 4.8 Pause semantics (two independent switches)

| Switch | Set by | Cleared by | Effect |
|---|---|---|---|
| **Full emergency pause** (`pause()` / `unpause()`) | `PAUSER_ROLE` or `OPERATOR_ROLE` | `OPERATOR_ROLE` only | Blocks `deposit`, `mint`, `withdraw`, `redeem` and `fundAdvance`. `maxDeposit`/`maxMint`/`maxWithdraw`/`maxRedeem` return 0. |
| **Advance pause** (`pauseAdvances()` / `unpauseAdvances()`) | `PAUSER_ROLE` or `OPERATOR_ROLE` | `OPERATOR_ROLE` only | Blocks only `fundAdvance`. LP deposits and withdrawals continue normally. |

- The two flags are stored separately; clearing one does not clear the other. `fundAdvance` requires both to be clear. Views: `paused()`, `advancesPaused()`, `advancesEnabled() = !paused() && !advancesPaused()`.
- **Pausing is deliberately easier than unpausing.** A low-privilege `PAUSER_ROLE` (for example a monitoring key) can stop the system; only the `OPERATOR_ROLE` can restart it. `DEFAULT_ADMIN_ROLE` administers all three roles but holds no pause authority of its own unless it grants itself one. The evaluator holds none of these roles.
- **`recordRepayment` and `finalizeLoss` are never blocked by either switch**, in any combination. Settlement and refunds in the escrow must always be able to complete, otherwise a pause would trap client money. Consequences: during a full pause, repaid principal and fees still flow into the vault and NAV updates correctly, but LPs cannot redeem until `unpause()`; during an advance-only pause, LPs can redeem the available balance as usual.
- The escrow itself has no pause. With the vault paused, `approveAdvance` reverts (the vault's pause error bubbles up); `approveCompletion`, `raiseDispute` and `resolveDispute` keep working.

### 4.9 Token risk (RLUSD)

RLUSD is issuer-controlled (pause, clawback, upgrade; see V1 docs). If the issuer pauses RLUSD, every vault and escrow transfer reverts, including settlement. If the issuer claws back RLUSD from the vault, `totalAssets` falls with the real balance (it is balance-based, §4.2), so NAV honestly reflects the loss and redemptions cannot exceed what is actually held. These risks are **documented, not mitigated**, and must appear in the LP risk disclosure. Both contracts keep V1's exact-delta transfer check (`UnsupportedTokenBehavior`), so fee-on-transfer tokens are rejected.

## 5. Contract interface specifications

### 5.1 `IDuelyVault.sol` (proposed)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDuelyVault /* is IERC4626 */ {
    enum AdvanceStatus { None, Open, Repaid, Lost }   // order frozen

    struct Advance {
        address freelancer;
        uint256 invoiceAmount;
        uint256 principal;
        uint256 fee;            // quoted at funding (300 bps of invoiceAmount)
        uint256 principalRepaid;
        uint256 feeEarned;      // 0 until repaid; stays 0 on loss
        uint256 loss;           // principal when Lost, else 0
        AdvanceStatus status;
    }

    // ---- events (vault-specific; ERC-4626 Deposit/Withdraw are inherited) ----
    /// outstandingPrincipalAfter = vault-wide outstanding principal after this advance (A3).
    event AdvanceFunded(
        uint256 indexed invoiceId,
        address indexed freelancer,
        uint256 invoiceAmount,
        uint256 principal,
        uint256 fee,
        uint256 outstandingPrincipalAfter
    );
    event AdvanceRepaid(uint256 indexed invoiceId, uint256 principalRepaid, uint256 feeEarned);
    event AdvanceLossFinalized(uint256 indexed invoiceId, uint256 principalLoss);
    event EscrowSet(address indexed escrow);
    event AdvancesPaused(address indexed account);
    event AdvancesUnpaused(address indexed account);
    // plus OZ Paused(account) / Unpaused(account) for the full pause

    // ---- errors ----
    error NotEscrow();
    error EscrowAlreadySet();
    error EscrowNotSet();
    error InvalidAddress();
    error InvalidAmount();
    error AdvanceAlreadyExists(uint256 invoiceId);
    error AdvanceNotOpen(uint256 invoiceId, AdvanceStatus actual);
    error AdvanceExceedsInvoiceCap(uint256 principal, uint256 invoiceAmount);
    error ExceedsUtilizationLimit(uint256 outstandingAfter, uint256 maxOutstanding);
    error ExceedsInvoiceExposureLimit(uint256 principal, uint256 maxPrincipal);
    error InsufficientLiquidity(uint256 required, uint256 available); // defence in depth; see §4.5
    error InvalidFee(uint256 provided, uint256 expected);              // A3
    error AdvancesAreDisabled();       // advance-only pause set
    error EscrowMismatch();            // setEscrow sanity checks failed
    error UnsupportedTokenBehavior();
    // plus OZ Pausable (EnforcedPause / ExpectedPause) / ERC4626 / AccessControl errors

    // ---- escrow-only writes ----
    /// Pays `principal` from the vault's balance to `freelancer`; records the advance Open. Enforces §4.5.
    function fundAdvance(
        uint256 invoiceId,
        address freelancer,
        uint256 invoiceAmount,
        uint256 principal,
        uint256 fee
    ) external;
    /// Pulls (principal + fee) from the escrow (escrow must have approved exactly that), requires
    /// the exact balance delta, lowers outstanding principal, marks Repaid. Amounts come from the stored Advance.
    function recordRepayment(uint256 invoiceId) external;
    /// Marks an Open advance Lost, removes its principal from outstanding, adds to realized losses.
    function finalizeLoss(uint256 invoiceId) external;

    // ---- admin / operator ----
    function setEscrow(address escrow_) external;   // DEFAULT_ADMIN_ROLE, once
    function pause() external;                      // PAUSER_ROLE or OPERATOR_ROLE  (full pause)
    function unpause() external;                    // OPERATOR_ROLE only
    function pauseAdvances() external;              // PAUSER_ROLE or OPERATOR_ROLE  (advance-only)
    function unpauseAdvances() external;            // OPERATOR_ROLE only

    // ---- views ----
    function escrow() external view returns (address);
    function paused() external view returns (bool);            // full pause
    function advancesPaused() external view returns (bool);    // advance-only pause
    function advancesEnabled() external view returns (bool);   // !paused && !advancesPaused
    function getAdvance(uint256 invoiceId) external view returns (Advance memory);
    function availableLiquidity() external view returns (uint256);   // == token.balanceOf(vault)
    function outstandingPrincipal() external view returns (uint256);
    function totalRealizedLosses() external view returns (uint256);
    function totalFeesEarned() external view returns (uint256);
    function utilizationBps() external view returns (uint256);       // P * 10000 / totalAssets
    /// Largest principal fundAdvance would accept right now (min of balance, 80% NAV headroom, 25% NAV).
    function maxAdvanceNow() external view returns (uint256);
    function MAX_ADVANCE_BPS() external view returns (uint256);
    function MAX_UTILIZATION_BPS() external view returns (uint256);
    function MAX_INVOICE_EXPOSURE_BPS() external view returns (uint256);
    function FEE_BPS() external view returns (uint256);                // 300, A3
}
```

Inherited ERC-4626/ERC-20 surface (Person B consumes): `asset`, `name` (`Duely Vault Share`), `symbol` (`dvRLUSD`), `decimals`, `totalAssets`, `totalSupply`, `balanceOf`, `transfer`, `approve`, `allowance`, `convertToShares`, `convertToAssets`, `previewDeposit`, `previewMint`, `previewWithdraw`, `previewRedeem`, `maxDeposit`, `maxMint`, `maxWithdraw`, `maxRedeem`, `deposit(uint256,address)`, `mint(uint256,address)`, `withdraw(uint256,address,address)`, `redeem(uint256,address,address)`, events `Deposit`, `Withdraw`, `Transfer`, `Approval`.

`maxDeposit`/`maxMint` return `type(uint256).max` unless the vault is fully paused, when they return 0 (no TVL cap, §4.3).

### 5.2 `InvoiceAdvanceV2` (proposed deltas from V1)

Same status enum and order as V1 (`Created, Funded, Advanced, Settled, Disputed, Cancelled`). **The `Invoice` struct is different from V1, so V2 gets its own ABI and Person B must not reuse V1's.**

```solidity
struct Invoice {
    address freelancer;
    address client;
    uint256 amount;
    uint256 advanceAmount;   // principal advanced by the vault, 0 before advance
    uint256 advanceFee;      // fee stored at advance time, 0 before advance
    bytes32 metadataHash;
    bytes32 evaluationHash;
    InvoiceStatus status;
}

constructor(IERC20 paymentToken_, IDuelyVault vault_, address admin, address operator, address evaluator);
// views: paymentToken(), vault(), totalEscrow(), nextInvoiceId(), getInvoice(id)
function quoteAdvance(uint256 amount) external pure
    returns (uint256 advance, uint256 fee, uint256 vaultRepayment, uint256 freelancerRemainder);
```

Unchanged signatures: `createInvoice`, `cancelInvoice`, `fundInvoice`, `approveAdvance(invoiceId, evaluationHash)`, `approveCompletion`, `raiseDispute`, `resolveDispute(invoiceId, releaseToFreelancer)`, `getInvoice`.
**Removed:** `depositReserve`, `withdrawReserve`, `availableReserve`, `reserveBalance`, `InsufficientReserve`, `ReserveDeposited`, `ReserveWithdrawn`.

Behavior changes:
- `approveAdvance`: status must be `Funded`; computes `advance`/`fee`; stores both on the invoice; sets `Advanced`; calls `vault.fundAdvance(...)` (the vault pays the freelancer directly). Reverts (bubbling the vault's custom error) if limits, liquidity or pause block it. No state is left half-written.
- `_settleInvoice`: if an advance exists, escrow `forceApprove`s the vault for `advance + fee`, calls `vault.recordRepayment(invoiceId)` and the remainder goes to the freelancer; without an advance, the full amount goes to the freelancer. `totalEscrow -= amount` in the same transaction.
- `resolveDispute(false)`: full refund to the client; if an advance exists, calls `vault.finalizeLoss(invoiceId)`.
- Reentrancy guard on all fund-moving functions; checks-effects-interactions ordering is kept.

Events (new signatures; V2 is a separate contract so topics do not collide with V1):

```solidity
event InvoiceCreated(uint256 indexed invoiceId, address indexed freelancer, address indexed client, uint256 amount, bytes32 metadataHash);
event InvoiceFunded(uint256 indexed invoiceId, address indexed client, uint256 amount);
event InvoiceCancelled(uint256 indexed invoiceId);
event AdvancePaid(uint256 indexed invoiceId, address indexed freelancer, uint256 amount, uint256 fee, bytes32 evaluationHash);
event InvoiceSettled(uint256 indexed invoiceId, uint256 vaultPrincipalRepaid, uint256 vaultFeePaid, uint256 freelancerPaid);
event InvoiceDisputed(uint256 indexed invoiceId, address indexed client, uint256 advanceAlreadyPaid);
event DisputeResolved(uint256 indexed invoiceId, bool releasedToFreelancer, uint256 vaultLoss);
```

### 5.3 Event emission map (what Person B indexes)

| Moment | Escrow events | Vault events |
|---|---|---|
| LP deposit / redeem | none | `Deposit` / `Withdraw`, ERC-20 `Transfer` |
| Advance | `AdvancePaid` | `AdvanceFunded` |
| Approve / freelancer-wins | `InvoiceSettled` | `AdvanceRepaid` |
| Client-wins dispute | `DisputeResolved(…, false, vaultLoss)`, `InvoiceCancelled` | `AdvanceLossFinalized` |

### 5.4 Repayment mechanism

Pull, not push-and-trust: the vault itself calls `transferFrom(escrow, vault, principal + fee)` using the amounts it stored at funding, and reverts unless its balance rises by exactly that amount. The escrow cannot over- or under-report, and a repayment cannot be credited without real tokens arriving. The check is a balance delta taken around the pull (§4.2), so donations cannot mask a short or missing repayment. Approved invoices (and freelancer-wins disputes) repay principal plus fee; client-win disputes call `finalizeLoss` instead, with no token movement into the vault. This supersedes the README-era `recordRepayment(invoiceId, amount)` signature.

## 6. Invariants (to be tested in A4)

1. **NAV and conservation:** `totalAssets == token.balanceOf(vault) + P - I` with `I == 0`, `P == Σ principal of Open advances`, and no value counted in both terms. Direct donations raise `totalAssets` by exactly the donated amount and change nothing else (no advance record, fee or loss counter).
2. **Repayment by balance delta:** `recordRepayment` succeeds only if the vault balance rises by exactly the stored `principal + fee`; a donation never satisfies or spoofs it, and amounts are never caller-supplied.
3. **Per-advance one-shot:** `None → Open → {Repaid | Lost}`; terminal states are final; each invoice has at most one advance.
4. **Conservation of value:** across funding → settlement, `Δvault NAV = +fee`; across funding → loss, `ΔNAV = −principal`; escrow outflows plus vault inflows equal the invoice amount.
5. **Realized losses are monotonic** and equal `Σ loss` over `Lost` advances.
6. **Share solvency:** `previewRedeem(totalSupply) <= totalAssets`, and a redeem never pays more than `balanceOf(vault)`.
7. **Limits:** after any `fundAdvance`, §4.5 inequalities hold at funding-time NAV.
8. **Escrow separation:** `totalEscrow == Σ amounts of Funded/Advanced/Disputed invoices` and escrow token balance `>=` `totalEscrow`; escrow funds never fund advances.
9. **Authorization:** the three escrow-only calls revert for every other caller, including the evaluator, operator and admin.
10. **Pause:** full pause blocks deposit, mint, withdraw, redeem and `fundAdvance`; advance-only pause blocks only `fundAdvance`; neither ever blocks `recordRepayment` or `finalizeLoss`; only `OPERATOR_ROLE` can unpause; the evaluator can do none of this.
11. **No fee on loss, no clawback of the freelancer.**
12. **V1 regression:** every V1 test passes unchanged.

## 7. Artifacts and file locations (repository conventions)

The README-era `shared/abis/*` and `shared/deployments/*` paths **do not exist** in this repository and are replaced by existing conventions:

| Artifact | Location |
|---|---|
| `DuelyVault.sol`, `InvoiceAdvanceV2.sol`, `IDuelyVault.sol` | `contracts/src/` |
| Tests | `contracts/test/DuelyVault*.t.sol`, `contracts/test/InvoiceAdvanceV2*.t.sol`, `contracts/test/invariant/` (V1 tests untouched) |
| Deploy script | `contracts/script/DeployVault.s.sol` |
| Deployment manifest | `contracts/deployments/xrpl-evm-testnet-v2.json` (new; V1 manifests untouched) |
| Generated ABIs | `lib/chain/generated/duelyVaultAbi.ts`, `lib/chain/generated/invoiceAdvanceV2Abi.ts` (V1 `invoiceAdvanceAbi.ts` untouched) |
| ABI export | `contracts/script/export-abi.mjs`, extended with a V2 section (its V1 `SPEC` block remains frozen) |
| Integration guide | `docs/CONTRACT_INTEGRATION_V2.md` (owned by Person A) |

**Ownership:** Person A owns the Solidity contracts, the generated ABIs in `lib/chain/generated/`, and the deployment manifests. Person B only imports these artifacts and owns frontend/backend integration. Person B does not hand-write ABIs. See §9.3 item 1 for the unresolved `CLAUDE.md` wording.

Integration guide contents: chain ID, RLUSD/vault/escrow addresses, deployment blocks, required wallet roles, call sequences (`approve → deposit`, `previewRedeem → redeem`, escrow `approveAdvance`, settlement, dispute), read methods, events, custom errors, enum definitions, a tested happy-path and loss-path transaction hash, and breaking-change announcements.

## 8. Person A — implementation sequence

1. **A2**: `IDuelyVault.sol`, `DuelyVault.sol` + unit tests (ERC-4626 math, inflation, withdrawal caps, limits, pause, auth).
2. **A3**: `InvoiceAdvanceV2.sol` + tests (full lifecycle, settlement, dispute both ways, no-advance path, V1 regression).
3. **A4**: invariant suite (§6), fuzz on rounding, reentrancy and malicious-token tests, multi-LP share-price scenarios.
4. **A5**: `DeployVault.s.sol` (RLUSD-only guard: address, symbol, 18 decimals; refuses dUSD), testnet deploy, ABI export, `docs/CONTRACT_INTEGRATION_V2.md`.
5. **A-done**: testnet lifecycle with 2 LPs, ≥1 successful invoice, ≥1 loss-making invoice, verified receipts and events, ABIs committed.

Person B work (UI, indexing, backend; **B does not modify Solidity**) is unchanged from the original scope: freelancer "Get Paid Early" with the quote `1,000 → 900 now + 70 after approval; 30 fee; vault receives 930`, LP Earn dashboard (deposit, redeem under uncommitted-liquidity-only, NAV, available liquidity, outstanding advances, utilization, realized losses, activity), indexer with block/tx/log-index idempotency, consistent-block reads, and risk disclosures. B must never guess ABIs, always read `decimals()` of vault and token, and treat indexed data as a cache. Until A's artifacts exist, B builds against this document's §5 as mocks.

## 9. Limitations, resolved items and remaining ambiguities

### 9.1 Documented limitations (explicit, accepted for the MVP)

1. **Par valuation** of open advances may overstate realizable NAV before disputes resolve (§4.2).
2. **No timeout for stuck invoices.** If a client neither approves nor disputes, the invoice stays `Funded`/`Advanced`, principal stays outstanding indefinitely, and the escrow cannot be released by anyone but the client (approve or dispute) or, after a dispute, the operator. V2 deliberately has **no** operator write-off, no unilateral escrow refund and no automatic expiry, because none has a defined authorization or dispute policy. Whether to add a time-based mechanism (for example a freelancer-initiated dispute window, or an expiry that routes into the existing binary dispute flow) is an **explicit A3/A4 design decision**; it must define who may trigger it, its effect on escrow and vault, and its tests before any code is written.
3. **Issuer control of RLUSD** (pause, clawback, upgrade) can freeze settlement or reduce vault balance (§4.9).
4. **Donations benefit existing LPs** and loosen NAV-based limits (§4.2).
5. **Pausing the vault fully** blocks LP exits (while still letting settlement and refunds complete).

### 9.2 Resolved by the final clarifications

Redemptions while paused (full pause blocks them; advance-only pause does not), deposit cap (none), share decimals offset (6), donations (balance-based accounting, no sweep), demo liquidity (limits unchanged; size invoices accordingly), impairment (`I = 0`), stuck invoices (limitation, not implemented), directory ownership (Person A owns contracts, ABIs and manifests; Person B consumes).

### 9.3 Remaining ambiguities and contradictions (not decided here)

1. **`CLAUDE.md` §4 vs. this spec on `lib/chain`.** `CLAUDE.md` assigns `lib/shared` and `lib/chain` to the integration owner, while the V1 `docs/CONTRACT_SPEC.md` lets Track A edit `lib/chain/**` (including generated ABIs), and this spec has Person A owning generated ABIs and manifests. V2 follows the spec/CONTRACT_SPEC convention (A writes `lib/chain/generated/`; B only imports). Hand-written `lib/chain` adapters (reads, writes, deployments config) are not assigned by any decision; confirm whether A or B writes the V2 adapters.
2. **Demo size.** A 900 RLUSD advance needs at least 3,600 RLUSD of NAV and 900 of available balance. If testnet RLUSD is short, use proportionally smaller invoices. The 1,000 RLUSD example remains the canonical documentation example, not a mandatory demo size.
3. **Tiny-invoice rounding.** Fee is floored, so sufficiently small invoices carry a zero fee, and `advance == 0` reverts. A minimum invoice size is not specified; A2/A3 may propose one.
4. **`PAUSER_ROLE`** is a new role beyond the "pause" authority named in the decisions. It is added only to make pausing cheaper than unpausing. If unwanted, fold it into `OPERATOR_ROLE` without affecting anything else.
5. **Fee on partial dispute outcomes** is moot (binary only), but if the team later adds partial-recovery rulings, fee priority and the `finalizeLoss` signature must be redesigned.
6. **LP disclosure wording** (par valuation, no timeout, issuer control, no guaranteed withdrawal) is specified here by substance only; final copy belongs to Person B.
7. **`DuelyVault` view reentrancy**: with trusted tokens only, the single-transaction `B`/`P` transitions are atomic. A token with transfer hooks could expose a transient mismatch to a reader; the vault stays `nonReentrant` and RLUSD has no hooks, but a different asset would need review. Out of scope for V2 (RLUSD only).

## 10. Out of scope

Multiple vaults/assets, withdrawal queues, partial-recovery rulings, tranches, LP invoice selection, external lending, guaranteed APY or principal-protection claims, fiat, mainnet, and any autonomous AI agent with contract permissions.

## 11. Instructions to Claude Code

1. Inspect the repository before changing files; do not assume V2 files exist.
2. Person A edits Solidity, tests, scripts, deployments, `lib/chain/generated` and the integration guide. Person B owns UI/API/indexing and does not edit Solidity.
3. Do not modify V1 contracts, V1 tests, or V1 deployments.
4. Prioritize accounting correctness, authorization, regression safety and ABI stability.
5. Never claim completion without test output, deployment transaction hashes where relevant, and a working approved + disputed end-to-end scenario.
