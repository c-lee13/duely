# Duely V2: A5 Security & Risk Review

**Scope:** `DuelyVault.sol`, `InvoiceAdvanceV2.sol` and their interfaces as of A4, plus the V1-compatible token assumptions. **Not an audit.** It is an internal adversarial review with tests; an independent audit is still required before any real funds. No deployment and no ABI export were done. V1 was not touched.

**A5.5 update:** decisions D3 and D4 are implemented, D1, D2, D5 and D6 are accepted and documented (§4). Statuses below reflect that.

**Result in one line (A5):** no exploitable defect was found in the contract logic (authorization, reentrancy, accounting atomicity, rounding, pause behavior). The material risks are **economic design weaknesses** and **trust/issuer assumptions**; several need a product decision before A6. Nothing here removes the need for an audit.

## 1. Method

1. Re-read every state-changing path as an attacker (LP, client, freelancer, evaluator, operator, pauser, admin, token issuer).
2. Wrote adversarial tests for each hypothesis. Tests named `test_KNOWN_*` pin **current behavior of documented weaknesses** so a future mitigation shows up as a deliberate change.
3. Mutation-checked the two most important protections (reentrancy guard on `redeem`; the escrow-only check on `fundAdvance`): removing either makes the new tests fail.

## 2. Findings

Severity is for the MVP as designed (testnet, RLUSD, operator-run disputes). "Open" means a decision or work is still needed.

