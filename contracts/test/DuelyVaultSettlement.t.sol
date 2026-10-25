// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DuelyVault} from "../src/DuelyVault.sol";
import {IDuelyVault} from "../src/IDuelyVault.sol";
import {MockEscrow} from "./mocks/MockEscrow.sol";
import {RLUSDLikeToken} from "./mocks/RLUSDLikeToken.sol";
import {TogglableFeeToken} from "./mocks/TogglableFeeToken.sol";

/// A4 vault side: recordRepayment / finalizeLoss / setEscrow compatibility, driven by a mock escrow.
contract DuelyVaultSettlementTest is Test {
    uint256 internal constant E18 = 1e18;

    RLUSDLikeToken internal rlusd;
    DuelyVault internal vault;
    MockEscrow internal escrow;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal pauser = makeAddr("pauser");
    address internal lp1 = makeAddr("lp1");
    address internal lp2 = makeAddr("lp2");
    address internal freelancer = makeAddr("freelancer");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        rlusd = new RLUSDLikeToken();
        vault = new DuelyVault(IERC20(address(rlusd)), admin, operator, pauser);
        escrow = new MockEscrow(address(vault), address(rlusd));
        vm.prank(admin);
        vault.setEscrow(address(escrow));
        _fundLp(lp1, 3000 * E18);
        _fundLp(lp2, 1000 * E18);
    }

    function _fundLp(address who, uint256 amount) internal {
        rlusd.mint(who, amount);
        vm.startPrank(who);
        rlusd.approve(address(vault), type(uint256).max);
        vault.deposit(amount, who);
        vm.stopPrank();
    }

    /// @dev NAV 4000. Funds a 1,000 invoice: 900 advance, 30 fee. The mock escrow holds the
    /// client's 1,000 so it can repay 930.
    function _advance(uint256 id) internal {
        rlusd.mint(address(escrow), 1000 * E18);
        escrow.fund(vault, id, freelancer, 1000 * E18, 900 * E18, 30 * E18);
    }

    function _snapshot(uint256 id) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                rlusd.balanceOf(address(vault)),
                rlusd.balanceOf(address(escrow)),
                rlusd.balanceOf(freelancer),
                vault.outstandingPrincipal(),
                vault.totalAssets(),
                vault.totalSupply(),
                vault.totalFeesEarned(),
                vault.totalRealizedLosses(),
                vault.getAdvance(id)
            )
        );
    }

    // ------------------------------------------------------------------ repayment

    function test_recordRepayment_closesAdvance_realizesFee_navUpByFeeOnly() public {
        _advance(1);
        uint256 nav = vault.totalAssets();
        assertEq(nav, 4000 * E18);

        vm.expectEmit(true, false, false, true, address(vault));
        emit IDuelyVault.AdvanceRepaid(1, 900 * E18, 30 * E18);
        escrow.repay(vault, 1, 930 * E18);

        assertEq(vault.outstandingPrincipal(), 0);
        assertEq(vault.availableLiquidity(), 4030 * E18, "3100 cash + 930 repayment");
        assertEq(vault.totalAssets(), 4030 * E18, "NAV +fee exactly");
        assertEq(vault.totalFeesEarned(), 30 * E18);
        assertEq(vault.totalRealizedLosses(), 0);
        assertEq(rlusd.balanceOf(address(escrow)), 1000 * E18 - 930 * E18);

        IDuelyVault.Advance memory a = vault.getAdvance(1);
        assertEq(uint8(a.status), uint8(IDuelyVault.AdvanceStatus.Repaid));
        assertEq(a.principalRepaid, 900 * E18);
        assertEq(a.feeEarned, 30 * E18);
        assertEq(a.loss, 0);
        assertEq(a.principal, 900 * E18, "terms are preserved");
    }

    function test_recordRepayment_amountsComeFromStoredTerms_notFromCaller() public {
        _advance(1);
        // The escrow over-approves and holds extra funds; the vault still pulls exactly 930.
        rlusd.mint(address(escrow), 5000 * E18);
        uint256 escrowBefore = rlusd.balanceOf(address(escrow));
        escrow.repay(vault, 1, type(uint256).max);
        assertEq(escrowBefore - rlusd.balanceOf(address(escrow)), 930 * E18);
        assertEq(vault.totalAssets(), 4030 * E18);
    }

    function test_recordRepayment_onlyOnce() public {
        _advance(1);
        escrow.repay(vault, 1, 930 * E18);
        bytes32 snap = _snapshot(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDuelyVault.AdvanceNotOpen.selector, 1, IDuelyVault.AdvanceStatus.Repaid
            )
        );
        escrow.repay(vault, 1, 930 * E18);
        assertEq(_snapshot(1), snap, "duplicate repayment changed nothing");
    }

    function test_recordRepayment_unknownInvoiceReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IDuelyVault.AdvanceNotOpen.selector, 9, IDuelyVault.AdvanceStatus.None
            )
        );
        escrow.repay(vault, 9, 0);
    }

    function test_recordRepayment_failsCleanlyWithoutFundsOrAllowance() public {
        _advance(1);
        bytes32 snap = _snapshot(1);

        // No allowance.
        vm.prank(address(escrow));
        rlusd.approve(address(vault), 0);
        vm.prank(address(escrow));
        vm.expectRevert();
        vault.recordRepayment(1);
        assertEq(_snapshot(1), snap);

        // Allowance but not enough balance.
        vm.prank(address(escrow));
        rlusd.transfer(stranger, 500 * E18);
        snap = _snapshot(1);
        vm.expectRevert();
        escrow.repay(vault, 1, 930 * E18);
        assertEq(_snapshot(1), snap);
        assertEq(uint8(vault.getAdvance(1).status), uint8(IDuelyVault.AdvanceStatus.Open));
    }

    function test_recordRepayment_issuerPauseRevertsWholeCall() public {
        _advance(1);
        bytes32 snap = _snapshot(1);
        rlusd.pause();
        vm.expectRevert();
        escrow.repay(vault, 1, 930 * E18);
        rlusd.unpause();
        assertEq(_snapshot(1), snap);
    }

    function test_recordRepayment_onlyEscrow() public {
        _advance(1);
        bytes32 snap = _snapshot(1);
        address[5] memory callers = [admin, operator, pauser, lp1, freelancer];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(IDuelyVault.NotEscrow.selector);
            vault.recordRepayment(1);
        }
        assertEq(_snapshot(1), snap);
    }

    // ------------------------------------------------------------------ loss

    function test_finalizeLoss_navDownByPrincipalOnce_noFee_noTokenMovement() public {
        _advance(1);
        uint256 cash = vault.availableLiquidity();
        uint256 priceBefore = vault.convertToAssets(1e24);

        vm.expectEmit(true, false, false, true, address(vault));
        emit IDuelyVault.AdvanceLossFinalized(1, 900 * E18);
        escrow.loss(vault, 1);

        assertEq(vault.availableLiquidity(), cash, "no tokens move");
        assertEq(vault.outstandingPrincipal(), 0);
        assertEq(vault.totalAssets(), 3100 * E18, "NAV -900");
        assertEq(vault.totalRealizedLosses(), 900 * E18);
        assertEq(vault.totalFeesEarned(), 0, "no fee on loss");
        assertLt(vault.convertToAssets(1e24), priceBefore);

        IDuelyVault.Advance memory a = vault.getAdvance(1);
        assertEq(uint8(a.status), uint8(IDuelyVault.AdvanceStatus.Lost));
        assertEq(a.loss, 900 * E18);
        assertEq(a.feeEarned, 0);
        assertEq(a.principalRepaid, 0);
    }

    function test_finalizeLoss_onlyOnce_andNotAfterRepayment() public {
        _advance(1);
        _advance(2); // both opened while NAV is still 4000
        escrow.loss(vault, 1);
        bytes32 snap = _snapshot(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDuelyVault.AdvanceNotOpen.selector, 1, IDuelyVault.AdvanceStatus.Lost
            )
        );
        escrow.loss(vault, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDuelyVault.AdvanceNotOpen.selector, 1, IDuelyVault.AdvanceStatus.Lost
            )
        );
        escrow.repay(vault, 1, 930 * E18);
        assertEq(_snapshot(1), snap, "NAV decreased exactly once");

        escrow.repay(vault, 2, 930 * E18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDuelyVault.AdvanceNotOpen.selector, 2, IDuelyVault.AdvanceStatus.Repaid
            )
        );
        escrow.loss(vault, 2);
    }

    function test_finalizeLoss_onlyEscrow() public {
        _advance(1);
        address[5] memory callers = [admin, operator, pauser, lp1, freelancer];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(IDuelyVault.NotEscrow.selector);
            vault.finalizeLoss(1);
        }
        assertEq(vault.totalRealizedLosses(), 0);
    }

    // ------------------------------------------------------------------ pauses never block settlement

    function test_repaymentAndLoss_notBlockedByEitherPause() public {
        _advance(1);
        _advance(2);
        vm.startPrank(operator);
        vault.pause();
        vault.pauseAdvances();
        vm.stopPrank();

        escrow.repay(vault, 1, 930 * E18);
        escrow.loss(vault, 2);
        assertEq(vault.totalAssets(), 4000 * E18 + 30 * E18 - 900 * E18);

        // LPs remain locked out by the full pause until it is lifted.
        assertEq(vault.maxRedeem(lp1), 0);
        vm.prank(operator);
        vault.unpause();
        assertGt(vault.maxRedeem(lp1), 0);
    }

    // ------------------------------------------------------------------ proportional distribution

    function test_multiLp_profitAndLossAreProportional() public {
        // lp1 holds 75% of the shares, lp2 25% (3000 / 1000).
        uint256 v1 = vault.convertToAssets(vault.balanceOf(lp1));
        uint256 v2 = vault.convertToAssets(vault.balanceOf(lp2));
        assertApproxEqAbs(v1, 3000 * E18, 2);
        assertApproxEqAbs(v2, 1000 * E18, 2);

        _advance(1);
        escrow.repay(vault, 1, 930 * E18); // +30
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(lp1)), 3022.5e18, 2);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(lp2)), 1007.5e18, 2);

        _advance(2);
        escrow.loss(vault, 2); // -900
        // NAV 3130 split 75/25.
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(lp1)), 2347.5e18, 2);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(lp2)), 782.5e18, 2);
        assertEq(vault.totalAssets(), 3130 * E18);
    }

    function test_laterDepositor_afterLoss_isNotChargedForIt() public {
        _advance(1);
        escrow.loss(vault, 1);
        address lp3 = makeAddr("lp3");
        rlusd.mint(lp3, 3100 * E18);
        vm.startPrank(lp3);
        rlusd.approve(address(vault), type(uint256).max);
        vault.deposit(3100 * E18, lp3);
        vm.stopPrank();
        // NAV before was 3100 for 100% of existing shares, so lp3 now owns ~50%.
        assertApproxEqRel(vault.convertToAssets(vault.balanceOf(lp3)), 3100 * E18, 1e9);
        assertApproxEqRel(vault.convertToAssets(vault.balanceOf(lp1)), 2325 * E18, 1e9);
    }

    // ------------------------------------------------------------------ failed pull via balance delta

    function test_recordRepayment_rejectsShortDelivery() public {
        TogglableFeeToken tok = new TogglableFeeToken();
        DuelyVault v = new DuelyVault(IERC20(address(tok)), admin, operator, pauser);
        MockEscrow esc = new MockEscrow(address(v), address(tok));
        vm.prank(admin);
        v.setEscrow(address(esc));

        tok.mint(lp1, 4000 * E18);
        vm.startPrank(lp1);
        tok.approve(address(v), type(uint256).max);
        v.deposit(4000 * E18, lp1);
        vm.stopPrank();
        tok.mint(address(esc), 1000 * E18);
        esc.fund(v, 1, freelancer, 1000 * E18, 900 * E18, 30 * E18);

        tok.setTax(true); // from now on the vault receives 1 wei less than sent
        uint256 nav = v.totalAssets();
        vm.expectRevert(IDuelyVault.UnsupportedTokenBehavior.selector);
        esc.repay(v, 1, 930 * E18);
        assertEq(v.totalAssets(), nav);
        assertEq(uint8(v.getAdvance(1).status), uint8(IDuelyVault.AdvanceStatus.Open));
        assertEq(v.totalFeesEarned(), 0);
    }

    // ------------------------------------------------------------------ setEscrow compatibility

    function _fresh() internal returns (DuelyVault v) {
        v = new DuelyVault(IERC20(address(rlusd)), admin, operator, pauser);
    }

    function test_setEscrow_rejectsEscrowPointingAtAnotherVault() public {
        DuelyVault v = _fresh();
        MockEscrow wrong = new MockEscrow(address(vault), address(rlusd));
        vm.prank(admin);
        vm.expectRevert(IDuelyVault.EscrowMismatch.selector);
        v.setEscrow(address(wrong));
        assertEq(v.escrow(), address(0), "a rejected attempt does not spend the one-time right");
    }

    function test_setEscrow_rejectsWrongToken() public {
        DuelyVault v = _fresh();
        MockEscrow wrong = new MockEscrow(address(v), address(new RLUSDLikeToken()));
        vm.prank(admin);
        vm.expectRevert(IDuelyVault.EscrowMismatch.selector);
        v.setEscrow(address(wrong));
    }

    function test_setEscrow_rejectsNonEscrowContracts() public {
        DuelyVault v = _fresh();
        vm.startPrank(admin);
        vm.expectRevert(IDuelyVault.EscrowMismatch.selector);
        v.setEscrow(address(rlusd)); // a token has no vault()/FEE_BPS()
        vm.expectRevert(IDuelyVault.EscrowMismatch.selector);
        v.setEscrow(address(vault)); // another vault is not an escrow
        vm.stopPrank();
    }

    function test_setEscrow_acceptsCompatibleEscrow() public {
        DuelyVault v = _fresh();
        MockEscrow ok = new MockEscrow(address(v), address(rlusd));
        vm.prank(admin);
        v.setEscrow(address(ok));
        assertEq(v.escrow(), address(ok));
    }
}
