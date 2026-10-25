// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DuelyVault} from "../src/DuelyVault.sol";
import {IDuelyVault} from "../src/IDuelyVault.sol";
import {InvoiceAdvanceV2} from "../src/InvoiceAdvanceV2.sol";
import {IInvoiceAdvanceV2} from "../src/IInvoiceAdvanceV2.sol";
import {DuelyVaultHarness} from "./mocks/DuelyVaultHarness.sol";
import {ChaosToken} from "./mocks/ChaosToken.sol";

/// A6: targeted fuzz tests for rounding boundaries, multiple LPs, sequential profits and losses,
/// donations, clawbacks and failed token transfers.
///
/// Part 1 uses the test-only harness (`DuelyVaultHarness`) so the vault's principal, fees and losses can
/// be driven to arbitrary values; part 2 uses the real escrow end to end.
contract DuelyV2FuzzTest is Test {
    uint256 internal constant E18 = 1e18;
    uint256 internal constant OFFSET = 1e6;
    bytes32 internal constant META = keccak256("agreement");
    bytes32 internal constant EVAL = keccak256("evaluation");

    ChaosToken internal tok;
    DuelyVaultHarness internal hv; // part 1
    DuelyVault internal vault; // part 2
    InvoiceAdvanceV2 internal escrow;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal pauser = makeAddr("pauser");
    address internal evaluator = makeAddr("evaluator");
    address internal sink = makeAddr("sink");
    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal attacker = makeAddr("attacker");
    address[4] internal lps;

    function setUp() public {
        tok = new ChaosToken();
        hv = new DuelyVaultHarness(IERC20(address(tok)), admin, operator, pauser);
        vault = new DuelyVault(IERC20(address(tok)), admin, operator, pauser);
        escrow = new InvoiceAdvanceV2(
            IERC20(address(tok)), IDuelyVault(address(vault)), admin, operator, evaluator
        );
        vm.prank(admin);
        vault.setEscrow(address(escrow));
        for (uint256 i; i < 4; i++) {
            lps[i] = makeAddr(string.concat("lp", vm.toString(i)));
        }
        _approveAll(attacker);
        _approveAll(client);
        for (uint256 i; i < 4; i++) {
            _approveAll(lps[i]);
        }
    }

    // ------------------------------------------------------------------ helpers

    function _approveAll(address who) internal {
        vm.startPrank(who);
        tok.approve(address(hv), type(uint256).max);
        tok.approve(address(vault), type(uint256).max);
        tok.approve(address(escrow), type(uint256).max);
        vm.stopPrank();
    }

    function _dep(DuelyVault v, address who, uint256 amount) internal returns (uint256 shares) {
        tok.mint(who, amount);
        vm.startPrank(who);
        tok.approve(address(v), type(uint256).max);
        shares = v.deposit(amount, who);
        vm.stopPrank();
    }

    function _price(DuelyVault v) internal view returns (uint256 nav, uint256 supply) {
        nav = v.totalAssets();
        supply = v.totalSupply();
    }

    /// @dev a*b < c*d computed exactly in 512 bits (supply can be astronomically large after a wipe-out,
    /// so a plain 256-bit product could overflow).
    function _mulLt(uint256 a, uint256 b, uint256 c, uint256 d) internal pure returns (bool) {
        (uint256 h1, uint256 l1) = Math.mul512(a, b);
        (uint256 h2, uint256 l2) = Math.mul512(c, d);
        return h1 < h2 || (h1 == h2 && l1 < l2);
    }

    /// @dev (nav1+1)/(s1+1e6) >= (nav0+1)/(s0+1e6), exactly.
    function _priceUp(uint256 nav0, uint256 s0, uint256 nav1, uint256 s1)
        internal
        pure
        returns (bool)
    {
        return !_mulLt(nav1 + 1, s0 + OFFSET, nav0 + 1, s1 + OFFSET);
    }

    function _priceDown(uint256 nav0, uint256 s0, uint256 nav1, uint256 s1)
        internal
        pure
        returns (bool)
    {
        return _mulLt(nav1 + 1, s0 + OFFSET, nav0 + 1, s1 + OFFSET);
    }

    /// @dev Drives the harness vault into an arbitrary history of deposits, gains, losses, donations and exits.
    function _history(uint256 seed, uint256 steps) internal {
        for (uint256 i; i < steps; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 k = r % 6;
            uint256 amt = 1 + (r >> 8) % (2000 * E18);
            address lp = lps[(r >> 4) % 4];
            if (k <= 1) {
                _dep(hv, lp, amt);
            } else if (k == 2) {
                tok.mint(address(hv), amt % (500 * E18)); // donation
            } else if (k == 3) {
                _gain(hv, amt);
            } else if (k == 4) {
                _loss(hv, amt);
            } else {
                uint256 m = hv.maxRedeem(lp);
                if (m > 0) {
                    vm.prank(lp);
                    hv.redeem(1 + (r >> 16) % m, lp, lp);
                }
            }
        }
    }

    /// @dev An advance of up to `want` repaid with a 3.33% fee.
    function _gain(DuelyVaultHarness v, uint256 want) internal {
        uint256 p = _clamp(v, want);
        if (p == 0) return;
        uint256 fee = p / 30;
        v.simulateAdvance(p, sink);
        tok.mint(address(v), p + fee); // repayment arrives
        v.simulateRepayment(p, fee);
    }

    /// @dev Losses here never take more than 90% of NAV, so random histories do not repeatedly wipe the
    /// vault out. A total wipe-out inflates the share supply beyond what these generic properties can
    /// handle (S-17); that case has its own dedicated KNOWN test below.
    function _loss(DuelyVaultHarness v, uint256 want) internal {
        uint256 p = _clamp(v, want);
        uint256 cap = v.totalAssets() * 9 / 10;
        if (p > cap) p = cap;
        if (p == 0) return;
        v.simulateAdvance(p, sink);
        v.simulateLoss(p);
    }

    function _clamp(DuelyVaultHarness v, uint256 want) internal view returns (uint256) {
        uint256 cash = tok.balanceOf(address(v));
        return want > cash ? cash : want;
    }

    // ================================================================== 1. rounding boundaries

    function testFuzz_previewsEqualExecution_andRoundAgainstTheUser(
        uint256 seed,
        uint96 amountA,
        uint96 sharesB
    ) public {
        _history(seed, 1 + seed % 8);
        _checkDeposit(bound(uint256(amountA), 1, 5000 * E18));
        _checkMint(bound(uint256(sharesB), 1, 5000 * E18 * 1e6));
        _checkRedeem(seed >> 8);
        _checkWithdraw(seed >> 16);
    }

    function _checkDeposit(uint256 amount) internal {
        address a = lps[0];
        tok.mint(a, 10 * amount);
        uint256 expectShares = hv.previewDeposit(amount);
        uint256 cash0 = tok.balanceOf(address(hv));
        vm.prank(a);
        uint256 minted = hv.deposit(amount, a);
        assertEq(minted, expectShares, "deposit mints exactly previewDeposit");
        assertEq(tok.balanceOf(address(hv)) - cash0, amount);
        assertLe(hv.previewMint(minted), amount, "the shares cost no more than what was paid");
    }

    function _checkMint(uint256 wantShares) internal {
        address a = lps[0];
        uint256 expectAssets = hv.previewMint(wantShares);
        tok.mint(a, expectAssets);
        uint256 balBefore = tok.balanceOf(a);
        vm.prank(a);
        uint256 paid = hv.mint(wantShares, a);
        assertEq(paid, expectAssets);
        assertEq(balBefore - tok.balanceOf(a), paid);
        assertGe(paid, hv.convertToAssets(wantShares), "mint never undercharges");
    }

    function _checkRedeem(uint256 s0) internal {
        address a = lps[0];
        uint256 max = hv.maxRedeem(a);
        if (max <= 1) return;
        uint256 s = 1 + s0 % max;
        uint256 expectOut = hv.previewRedeem(s);
        uint256 b0 = tok.balanceOf(a);
        vm.prank(a);
        uint256 out = hv.redeem(s, a, a);
        assertEq(out, expectOut);
        assertEq(tok.balanceOf(a) - b0, expectOut);
        assertLe(hv.previewWithdraw(expectOut), s, "withdrawing that much burns no more shares");
    }

    function _checkWithdraw(uint256 w0) internal {
        address a = lps[0];
        uint256 maxW = hv.maxWithdraw(a);
        if (maxW == 0) return;
        uint256 w = 1 + w0 % maxW;
        uint256 expectBurn = hv.previewWithdraw(w);
        assertGe(expectBurn, hv.convertToShares(w), "withdraw rounds shares up");
        uint256 sup0 = hv.totalSupply();
        vm.prank(a);
        assertEq(hv.withdraw(w, a, a), expectBurn);
        assertEq(sup0 - hv.totalSupply(), expectBurn);
    }

    /// Deposit-then-redeem of the same shares never pays more than was deposited, at any size, price
    /// level or history (one wei up to the cap).
    function testFuzz_roundTripNeverProfits_anyHistory(uint256 seed, uint96 amountA) public {
        _history(seed, seed % 9);
        uint256 amount = bound(uint256(amountA), 1, 3000 * E18);
        address a = lps[1];
        tok.mint(a, amount);
        vm.startPrank(a);
        tok.approve(address(hv), type(uint256).max);
        uint256 before = tok.balanceOf(a);
        uint256 shares = hv.deposit(amount, a);
        uint256 max = hv.maxRedeem(a);
        if (shares <= max) {
            hv.redeem(shares, a, a);
            assertLe(tok.balanceOf(a), before, "no profit from rounding");
        }
        vm.stopPrank();
    }

    /// The share/asset conversions are monotone and mutually consistent at every price.
    function testFuzz_conversionBoundaries(uint256 seed, uint256 x) public {
        _history(seed, 1 + seed % 8);
        x = bound(x, 0, type(uint96).max);
        assertLe(hv.convertToAssets(hv.convertToShares(x)), x);
        assertLe(hv.convertToShares(hv.convertToAssets(x)), x);
        assertGe(hv.previewMint(x), hv.previewRedeem(x));
        assertGe(hv.previewWithdraw(x), hv.previewDeposit(x));
        assertLe(hv.convertToShares(x), hv.convertToShares(x + 1), "monotone");
        assertLe(hv.convertToAssets(x), hv.convertToAssets(x + 1), "monotone");
    }

    // ================================================================== 2. multiple LPs, sequential profits and losses

    /// Four LPs deposit, exit, and watch fees, losses and donations arrive in a random order. At every
    /// step each LP's value is exactly its pro rata share of NAV, and share price moves only in the
    /// direction the event allows.
    function testFuzz_multiLp_sequentialProfitsAndLosses(uint256 seed) public {
        for (uint256 i; i < 14; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 k = r % 6;
            uint256 amt = 1 + (r >> 8) % (1500 * E18);
            address lp = lps[(r >> 4) % 4];
            (uint256 nav0, uint256 s0) = _price(hv);

            if (k <= 1) {
                _dep(hv, lp, amt);
                (uint256 n1, uint256 s1) = _price(hv);
                assertTrue(_priceUp(nav0, s0, n1, s1), "a deposit never dilutes");
            } else if (k == 2) {
                uint256 d = amt % (400 * E18);
                tok.mint(address(hv), d);
                (uint256 n1, uint256 s1) = _price(hv);
                assertEq(n1, nav0 + d, "a donation is counted exactly once");
                assertEq(s1, s0, "and mints no shares");
            } else if (k == 3) {
                _gain(hv, amt);
                (uint256 n1, uint256 s1) = _price(hv);
                assertTrue(_priceUp(nav0, s0, n1, s1), "a fee never lowers the price");
            } else if (k == 4) {
                uint256 before = hv.outstandingPrincipal();
                _loss(hv, amt);
                (uint256 n1, uint256 s1) = _price(hv);
                if (hv.totalRealizedLosses() > 0 && n1 < nav0) {
                    assertTrue(_priceDown(nav0, s0, n1, s1), "a loss lowers the price");
                }
                assertEq(hv.outstandingPrincipal(), before, "the loss left no principal behind");
            } else {
                uint256 m = hv.maxRedeem(lp);
                if (m > 0) {
                    vm.prank(lp);
                    hv.redeem(1 + (r >> 16) % m, lp, lp);
                    (uint256 n1, uint256 s1) = _price(hv);
                    assertTrue(
                        _priceUp(nav0, s0, n1, s1), "an exit never lowers the price for the others"
                    );
                }
            }
            _assertProRata();
        }
    }

    /// Every LP's value is floor(shares * (NAV+1) / (supply + 1e6)), they sum to at most NAV, and the
    /// shortfall is only the virtual position's rounding dust.
    function _assertProRata() internal view {
        uint256 nav = hv.totalAssets();
        uint256 supply = hv.totalSupply();
        assertEq(nav, tok.balanceOf(address(hv)) + hv.outstandingPrincipal());
        uint256 sum;
        for (uint256 i; i < 4; i++) {
            uint256 sh = hv.balanceOf(lps[i]);
            uint256 v = hv.convertToAssets(sh);
            assertEq(v, Math.mulDiv(sh, nav + 1, supply + OFFSET), "exact pro rata value");
            sum += v;
        }
        assertLe(sum, nav, "LPs together are never worth more than NAV");
        // The only NAV not owned by an LP is the ERC-4626 virtual position: exactly
        // NAV * 1e6 / (supply + 1e6), plus at most one wei of rounding per holder. With a healthy supply
        // that is dust; with a near-empty supply it can be most of NAV (see the KNOWN test below).
        uint256 virtualPosition = nav * OFFSET / (supply + OFFSET);
        assertLe(
            nav - sum,
            virtualPosition + 5,
            "unowned NAV is exactly the virtual position (+ rounding)"
        );
    }

    /// Profit and loss are shared in proportion to shares: two LPs with the same shares always have the
    /// same value, and one with twice the shares has (up to rounding) twice the value, after any sequence.
    function testFuzz_proportionalSharing(uint96 d, uint256 seed) public {
        uint256 amt = bound(uint256(d), 1000, 1000 * E18);
        _dep(hv, lps[0], amt);
        _dep(hv, lps[1], amt);
        _dep(hv, lps[2], 2 * amt);
        for (uint256 i; i < 6; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            if (r % 3 == 0) _gain(hv, 1 + (r >> 8) % (1500 * E18));
            else if (r % 3 == 1) _loss(hv, 1 + (r >> 8) % (400 * E18));
            else tok.mint(address(hv), (r >> 8) % (100 * E18));
        }
        uint256 v0 = hv.convertToAssets(hv.balanceOf(lps[0]));
        uint256 v1 = hv.convertToAssets(hv.balanceOf(lps[1]));
        uint256 v2 = hv.convertToAssets(hv.balanceOf(lps[2]));
        assertEq(hv.balanceOf(lps[0]), hv.balanceOf(lps[1]));
        assertEq(v0, v1, "equal shares, equal value");
        assertApproxEqAbs(v2, 2 * v0, 2, "double the shares, double the value");
    }

    // ================================================================== 3. donations

    /// A donation never mints shares, and an attacker who front-runs a victim with a tiny deposit plus a
    /// donation never ends up with more than they started with, at any sizes.
    function testFuzz_donations_neverMintSharesOrProfitTheAttacker(
        uint96 seedDeposit,
        uint96 donation,
        uint96 victimDeposit
    ) public {
        uint256 a = bound(uint256(seedDeposit), 1, 1000 * E18);
        uint256 d = bound(uint256(donation), 0, 5000 * E18);
        uint256 v = bound(uint256(victimDeposit), 1, 5000 * E18);
        tok.mint(attacker, a + d);
        uint256 start = tok.balanceOf(attacker);
        vm.startPrank(attacker);
        uint256 shares = hv.deposit(a, attacker);
        uint256 supply0 = hv.totalSupply();
        tok.transfer(address(hv), d);
        vm.stopPrank();
        assertEq(hv.totalSupply(), supply0, "the donation minted no shares");

        uint256 victim = _dep(hv, lps[0], v);
        // the victim is never rounded to nothing unless their deposit is below one share-wei's worth
        if (v * (hv.totalSupply() + OFFSET) > hv.totalAssets() + 1) {
            assertGt(victim, 0);
        }
        assertLe(hv.convertToAssets(victim), v, "the victim is never credited more than they paid");

        vm.startPrank(attacker);
        uint256 max = hv.maxRedeem(attacker);
        hv.redeem(shares < max ? shares : max, attacker, attacker);
        vm.stopPrank();
        assertLe(tok.balanceOf(attacker), start, "the attacker never profits");
    }

    // ================================================================== 4. clawbacks (real escrow)

    function _realInvoice(uint256 amount, bool advance) internal returns (uint256 id) {
        tok.mint(client, amount);
        vm.prank(client);
        id = escrow.createInvoice(freelancer, amount, META);
        vm.prank(client);
        escrow.fundInvoice(id);
        if (advance) {
            vm.prank(evaluator);
            escrow.approveAdvance(id, EVAL);
        }
    }

    /// An issuer clawback from the vault at any size, with any number of advances open: NAV stays
    /// cash + principal, exits stay under the 80% cap (and lock when it is breached), and the invoices
    /// still settle with correct fee and loss accounting.
    function testFuzz_clawbackFromVault_keepsAccountingAndTheCapConsistent(
        uint96 claw,
        uint8 advances,
        bool refundLast
    ) public {
        _dep(vault, lps[0], 3000 * E18);
        _dep(vault, lps[1], 1000 * E18);
        uint256 n = bound(uint256(advances), 1, 3);
        uint256[3] memory ids;
        for (uint256 i; i < n; i++) {
            ids[i] = _realInvoice(900 * E18, true);
        }
        uint256 cash = tok.balanceOf(address(vault));
        tok.clawback(address(vault), bound(uint256(claw), 0, cash));

        assertEq(vault.totalAssets(), tok.balanceOf(address(vault)) + vault.outstandingPrincipal());
        bool above = vault.outstandingPrincipal() * 10_000 > 8000 * vault.totalAssets();
        if (above) {
            assertEq(vault.maxRedeem(lps[0]), 0);
            assertEq(vault.maxAdvanceNow(), 0);
        }
        for (uint256 i; i < 2; i++) {
            uint256 m = vault.maxRedeem(lps[i]);
            if (m > 0) {
                vm.prank(lps[i]);
                vault.redeem(m, lps[i], lps[i]);
                assertLe(vault.outstandingPrincipal() * 10_000, 8000 * vault.totalAssets());
            }
        }
        // settle everything: all but (optionally) the last are approved, the last may be refunded
        uint256 fees;
        uint256 losses;
        for (uint256 i; i < n; i++) {
            if (refundLast && i == n - 1) {
                vm.prank(client);
                escrow.raiseDispute(ids[i]);
                vm.prank(operator);
                escrow.resolveDispute(ids[i], false);
                losses += 810 * E18;
            } else {
                vm.prank(client);
                escrow.approveCompletion(ids[i]);
                fees += 27 * E18;
            }
        }
        assertEq(vault.outstandingPrincipal(), 0);
        assertEq(vault.totalFeesEarned(), fees);
        assertEq(vault.totalRealizedLosses(), losses);
        assertEq(vault.totalAssets(), tok.balanceOf(address(vault)));
    }

    // ================================================================== 5. failed token transfers leave no trace

    function _digest(uint256 lastId) internal view returns (bytes32) {
        bytes32 balances = keccak256(
            abi.encode(
                tok.balanceOf(address(vault)),
                tok.balanceOf(address(escrow)),
                tok.balanceOf(lps[0]),
                tok.balanceOf(client),
                tok.balanceOf(freelancer)
            )
        );
        bytes32 vaultBooks = keccak256(
            abi.encode(
                vault.totalAssets(),
                vault.totalSupply(),
                vault.outstandingPrincipal(),
                vault.totalFeesEarned(),
                vault.totalRealizedLosses()
            )
        );
        bytes32 escrowBooks = keccak256(
            abi.encode(
                escrow.totalEscrow(),
                escrow.totalClaimable(),
                escrow.claimable(freelancer),
                escrow.claimable(client)
            )
        );
        bytes32 h = keccak256(abi.encode(balances, vaultBooks, escrowBooks));
        for (uint256 id = 1; id <= lastId; id++) {
            h = keccak256(abi.encode(h, escrow.getInvoice(id), vault.getAdvance(id)));
        }
        return h;
    }

    function testFuzz_failedTokenTransfers_leaveNoTrace(uint8 opSeed, uint8 modeSeed) public {
        uint256 op = bound(uint256(opSeed), 0, 8);
        uint256 mode = bound(uint256(modeSeed), 0, 1); // 0: issuer pause, 1: blacklist
        uint256[5] memory inv = _failureFixture();
        _breakToken(op, mode);

        (address caller, address target, bytes memory data, bool needsTokens) = _buildOp(op, inv);
        bytes32 before = _digest(inv[4]);
        vm.prank(caller);
        (bool ok,) = target.call(data);
        if (needsTokens) {
            assertFalse(ok, "a token-dependent call must fail when the token refuses");
            assertEq(_digest(inv[4]), before, "and leave no trace");
        } else {
            assertTrue(ok, "a call that moves no tokens is unaffected by the token");
        }

        // Once the token works again the same call succeeds (nothing was destroyed).
        _healToken();
        if (needsTokens) {
            vm.prank(caller);
            (ok,) = target.call(data);
            assertTrue(ok, "retry succeeds after the token recovers");
        }
    }

    /// @dev inv[0] Funded, inv[1] Advanced, inv[2] Advanced+Disputed, inv[3] settled (credits the
    /// freelancer 500), inv[4] Created.
    function _failureFixture() internal returns (uint256[5] memory inv) {
        _dep(vault, lps[0], 6000 * E18);
        inv[0] = _realInvoice(1000 * E18, false);
        inv[1] = _realInvoice(1000 * E18, true);
        inv[2] = _realInvoice(1000 * E18, true);
        vm.prank(client);
        escrow.raiseDispute(inv[2]);
        inv[3] = _realInvoice(500 * E18, false);
        vm.prank(client);
        escrow.approveCompletion(inv[3]);
        tok.mint(client, 1000 * E18);
        vm.prank(client);
        inv[4] = escrow.createInvoice(freelancer, 1000 * E18, META);
        tok.mint(lps[0], 10 * E18);
        vm.prank(lps[0]);
        tok.approve(address(vault), type(uint256).max);
    }

    function _breakToken(uint256 op, uint256 mode) internal {
        if (mode == 0) {
            tok.setPaused(true);
        } else if (op <= 2) {
            tok.setBlacklisted(lps[0], true);
        } else if (op == 3 || op == 7) {
            tok.setBlacklisted(client, true); // for op 7 the refund is only credited: must still work
        } else if (op == 4 || op == 8) {
            tok.setBlacklisted(freelancer, true);
        } else {
            tok.setBlacklisted(address(vault), true); // repayments to the vault fail
        }
    }

    function _healToken() internal {
        tok.setPaused(false);
        tok.setBlacklisted(lps[0], false);
        tok.setBlacklisted(client, false);
        tok.setBlacklisted(freelancer, false);
        tok.setBlacklisted(address(vault), false);
    }

    function _buildOp(uint256 op, uint256[5] memory inv)
        internal
        returns (address caller, address target, bytes memory data, bool needsTokens)
    {
        needsTokens = true;
        if (op == 0) {
            return (lps[0], address(vault), abi.encodeCall(vault.deposit, (1 * E18, lps[0])), true);
        } else if (op == 1) {
            return
                (lps[0], address(vault), abi.encodeCall(vault.redeem, (1e12, lps[0], lps[0])), true);
        } else if (op == 2) {
            return
                (
                    lps[0],
                    address(vault),
                    abi.encodeCall(vault.withdraw, (1e6, lps[0], lps[0])),
                    true
                );
        } else if (op == 3) {
            return (client, address(escrow), abi.encodeCall(escrow.fundInvoice, (inv[4])), true);
        } else if (op == 4) {
            return (
                evaluator,
                address(escrow),
                abi.encodeCall(escrow.approveAdvance, (inv[0], EVAL)),
                true
            );
        } else if (op == 5) {
            return
                (client, address(escrow), abi.encodeCall(escrow.approveCompletion, (inv[1])), true);
        } else if (op == 6) {
            return (
                operator,
                address(escrow),
                abi.encodeCall(escrow.resolveDispute, (inv[2], true)),
                true
            );
        } else if (op == 7) {
            return (
                operator,
                address(escrow),
                abi.encodeCall(escrow.resolveDispute, (inv[2], false)),
                false
            );
        }
        return
            (
                makeAddr("stranger"),
                address(escrow),
                abi.encodeCall(escrow.claim, (freelancer)),
                true
            );
    }

    // ================================================================== 6. pause guards at the boundary

    /// Every LP entry point reverts with the pause error under a full pause, EVEN FOR ZERO AMOUNTS. (For
    /// non-zero amounts `maxDeposit/maxMint/maxWithdraw/maxRedeem == 0` already blocks them; the explicit
    /// guard is what stops the zero-amount no-ops, so removing it must be noticed.)
    function test_fullPause_blocksEveryEntryPoint_evenWithZeroAmounts() public {
        _dep(vault, lps[0], 1000 * E18);
        vm.prank(pauser);
        vault.pause();
        vm.startPrank(lps[0]);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(0, lps[0]);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.mint(0, lps[0]);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.withdraw(0, lps[0], lps[0]);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.redeem(0, lps[0], lps[0]);
        vm.stopPrank();
    }

    /// KNOWN (conflicts with the spirit of A1.5 decision 4, "do not silently strand donations"): ERC-4626
    /// virtual shares mean a donation into a vault with (almost) no shares outstanding is largely owned by
    /// nobody. The first depositor after it gets fair value for their OWN money but cannot redeem the
    /// donated amount. Only reachable when every LP has exited; a donor loses their own tokens.
    function test_KNOWN_donationIntoAnEmptyVaultIsMostlyAbsorbedByTheVirtualPosition() public {
        assertEq(hv.totalSupply(), 0);
        tok.mint(address(hv), 360 * E18); // donation to an empty vault
        assertEq(hv.totalAssets(), 360 * E18);
        _dep(hv, lps[0], 1000 * E18);
        uint256 owned = hv.convertToAssets(hv.balanceOf(lps[0]));
        // The depositor holds ~their own 1,000; the 360 donation is stuck in the virtual position.
        assertApproxEqAbs(owned, 1000 * E18, 1e18);
        assertGt(hv.totalAssets() - owned, 359 * E18, "the donation is not redeemable by anyone");
    }

    /// KNOWN (limitation): when NAV falls to ~0 while shares remain, the next depositor receives shares at
    /// `assets * (supply + 1e6) / (NAV + 1)`, i.e. the supply is multiplied by roughly the deposit size in
    /// wei. Each total wipe-out followed by a recovery therefore inflates the share supply by ~1e21; after a
    /// few cycles the supply no longer fits in 256 bits and deposits revert. Funds are never lost (existing
    /// holders keep their claim, redemptions still work) but a repeatedly wiped-out vault cannot be refilled.
    function test_KNOWN_repeatedTotalWipeOutsEventuallyBlockNewDeposits() public {
        uint256 cycles;
        bool blocked;
        for (uint256 i; i < 6 && !blocked; i++) {
            tok.mint(lps[0], 1000 * E18);
            vm.startPrank(lps[0]);
            tok.approve(address(hv), type(uint256).max);
            try hv.deposit(1000 * E18, lps[0]) {
                cycles++;
            } catch {
                blocked = true;
            }
            vm.stopPrank();
            if (blocked) break;
            // wipe the vault out completely: advance all cash, then lose it
            uint256 cash = tok.balanceOf(address(hv));
            hv.simulateAdvance(cash, sink);
            hv.simulateLoss(cash);
            assertEq(hv.totalAssets(), 0);
        }
        assertTrue(blocked, "deposits eventually become impossible");
        assertLe(cycles, 5, "after only a handful of wipe-outs");
        assertGt(hv.totalSupply(), 1e60, "the supply has exploded");
    }
}