| ID | Severity | Finding | Status |
|---|---|---|---|
| S-01 | **Medium** | **Fee sniping.** A depositor who joins just before a repayment captures almost the entire fee and can redeem in the same block, with no exposure. In the test a 10M deposit takes >29 of a 30 fee; the LPs who funded the advance gain <1. | **Accepted MVP risk (D2)**, no holding period |
| S-02 | **Medium** | **Informed exit during a dispute.** A disputed advance is still carried at par, so an LP can redeem at the unimpaired price and leave the loss to the LPs who stay. (Symmetrically, a depositor during a dispute inherits part of a probable loss.) In the test the remaining LP loses ~ 4x its fair share (D3 now caps the exit at cash − P/4 but not the price). | **Accepted; operational pause runbook (D1)**, §4.1 |
| S-03 | **Medium → Low** | **Limits bound only at funding.** LPs could withdraw cash until utilization was ~100%. **Fixed (D3):** withdrawals now stop at 80% utilization (`withdrawable = cash − ceil(P/4)`). **Residual:** the cap bounds total utilization, not per-invoice concentration; after exits one 900 advance can be ~40% of the shrunken NAV (above the 25% funding cap). | **Mitigated (D3)**; residual accepted |
| S-04 | **High (trust)** | **Admin can grant itself every role** (evaluator, operator, pauser) on both contracts. Admin == all roles. | **Accepted for testnet (D5)**; multisig + stronger controls required before production |
| S-05 | **High (liveness)** | **No timeout.** Nobody but the client can settle an undisputed advanced invoice; evaluator/operator/admin cannot. Principal stays locked indefinitely (tested after 5 years). Also usable as capital-lock griefing by a client+freelancer pair that fools the evaluator (cost to them: 100 locked, recoverable for 30). | **Accepted (D6)**: no timeout until a dispute/expiry policy exists |
| S-06 | **High (trust)** | **Operator discretion.** A binary ruling by the operator decides who gets the escrow and whether the vault books a loss. Operator + a counterparty can drain LP capital up to the caps. | Documented, operational |
| S-07 | **Medium-High → Medium (external)** | **RLUSD issuer controls.** Issuer pause freezes token movement (state stays consistent, tested). **Fixed (D4):** a blacklisted freelancer or client can no longer block settlement, release or refund rulings, or force an LP loss; their credit simply waits (both failure styles tested). **Residual:** the vault repayment still needs a working token, so an issuer pause or a blacklisting of the vault/escrow still blocks advanced-invoice settlement; claims for a permanently blocked address stay stuck by design. | **Mitigated (D4)**; residual documented |
| S-08 | **Medium (external)** | **Clawback from the escrow** leaves it insolvent: repayments revert atomically with no partial effect, and refund rulings now succeed but the client's claim reverts until the escrow is topped up (tested); after a top-up everything settles. Clawback from the vault lowers NAV with the real balance and never breaks accounting (tested). | Documented |
| S-09 | Low | **`setEscrow` does not authenticate the escrow**, it only catches miswiring. A malicious admin could authorize a contract that mimics the four views. The NatSpec overclaimed; **corrected**. | Fixed (comment); deploy script must verify bytecode |
| S-10 | Low | Dust invoices: fee floors to 0 and a 1-wei invoice cannot be advanced. No minimum invoice size. | Open (A6 candidate) |
| S-11 | Medium | **Evaluator compromise is bounded**: ≤25% of NAV per invoice, ≤80% utilization, and it cannot profit without the operator (self-dealing best case is -30, abandoning -100; tested). It can lock capital (S-05). | Informational |
| S-12 | Medium (trust) | Pauser/operator can freeze LP exits indefinitely, and a lost operator key means nobody can unpause until the admin re-grants the role. | Documented |
| S-13 | Info | **Reentrancy: no vulnerability.** ERC-777-style hooks from every position (LP on deposit/redeem/withdraw/mint, freelancer on advance and settlement, client on funding and refund) cannot re-enter any state-changing function, and mid-callback views of NAV/price are consistent. Applies to hook-capable tokens; RLUSD is a plain ERC-20. | Verified by test |
| S-14 | Info | Fee-on-transfer: rejected at deposit, invoice funding and repayment. A token that turns fee-on-transfer *after* funding (RLUSD is upgradeable) would stick settlement, same class as S-07. | Documented |
| S-15 | Info | ERC-4626: with offset 6 the donation/inflation attack loses money for the attacker, many tiny cycles never profit (fuzz), `withdraw` rounds against the user, a 1-wei deposit into a loss-damaged vault stays 1 wei. | Verified by test |
| S-16 | Low | **Donations into a near-empty vault are mostly unowned.** ERC-4626 virtual shares hold `1e6 / (supply + 1e6)` of NAV, so a donation made while (almost) no shares exist is absorbed by that virtual position and cannot be redeemed by any LP; the next depositor gets fair value only for their own money. With a healthy supply this is dust. It conflicts with the *spirit* of A1.5 decision 4 ("do not silently strand donations"), but only when every LP has exited, and the donor loses their own tokens. Found by A6 fuzzing. | **Open, decision D7** |
| S-17 | Low (liveness) | **Share supply inflates after a total wipe-out.** When NAV reaches ~0 with shares outstanding, the next deposit mints `assets * (supply + 1e6) / (NAV + 1)` shares, multiplying the supply by ~the deposit size in wei. A few wipe-outs with recoveries exhaust 256 bits and new deposits revert; funds are never lost and redemptions still work. A single wipe-out is fine (tested). Found by A6 fuzzing. | **Accepted limitation** (needs a total loss of the whole vault, repeatedly) |

### Vulnerabilities fixed in A5

None in contract logic were found exploitable. Changes made: corrected the `setEscrow` NatSpec overclaim (S-09) and removed two stale comments in `DuelyVault.sol`. No behavior changed.

## 3. Determinations requested in the scope

