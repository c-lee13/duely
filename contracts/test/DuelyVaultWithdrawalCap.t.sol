// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {DuelyVault} from "../src/DuelyVault.sol";
import {IDuelyVault} from "../src/IDuelyVault.sol";
import {InvoiceAdvanceV2} from "../src/InvoiceAdvanceV2.sol";
import {DuelyVaultHarness} from "./mocks/DuelyVaultHarness.sol";
import {RLUSDLikeToken} from "./mocks/RLUSDLikeToken.sol";

/// A5.5 / D3: withdrawals cannot push utilization above 80%. withdrawable = cash - ceil(P / 4).
contract DuelyVaultWithdrawalCapTest is Test {
    uint256 internal constant E18 = 1e18;
    bytes32 internal constant META = keccak256("agreement");
    bytes32 internal constant EVAL = keccak256("evaluation");

    RLUSDLikeToken internal rlusd;
    DuelyVaultHarness internal h; // formula tests: principal can be set to exact values
    DuelyVault internal vault; // integration tests: real escrow
    InvoiceAdvanceV2 internal escrow;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal pauser = makeAddr("pauser");
    address internal evaluator = makeAddr("evaluator");
    address internal lp1 = makeAddr("lp1");
    address internal lp2 = makeAddr("lp2");
    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal sink = makeAddr("sink");

    function setUp() public {
        rlusd = new RLUSDLikeToken();
        h = new DuelyVaultHarness(IERC20(address(rlusd)), admin, operator, pauser);
        vault = new DuelyVault(IERC20(address(rlusd)), admin, operator, pauser);
        escrow = new InvoiceAdvanceV2(
            IERC20(address(rlusd)), IDuelyVault(address(vault)), admin, operator, evaluator
        );
        vm.prank(admin);
        vault.setEscrow(address(escrow));
        rlusd.mint(client, 100_000 * E18);
        vm.prank(client);
        rlusd.approve(address(escrow), type(uint256).max);
    }

    function _dep(DuelyVault v, address who, uint256 amount) internal returns (uint256 shares) {
        rlusd.mint(who, amount);
        vm.startPrank(who);
        rlusd.approve(address(v), type(uint256).max);
        shares = v.deposit(amount, who);
        vm.stopPrank();
    }

    function _advanced(uint256 amount) internal returns (uint256 id) {
        vm.prank(client);
        id = escrow.createInvoice(freelancer, amount, META, 10_000);
        vm.prank(client);
        escrow.fundInvoice(id);
        vm.prank(evaluator);
        escrow.approveAdvance(id, EVAL);
    }

    /// @dev Exact integer form of "utilization <= 80%": P * 10000 <= 8000 * NAV.
    function _withinCap(DuelyVault v) internal view returns (bool) {
        return v.outstandingPrincipal() * 10_000 <= 8000 * v.totalAssets();
    }

    // ------------------------------------------------------------------ formula and rounding

    function test_noPrincipal_everythingIsWithdrawable() public {
        _dep(h, lp1, 1000 * E18);
        assertEq(h.withdrawableLiquidity(), 1000 * E18);
        assertEq(h.maxRedeem(lp1), h.balanceOf(lp1));
    }

    function test_bufferIsCeilOfQuarterOfPrincipal() public {
        _dep(h, lp1, 1000 * E18);
        uint256 cash = 1000 * E18;
        uint256[8] memory ps = [uint256(1), 2, 3, 4, 5, 8, 9, 400 * E18 + 1];
        uint256 spent;
        for (uint256 i; i < ps.length; i++) {
            // Move the principal to exactly ps[i] (it only ever increases here).
            h.simulateAdvance(ps[i] - spent, sink);
            spent = ps[i];
            uint256 buffer = (ps[i] + 3) / 4; // ceil(P / 4)
            assertEq(h.outstandingPrincipal(), ps[i]);
            assertEq(h.withdrawableLiquidity(), cash - ps[i] - buffer, "cash - ceil(P/4)");
        }
    }

    function test_atOrAboveTheCap_nothingIsWithdrawable() public {
        _dep(h, lp1, 1000 * E18);
        h.simulateAdvance(800 * E18, sink); // exactly 80%: cash 200, buffer 200
        assertEq(h.utilizationBps(), 8000);
        assertEq(h.withdrawableLiquidity(), 0);
        assertEq(h.maxRedeem(lp1), 0);
        assertEq(h.maxWithdraw(lp1), 0);

        h.simulateAdvance(1, sink); // one wei above the cap
        assertEq(h.withdrawableLiquidity(), 0);
        vm.prank(lp1);
        vm.expectRevert();
        h.redeem(1, lp1, lp1);
    }

    function test_justBelowTheCap_exactBoundary() public {
        _dep(h, lp1, 1000 * E18);
        h.simulateAdvance(400 * E18, sink); // cash 600, buffer 100 -> 500 withdrawable
        assertEq(h.withdrawableLiquidity(), 500 * E18);

        // Removing exactly 500 lands exactly on 80%; one wei more would breach it.
        uint256 nav = h.totalAssets();
        assertEq(
            h.outstandingPrincipal() * 10_000, 8000 * (nav - 500 * E18), "500 lands on the cap"
        );
        assertLt(
            8000 * (nav - 500 * E18 - 1), h.outstandingPrincipal() * 10_000, "501 would breach it"
        );
    }

    function test_redeemMax_landsAtMostOnTheCap_andIsTight() public {
        uint256 s = _dep(h, lp1, 1000 * E18);
        h.simulateAdvance(400 * E18, sink);
        uint256 max = h.maxRedeem(lp1);
        assertLt(max, s);
        vm.prank(lp1);
        uint256 out = h.redeem(max, lp1, lp1);
        assertLe(out, 500 * E18, "never more than the cap");
        assertGe(out, 500 * E18 - 1, "and (almost) all of it");
        assertTrue(_withinCapH());
        assertLe(h.withdrawableLiquidity(), 1, "nothing meaningful left to withdraw");
        // The next share-wei is refused.
        vm.prank(lp1);
        vm.expectRevert();
        h.redeem(max + 1, lp1, lp1);
    }

    function _withinCapH() internal view returns (bool) {
        return h.outstandingPrincipal() * 10_000 <= 8000 * h.totalAssets();
    }

    function test_withdraw_exactAssets_atTheBoundary() public {
        _dep(h, lp1, 1000 * E18);
        h.simulateAdvance(400 * E18, sink);
        uint256 max = h.maxWithdraw(lp1);
        assertLe(max, 500 * E18);
        vm.prank(lp1);
        h.withdraw(max, lp1, lp1);
        assertTrue(_withinCapH());
        vm.prank(lp1);
        vm.expectRevert();
        h.withdraw(5, lp1, lp1); // anything beyond the cap rounds the other way
    }

    function test_maxViewsAreZeroWhenPaused_butFormulaIsIndependentOfPause() public {
        _dep(h, lp1, 1000 * E18);
        h.simulateAdvance(400 * E18, sink);
        vm.prank(pauser);
        h.pause();
        assertEq(h.maxRedeem(lp1), 0);
        assertEq(h.maxWithdraw(lp1), 0);
        assertEq(h.withdrawableLiquidity(), 500 * E18, "a plain view of the cap");
    }

    function test_smallHolderNotAffectedUntilTheyHitTheCap() public {
        uint256 sSmall = _dep(h, lp2, 10 * E18);
        _dep(h, lp1, 990 * E18);
        h.simulateAdvance(400 * E18, sink); // 500 withdrawable overall
        assertEq(h.maxRedeem(lp2), sSmall, "10 is well inside the 500 cap");
    }

    function test_depositsAreUnaffected_andRestoreRoom() public {
        _dep(h, lp1, 1000 * E18);
        h.simulateAdvance(800 * E18, sink); // at the cap
        assertEq(h.maxRedeem(lp1), 0);
        _dep(h, lp2, 1000 * E18); // new money: NAV 2000, P 800 = 40%
        assertGt(h.withdrawableLiquidity(), 0);
        assertEq(h.withdrawableLiquidity(), 1200 * E18 - 200 * E18);
    }

    // ------------------------------------------------------------------ property: utilization after a withdrawal

    function testFuzz_afterAnyWithdrawal_utilizationStaysWithinTheCap(
        uint96 dep1,
        uint96 dep2,
        uint96 adv,
        uint96 who
    ) public {
        uint256 d1 = bound(uint256(dep1), 1 * E18, 1_000_000 * E18);
        uint256 d2 = bound(uint256(dep2), 1 * E18, 1_000_000 * E18);
        _dep(h, lp1, d1);
        _dep(h, lp2, d2);
        uint256 p = bound(uint256(adv), 0, d1 + d2 - 1);
        if (p > 0) h.simulateAdvance(p, sink);
        bool wasWithin = _withinCapH();
        address lp = who % 2 == 0 ? lp1 : lp2;

        uint256 max = h.maxRedeem(lp);
        if (!wasWithin) assertEq(max, 0, "above the cap: no exits");
        if (max > 0) {
            vm.prank(lp);
            h.redeem(max, lp, lp);
            assertTrue(_withinCapH(), "a withdrawal never ends above 80%");
        }
        // The other LP is held to the same limit afterwards.
        address other = lp == lp1 ? lp2 : lp1;
        uint256 max2 = h.maxRedeem(other);
        if (max2 > 0) {
            vm.prank(other);
            h.redeem(max2, other, other);
            assertTrue(_withinCapH());
        }
    }

    function testFuzz_withdrawOfMaxWithdrawAlwaysWorks_andStaysWithinTheCap(uint96 dep, uint96 adv)
        public
    {
        uint256 d = bound(uint256(dep), 1 * E18, 1_000_000 * E18);
        _dep(h, lp1, d);
        _dep(h, lp2, d);
        uint256 p = bound(uint256(adv), 0, 2 * d - 1);
        if (p > 0) h.simulateAdvance(p, sink);
        uint256 max = h.maxWithdraw(lp1);
        assertLe(max, h.withdrawableLiquidity());
        if (max > 0) {
            vm.prank(lp1);
            h.withdraw(max, lp1, lp1);
            assertTrue(_withinCapH());
        }
    }

    function testFuzz_dustWithdrawalsAtTheBoundaryNeverBreachTheCap(uint96 dep, uint8 rounds)
        public
    {
        uint256 d = bound(uint256(dep), 100 * E18, 1_000_000 * E18);
        _dep(h, lp1, d);
        h.simulateAdvance(d * 8 / 10 - d / 100, sink); // just under the cap
        for (uint256 i; i < bound(uint256(rounds), 1, 40); i++) {
            uint256 m = h.maxRedeem(lp1);
            uint256 take = m > 3 ? m / 3 + 1 : m; // many small, awkward-sized exits
            if (take == 0) break;
            vm.prank(lp1);
            h.redeem(take, lp1, lp1);
            assertTrue(_withinCapH());
        }
    }

    // ------------------------------------------------------------------ with the real escrow

    function test_realFlow_exitsAreCappedWhileAdvancesAreOpen_andReopenAfterRepayment() public {
        uint256 s1 = _dep(vault, lp1, 3000 * E18);
        _dep(vault, lp2, 1000 * E18);
        uint256 id = _advanced(1000 * E18); // P 900, cash 3100
        assertEq(vault.withdrawableLiquidity(), 3100 * E18 - 225 * E18);

        uint256 max = vault.maxRedeem(lp1);
        assertLt(max, s1);
        vm.prank(lp1);
        vault.redeem(max, lp1, lp1);
        assertTrue(_withinCap(vault));
        assertEq(vault.maxAdvanceNow(), 0, "at the cap: no new advances either");

        // Repayment returns the principal (+fee) as cash and exits reopen.
        vm.prank(client);
        escrow.approveCompletion(id);
        assertEq(vault.outstandingPrincipal(), 0);
        assertGt(vault.maxRedeem(lp1), 0);
        assertEq(vault.withdrawableLiquidity(), vault.availableLiquidity());
    }

    /// @dev A loss lowers NAV and principal together, so it can only improve utilization. What can push
    /// utilization above the cap is NAV dropping without principal dropping (an issuer clawback from the
    /// vault's cash). Exits must then stay locked until deposits or repayments cure it.
    function test_realFlow_navDropAboveTheCap_locksExitsUntilCured() public {
        _dep(vault, lp1, 2000 * E18);
        _dep(vault, lp2, 2000 * E18);
        uint256 id1 = _advanced(1000 * E18);
        _advanced(1000 * E18); // P 1,800 of NAV 4,000
        uint256 m = vault.maxRedeem(lp1);
        vm.prank(lp1);
        vault.redeem(m, lp1, lp1);
        assertTrue(_withinCap(vault));
        assertGt(vault.utilizationBps(), 7990, "exits stopped at the cap");

        rlusd.clawback(address(vault), 50 * E18); // NAV falls, principal does not
        assertFalse(_withinCap(vault), "now above 80%");
        assertEq(vault.withdrawableLiquidity(), 0);
        assertEq(vault.maxRedeem(lp2), 0);
        vm.prank(lp2);
        vm.expectRevert();
        vault.redeem(1, lp2, lp2);

        // Fresh deposits cure it...
        _dep(vault, lp1, 1000 * E18);
        assertTrue(_withinCap(vault));
        assertGt(vault.maxRedeem(lp2), 0);

        // ...and so does a repayment (principal returns as cash).
        vm.prank(client);
        escrow.approveCompletion(id1);
        assertGt(vault.withdrawableLiquidity(), 0);
    }

    function test_realFlow_cannotWithdrawIntoTheBufferEvenInManySteps() public {
        _dep(vault, lp1, 2000 * E18);
        _dep(vault, lp2, 2000 * E18);
        _advanced(1000 * E18);
        _advanced(1000 * E18);
        for (uint256 i; i < 6; i++) {
            address who = i % 2 == 0 ? lp1 : lp2;
            uint256 m = vault.maxRedeem(who);
            if (m > 1) {
                vm.prank(who);
                vault.redeem(m / 2 + 1, who, who);
            }
            assertTrue(_withinCap(vault));
        }
    }
}