**Pause behavior (scope 3), verified for all four pause states.** (Refund rulings and remainders are now credits; claims are never affected by the vault's pause flags.)
New advances are blocked by either pause. LP deposit/mint/withdraw/redeem are blocked only by the full pause. Settlement (advanced and plain), release and refund rulings, repayment and loss finalization are **never** blocked; the vault records the loss while paused.

**Risk limits after withdrawals (scope 6).** The funding limits use current NAV at every funding (after a withdrawal the caps shrink; tested). **From A5.5 withdrawals are also bounded by the 80% utilization cap (D3).**

**Disputed-advance NAV risk (scope 7), determination: no on-chain restriction is added in A5.** Reasons: (1) a freeze needs a new escrow→vault signal, a new advance status and a new vault state: an interface change for Person B; (2) a *global* freeze lets any client with an advanced invoice freeze every LP's exit for as long as the operator takes to rule (a griefing vector); (3) it does not beat a redemption already in the same block or mempool; (4) the alternative that avoids the freeze (pricing redemptions net of disputed principal) is impairment accounting, which was not approved. What works today without code: the pauser can pause LP flows when `InvoiceDisputed` appears; resolution and refunds still work while paused (tested), and the operator unpauses afterwards.

## 4. Decision record (A5.5)

| # | Decision | Outcome |
|---|---|---|
| **D1** | LP exits during a dispute | **Operational runbook only.** No automatic freeze, no impairment accounting. See §4.1. |
| **D2** | Fee sniping | **Acknowledged MVP risk.** No holding period, no exit fee. |
| **D3** | Withdrawals vs the 80% cap | **Implemented.** `withdrawableLiquidity() = max(0, cash − ceil(P/4))`; `maxRedeem`/`maxWithdraw` derive from it with conservative rounding. |
| **D4** | Settlement depending on payee transfers | **Implemented.** Remainders and refunds are credited and reserved in the escrow; permissionless `claim(recipient)` pays only the recipient; failed claims keep the credit. |
| **D5** | Admin power | **Testnet roles unchanged.** A multisig/timelock admin and stronger controls are required before production. |
| **D6** | Stuck invoices | **No timeout** until a dispute/expiry policy is specified. |
| **D7** (A6, open) | Donations into an empty vault (S-16) | Not decided. Recommended: the deployer seeds the vault with a small deposit whose shares are sent to a dead address (for example 1 RLUSD), so supply is never near zero and the unowned fraction is ~1e-18. Costs the deployer that deposit; does not address S-17. |

### 4.1 D1 runbook: operator pause for disputed advances

1. **Detect.** The backend/monitoring service watches the escrow's `InvoiceDisputed(invoiceId, client, advanceAlreadyPaid)`. Only events with `advanceAlreadyPaid > 0` matter: no advance means no LP exposure.
2. **Pause.** The **pauser** key calls `vault.pause()` (blocks deposits, mints, withdrawals, redemptions and new advances) or, if only new advances should stop, `vault.pauseAdvances()`. The pauser can pause but not unpause.
3. **Rule.** The **operator** calls `escrow.resolveDispute(invoiceId, releaseToFreelancer)`. Resolution, repayment, loss recognition and claims are never blocked by the vault's pause flags.
4. **Unpause.** The **operator** calls `vault.unpause()` (and `unpauseAdvances()` if it was set). Several concurrent disputes: unpause only when none is open.
5. **Limits of this control.** It cannot stop a redemption included in the same block as, or ahead of, the dispute; it blocks deposits as well as exits while paused; its speed depends on the monitor and the keys; and a pauser or operator can freeze LP exits indefinitely (S-12). It is a manual, discretionary control, not an on-chain guarantee, and it does not change how the advance is valued (par until the ruling).

## 5. Remaining risks by severity

**High:** S-04 admin self-grant (D5); S-05 no timeout / capital lock (D6); S-06 operator discretion.
**Medium:** S-07 issuer pause/blacklist of the vault or escrow (residual after D4); S-01 fee sniping (D2); S-02 informed exit (D1); S-08 clawback; S-11 evaluator griefing; S-12 pause DoS.
**Low:** S-03 per-invoice concentration after exits (residual after D3); S-09 `setEscrow` authentication; S-10 dust invoices; S-16 donations into an empty vault; S-17 supply inflation after repeated wipe-outs.
**Info:** S-13 to S-15 (verified safe).

Also still **not** covered: the full invariant suite and extended fuzzing (A6), the deploy script and ABI handoff, and an external audit.

## 6. Tests

`test/DuelyV2Reentrancy.t.sol` (9 tests) and `test/DuelyV2Security.t.sol` (25 tests, two of them fuzz), with helper contracts `HookToken`, `HookAttacker`, `BlacklistToken` in `test/mocks/`. They cover:

- the role-by-function authorization matrix (every actor against every privileged call, success iff authorized);
- all four pause states;
- reentrancy from every position;
- blacklist (both failure styles), clawback (vault and escrow) and issuer pause;
- ERC-4626 donation, tiny-cycle, rounding and post-loss attacks;
- solvency checks (escrow balance ≥ liabilities, no standing allowance) across a mixed multi-invoice sequence;
- pinned documented weaknesses (S-01, S-02, S-03, S-04, S-05) and the self-dealing economics.

**A5.5 additions** (suite total 256 tests, all passing):

- `test/DuelyVaultWithdrawalCap.t.sol` (15 tests, 3 fuzz): exact buffer rounding (`ceil(P/4)`), at/above/just below the cap, redeem/withdraw tightness at the boundary, pause, deposits restoring room, utilization after any withdrawal (fuzz), dust exits at the boundary (fuzz), and real-escrow flows including a clawback pushing utilization above the cap.
- `test/InvoiceAdvanceV2Claims.t.sol` (14 tests, 1 fuzz): credits and reserved balance at every step, permissionless claim paying only the recipient, double/unknown claims, aggregation across invoices and roles, issuer pause keeping credits, vault pause independence, stray tokens never claimable, and a fuzz that claims equal credits exactly.
- Existing tests updated for the intentional behavior changes (settlement and refund now credit; exits capped): `InvoiceAdvanceV2.t.sol`, `DuelyVault.t.sol`, `DuelyV2Security.t.sol`, `DuelyV2Reentrancy.t.sol` (reentrancy now exercised through `claim`, including a double-claim attempt).
- Mutation checks: restoring `withdrawable = cash` fails 16 tests; letting `claim` pay the caller fails 20.

## 7. A6: stateful and fuzz verification

**Result:** no defect was found in the contract logic. The work found and fixed several weaknesses in the *test suite itself* (below), two low-severity economic edge cases (S-16, S-17), and one redundant guard. Nothing in the financial model changed.

### 7.1 New test files

| File | Tests | What it is |
|---|---:|---|
| `test/invariant/V2Handler.sol` | n/a | Stateful handler with an independent ghost model. 21 randomized actions: LP deposit/redeem/withdraw/transfer/round-trip, invoice create/cancel/fund/advance/boundary-advance/approve, dispute and both rulings, claims, donations, issuer pause/blacklist/clawback, pause operations, hostile callers, duplicate attempts. Every action predicts its own outcome from the model and records a *violation* instead of reverting, so the suite runs under `fail_on_revert`. |
| `test/invariant/V2Invariants.t.sol` | 3 (26 invariant checks + 1 scripted) | `V2InvariantsTest` and `V2InvariantsEscrowClawbackTest` (13 invariants each; the second also lets the issuer claw back from the escrow) and `V2HandlerReachabilityTest` (a scripted run proving every outcome is reachable, so the suite cannot be vacuous). Foundry counts each invariant contract as one test in its totals. |
| `test/DuelyV2Fuzz.t.sol` | 11 | Targeted fuzz: rounding boundaries (previews equal execution after arbitrary histories), round trips, conversions, four LPs with sequential profits/losses/donations/exits, proportional sharing, donations, issuer clawback with open advances, failed token transfers (9 operations x 2 failure styles), pause guards at zero amounts, and two `KNOWN` tests. |
| `test/mocks/ChaosToken.sol` | n/a | RLUSD-shaped token with issuer pause, blacklist and clawback. |
| `test/DuelyV2Security.t.sol` | 32 (was 26) | Six new `KNOWN` tests; one tightened (see 7.4). |

Suite total: **276 tests, 20 suites, all passing** at default settings.

### 7.2 Invariants (asserted after every call of every random sequence)

| # | Invariant | Where |
|---|---|---|
| 1 | Every action's outcome matches the model: authorization, pause behavior, expected reverts and successes, exact deltas, rounding direction, one-shot (duplicate) protection | `modelAgreesWithTheContracts` |
| 2 | NAV = actual RLUSD cash + outstanding principal; `availableLiquidity` = token balance | `navIsCashPlusPrincipal` |
| 3 | Outstanding principal = sum of open advances = ghost model | `principalEqualsSumOfOpenAdvances` |
| 4 | Fees and losses recognized exactly once; one state per funded advance; terminal states carry exactly the right fields | `feesAndLossesRecognizedExactlyOnce` |
| 5 | Escrow and vault ledgers match the ghost state machine for every invoice | `ledgersMatchTheGhostStateMachine` |
| 6 | Utilization <= 80% in every reachable state unless the issuer clawed back from the vault; every successful withdrawal/advance also checked in the handler | `utilizationWithinCapUnlessClawedBack` |
| 7 | Above the cap: nothing can be withdrawn or advanced | `aboveTheCapNothingLeavesAndNothingIsAdvanced` |
| 8 | Escrow balance >= totalEscrow + totalClaimable (exempt only after an issuer clawback from the escrow); totalEscrow = funded unsettled invoices; no standing allowance | `escrowSolvency` |
| 9 | Credits = claims + outstanding claimable, per actor and in total | `creditsEqualClaimsPlusOutstanding` |
| 10 | ERC-4626: conversions and previews round against the user, limits <= the cap <= cash, no holder worth more than NAV, share solvency | `erc4626RoundingAndLimits` |
| 11 | Shares are fully accounted for by the holders | `shareSupplyEqualsHolderBalances` |
| 12 | RLUSD conserved across every actor and both contracts: balances sum to supply = minted - clawed back | `conservationOfRLUSD` |
| 13 | Pause flags equal the model; nobody gained a role | `pauseStateAndRolesMatchTheModel` |

"Risk-limit changes where authorized": the limits are compile-time constants and no setter exists, so there is nothing to change; the handler attacks every role-gated function and `setEscrow` instead.

### 7.3 Mutation testing (does the suite fail when the contracts are wrong?)

23 targeted mutations of `DuelyVault.sol` and `InvoiceAdvanceV2.sol`, each run against the invariant suite with a baseline check first (a campaign aborts if the unmutated suite fails). **22 are killed by the invariant suite; the 23rd (M19) is killed by a targeted test.** Killed: skipping the utilization cap; repayment not lowering principal or not counting the fee; loss not counted; uncapped withdrawals; NAV ignoring principal; `maxRedeem` ignoring pause; duplicate advance allowed; pause open to anyone; pauser able to unpause; `fundAdvance` open to any caller; claim not zeroing the credit; credits missing from `totalClaimable` or one wei too large; `approveAdvance` not evaluator-gated; refund skipping loss finalization; funding not booking escrow; anyone able to approve; skipped Open/status checks on repayment, approval, ruling and funding. M19 (`withdraw` without the pause modifier) is functionally redundant for any non-zero amount, because `maxWithdraw` is already 0 while paused; only a zero-amount call differs, and `test_fullPause_blocksEveryEntryPoint_evenWithZeroAmounts` kills it.

**Test-suite weaknesses found and fixed during A6** (none was a contract defect):
- Three mutations first *survived* (skipping the utilization cap, duplicate advances, unauthorized `fundAdvance`). Cause: vault too large for the limits to be reachable, and probes using terms the vault would refuse anyway, so the guard under test never decided the outcome. Fixed with a smaller vault, a boundary-targeting action, and probes with otherwise-valid terms.
- A handler change briefly made the *baseline* revert under `fail_on_revert`, which made a whole mutation batch look "killed" for the wrong reason. Fixed, and the runner now aborts if the baseline fails.
- `test_KNOWN_stuckInvoice_hasNoTimeout` used a bare `expectRevert()` and passed for the wrong reason for three of its four callers (they lacked the operator role rather than the invoice being undisputed). Now asserts the exact errors.
- Test-side arithmetic overflow on astronomically large share counts (the S-17 effect) replaced with exact 512-bit comparisons.

### 7.4 Audit of the `test_KNOWN_*` tests

Each `KNOWN` test asserts that a **risk exists**; passing is never a security property, and a future mitigation makes it fail on purpose.

| Test | Documents | Asserts | Review |
|---|---|---|---|
| `jitDepositCapturesTheFee` | S-01 | sniper takes >29 of 30 fee, honest LPs gain <1 | Documents the exploit. OK |
| `informedLpExitsBeforeDisputedLossIsRecognized` | S-02 | exit at par up to the cap; remaining LP loses >100 more than fair | OK |
| `adminCanSelfGrantEveryRole` | S-04 | self-grant succeeds and the roles work | OK |
| `stuckInvoice_hasNoTimeout` | S-05 | after 5 years only the client can settle; principal still open | **Was weak** (passed for wrong reasons); now exact errors |
| `perInvoiceConcentrationCanExceed25PercentAfterExits` (new) | S-03 residual | one advance >25% of NAV after exits | Previously buried inside a guarantee test; split out |
| `issuerPauseBlocksSettlementOfAdvancedInvoices` (new) | S-07 residual | advanced settlement reverts under an issuer pause; no-advance settlement does not | New |
| `clawbackFromEscrowCanLeaveACreditUnpayable` (new) | S-08 | escrow insolvent against credits; record survives | New |
| `depositorDuringADisputeInheritsPartOfTheLoss` (new) | S-02 mirror | late depositor absorbs part of the loss | New |
| `pauseCanFreezeExitsIndefinitely` (new) | S-12 | pause lasts 5 years; pauser cannot lift it | New |
| `operatorRulingIsUnconstrainedOnChain` (new) | S-06 | operator can rule either way on the same kind of invoice | New |
| `donationIntoAnEmptyVaultIsMostlyAbsorbedByTheVirtualPosition` (new) | S-16 | donation unredeemable | New |
| `repeatedTotalWipeOutsEventuallyBlockNewDeposits` (new) | S-17 | deposits eventually revert | New |

Non-`KNOWN` tests that could be misread as guarantees now say so in their NatSpec: the pause-on-dispute test is "NOT a guarantee" (favorable case only), the self-dealing test is "CONDITIONAL" (honest operator assumed), the utilization-cap test states it says nothing about per-invoice concentration.

### 7.5 Running it

> **Status: the `deep` profile run was cancelled before it completed (A6 was stopped to prioritize the hackathon MVP), so there is NO result at the 5,000-fuzz / 400x200-invariant level.** Everything reported here was verified at the default settings (128 runs x depth 100 for the invariants, 256 for fuzz). The profile exists in `foundry.toml` and is unused unless invoked.

```
cd contracts
forge fmt --check && forge build && forge test                       # default: 128 runs x depth 100
FOUNDRY_PROFILE=deep forge test                                      # 5,000 fuzz runs; 400 invariant runs x depth 200
FOUNDRY_PROFILE=deep forge test --match-path test/invariant/V2Invariants.t.sol -vv   # also prints the call mix
```

### 7.6 Remaining risks before testnet deployment

Unchanged from §5 plus S-16/S-17, and these deployment-time items that no test here covers: the deploy script and its verification (RLUSD address/symbol/decimals, distinct roles, escrow bytecode, one-time `setEscrow`), admin/operator/pauser/evaluator key custody (S-04, D5), the off-chain evaluator and monitoring runbook (D1), RLUSD's real issuer behavior on XRPL EVM testnet (pause, blacklist, clawback and upgrade were only modeled), testnet RLUSD liquidity for the 25% exposure rule, and an independent audit. The invariant suite exercises a model of RLUSD, not the live token.
