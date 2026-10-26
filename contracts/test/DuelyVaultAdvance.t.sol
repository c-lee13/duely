// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {DuelyVault} from "../src/DuelyVault.sol";
import {IDuelyVault} from "../src/IDuelyVault.sol";
import {MockEscrow} from "./mocks/MockEscrow.sol";
import {RLUSDLikeToken} from "./mocks/RLUSDLikeToken.sol";

/// A3: vault-funded advances. A mock escrow supplies the invoice terms; the real escrow is A4.
contract DuelyVaultAdvanceTest is Test {
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
        rlusd.mint(lp1, 1_000_000 * E18);
        rlusd.mint(lp2, 1_000_000 * E18);
        vm.prank(lp1);
        rlusd.approve(address(vault), type(uint256).max);
        vm.prank(lp2);
        rlusd.approve(address(vault), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _setEscrow() internal {
        vm.prank(admin);
        vault.setEscrow(address(escrow));
    }

    function _deposit(address who, uint256 assets) internal {
        vm.prank(who);
        vault.deposit(assets, who);
    }

    function _fee(uint256 invoiceAmount) internal pure returns (uint256) {
        return invoiceAmount * 1_000 / 10_000;
    }

    /// @dev Funds `principal` against an invoice large enough for the 90% cap, standard fee.
    function _fund(uint256 id, uint256 principal) internal {
        uint256 invoiceAmount = principal * 2;
        escrow.fund(vault, id, freelancer, invoiceAmount, principal, _fee(invoiceAmount));
    }

    function _ready() internal {
        _setEscrow();
        _deposit(lp1, 4000 * E18); // NAV 4000: invoice cap 1000, utilization cap 3200
    }

    function _snapshot() internal view returns (bytes32) {
        IDuelyVault.Advance memory a = vault.getAdvance(1);
        return keccak256(
            abi.encode(
                rlusd.balanceOf(address(vault)),
                rlusd.balanceOf(freelancer),
                vault.outstandingPrincipal(),
                vault.totalAssets(),
                vault.totalSupply(),
                vault.totalFeesEarned(),
                vault.totalRealizedLosses(),
                a
            )
        );
    }

    // ------------------------------------------------------------------ authorized funding

    function test_fundAdvance_paysFreelancer_recordsAdvance_emitsEvent() public {
        _ready();
        uint256 navBefore = vault.totalAssets();
        uint256 priceBefore = vault.convertToAssets(1e24);
        uint256 cashBefore = vault.availableLiquidity();

        vm.expectEmit(true, true, false, true, address(vault));
        emit IDuelyVault.AdvanceFunded(7, freelancer, 1000 * E18, 900 * E18, 100 * E18, 900 * E18);
        escrow.fund(vault, 7, freelancer, 1000 * E18, 900 * E18, 100 * E18);

        assertEq(rlusd.balanceOf(freelancer), 900 * E18);
        assertEq(vault.availableLiquidity(), cashBefore - 900 * E18, "cash down by principal");
        assertEq(vault.outstandingPrincipal(), 900 * E18, "principal up by the same amount");
        assertEq(vault.totalAssets(), navBefore, "NAV unchanged");
        assertEq(vault.convertToAssets(1e24), priceBefore, "share price unchanged");
        assertEq(vault.utilizationBps(), 2250);

        IDuelyVault.Advance memory a = vault.getAdvance(7);
        assertEq(a.freelancer, freelancer);
        assertEq(a.invoiceAmount, 1000 * E18);
        assertEq(a.principal, 900 * E18);
        assertEq(a.fee, 100 * E18);
        assertEq(a.principalRepaid, 0);
        assertEq(a.feeEarned, 0);
        assertEq(a.loss, 0);
        assertEq(uint8(a.status), uint8(IDuelyVault.AdvanceStatus.Open));
        assertEq(vault.totalFeesEarned(), 0, "the quoted fee is not an asset yet");
        assertEq(vault.totalRealizedLosses(), 0);
    }

    function test_fundAdvance_isExactlyOncePerInvoice_andOthersStillWork() public {
        _ready();
        _fund(1, 400 * E18);
        bytes32 snap = _snapshot();
        vm.expectRevert(abi.encodeWithSelector(IDuelyVault.AdvanceAlreadyExists.selector, 1));
        escrow.fund(vault, 1, freelancer, 1000 * E18, 100 * E18, 100 * E18);
        assertEq(_snapshot(), snap, "duplicate attempt changed nothing");

        _fund(2, 400 * E18);
        assertEq(vault.outstandingPrincipal(), 800 * E18);
    }

    function test_navAndSharePrice_unchangedAcrossManyAdvances() public {
        _ready();
        _deposit(lp2, 1000 * E18); // NAV 5000: invoice cap 1250
        uint256 nav = vault.totalAssets();
        uint256 price = vault.convertToAssets(1e24);
        for (uint256 i = 1; i <= 4; i++) {
            _fund(i, 900 * E18);
            assertEq(vault.totalAssets(), nav);
            assertEq(vault.convertToAssets(1e24), price);
            assertEq(
                vault.availableLiquidity() + vault.outstandingPrincipal(), nav, "cash + principal"
            );
        }
        assertEq(vault.outstandingPrincipal(), 3600 * E18);
    }

    function test_lpFlow_afterAdvance_pricesAndCapsConsistent() public {
        _ready();
        uint256 shares = vault.balanceOf(lp1);
        _fund(1, 1000 * E18);
        // A later depositor pays the unchanged price.
        uint256 before = vault.convertToShares(100 * E18);
        _deposit(lp2, 100 * E18);
        assertApproxEqAbs(vault.balanceOf(lp2), before, 1);
        // Redemptions are capped by the 3000 of cash, not the 4100 of NAV.
        uint256 max = vault.maxRedeem(lp1);
        assertLt(max, shares);
        assertLe(vault.previewRedeem(max), vault.availableLiquidity());
    }

    // ------------------------------------------------------------------ authorization / setup

    function test_fundAdvance_revertsWithoutEscrow() public {
        _deposit(lp1, 4000 * E18);
        vm.expectRevert(IDuelyVault.EscrowNotSet.selector);
        escrow.fund(vault, 1, freelancer, 1000 * E18, 900 * E18, 100 * E18);
        vm.prank(stranger);
        vm.expectRevert(IDuelyVault.EscrowNotSet.selector);
        vault.fundAdvance(1, freelancer, 1000 * E18, 900 * E18, 100 * E18);
    }

    function test_fundAdvance_onlyTheConfiguredEscrow() public {
        _ready();
        bytes32 snap = _snapshot();
        address[5] memory callers = [admin, operator, pauser, lp1, stranger];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(IDuelyVault.NotEscrow.selector);
            vault.fundAdvance(1, freelancer, 1000 * E18, 900 * E18, 100 * E18);
        }
        // Even the freelancer cannot trigger their own advance.
        vm.prank(freelancer);
        vm.expectRevert(IDuelyVault.NotEscrow.selector);
        vault.fundAdvance(1, freelancer, 1000 * E18, 900 * E18, 100 * E18);
        assertEq(_snapshot(), snap);
    }

    // ------------------------------------------------------------------ invoice terms

    function test_invalidAmounts() public {
        _ready();
        bytes32 snap = _snapshot();
        vm.expectRevert(IDuelyVault.InvalidAmount.selector);
        escrow.fund(vault, 1, freelancer, 1000 * E18, 0, 0);
        vm.expectRevert(IDuelyVault.InvalidAmount.selector);
        escrow.fund(vault, 1, freelancer, 0, 1, 0);
        assertEq(_snapshot(), snap);
    }

    function test_invalidFreelancers() public {
        _ready();
        bytes32 snap = _snapshot();
        address[4] memory bad = [address(0), address(vault), address(escrow), address(rlusd)];
        for (uint256 i; i < bad.length; i++) {
            vm.expectRevert(IDuelyVault.InvalidAddress.selector);
            escrow.fund(vault, 1, bad[i], 1000 * E18, 900 * E18, 100 * E18);
        }
        assertEq(_snapshot(), snap);
    }

    function test_advanceRatio_boundaryIs90PercentFloored() public {
        _ready();
        // Exactly 90% passes.
        escrow.fund(vault, 1, freelancer, 1000 * E18, 900 * E18, 100 * E18);
        // One wei over 90% reverts.
        vm.expectRevert(
            abi.encodeWithSelector(
                IDuelyVault.AdvanceExceedsInvoiceCap.selector, 900 * E18 + 1, 1000 * E18
            )
        );
        escrow.fund(vault, 2, freelancer, 1000 * E18, 900 * E18 + 1, 100 * E18);
        // Floor rounding: invoice of 10_001 wei allows exactly 9_000.
        escrow.fund(vault, 3, freelancer, 10_001, 9_000, 1_000);
        vm.expectRevert(
            abi.encodeWithSelector(IDuelyVault.AdvanceExceedsInvoiceCap.selector, 9_001, 10_001)
        );
        escrow.fund(vault, 4, freelancer, 10_001, 9_001, 1_000);
        // A tiny advance against a large invoice is still within the cap.
        escrow.fund(vault, 5, freelancer, 1000 * E18, 1, 100 * E18);
    }

    function test_fee_mustEqual1000bpsOfInvoice() public {
        _ready();
        bytes32 snap = _snapshot();
        uint256[3] memory wrong = [uint256(0), 100 * E18 - 1, 100 * E18 + 1];
        for (uint256 i; i < wrong.length; i++) {
            vm.expectRevert(
                abi.encodeWithSelector(IDuelyVault.InvalidFee.selector, wrong[i], 100 * E18)
            );
            escrow.fund(vault, 1, freelancer, 1000 * E18, 900 * E18, wrong[i]);
        }
        assertEq(_snapshot(), snap);
        // Floor rounding on small invoices, including a zero fee.
        escrow.fund(vault, 2, freelancer, 33, 29, 3);
        escrow.fund(vault, 3, freelancer, 34, 30, 3);
    }

    // ------------------------------------------------------------------ liquidity and risk caps

    function test_perInvoiceExposure_boundary25PercentOfNav() public {
        _ready();
        bytes32 snap = _snapshot();
        uint256 over = 1000 * E18 + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                IDuelyVault.ExceedsInvoiceExposureLimit.selector, over, 1000 * E18
            )
        );
        escrow.fund(vault, 1, freelancer, 2 * over, over, _fee(2 * over));
        assertEq(_snapshot(), snap);

        _fund(1, 1000 * E18); // exactly 25%
        assertEq(vault.outstandingPrincipal(), 1000 * E18);
    }

    function test_perInvoiceExposure_flooredOnOddNav() public {
        _setEscrow();
        _deposit(lp1, 4001); // cap = floor(4001 * 2500 / 10000) = 1000
        assertEq(vault.maxAdvanceNow(), 1000);
        vm.expectRevert(
            abi.encodeWithSelector(IDuelyVault.ExceedsInvoiceExposureLimit.selector, 1001, 1000)
        );
        escrow.fund(vault, 1, freelancer, 1200, 1001, 120);
        escrow.fund(vault, 1, freelancer, 1200, 1000, 120);
    }

    function test_utilization_boundary80PercentOfNav() public {
        _ready();
        _fund(1, 1000 * E18);
        _fund(2, 1000 * E18);
        _fund(3, 1000 * E18);
        assertEq(vault.maxAdvanceNow(), 200 * E18, "headroom 3200 - 3000");

        bytes32 snap = _snapshot();
        vm.expectRevert(
            abi.encodeWithSelector(
                IDuelyVault.ExceedsUtilizationLimit.selector, 3200 * E18 + 1, 3200 * E18
            )
        );
        escrow.fund(vault, 4, freelancer, 1000 * E18, 200 * E18 + 1, 100 * E18);
        assertEq(_snapshot(), snap, "failed funding leaves everything unchanged");

        escrow.fund(vault, 4, freelancer, 400 * E18, 200 * E18, 40 * E18);
        assertEq(vault.utilizationBps(), 8000);
        assertEq(vault.maxAdvanceNow(), 0);

        vm.expectRevert();
        escrow.fund(vault, 5, freelancer, 2, 1, 0);
    }

    function test_utilization_afterRedemptionsTheCashLimitsBind() public {
        _ready();
        _deposit(lp2, 4000 * E18); // NAV 8000
        _fund(1, 2000 * E18);
        _fund(2, 2000 * E18);
        // lp2 leaves with all the cash it can redeem: NAV falls, utilization jumps.
        uint256 max = vault.maxRedeem(lp2);
        vm.prank(lp2);
        vault.redeem(max, lp2, lp2);
        assertGt(vault.utilizationBps(), 4000);
        assertLe(vault.maxAdvanceNow(), vault.availableLiquidity());
        bytes32 snap = _snapshot();
        uint256 tooMuch = vault.maxAdvanceNow() + 1;
        vm.expectRevert();
        _fund(3, tooMuch);
        assertEq(_snapshot(), snap);
    }

    /// @dev Cash always equals NAV minus outstanding principal, and the utilization cap is below
    /// 100% of NAV, so `principal <= available cash` is implied by the utilization cap. The
    /// explicit InsufficientLiquidity check is therefore defence in depth and cannot be reached
    /// through the public interface; this test pins the identity that makes that true.
    function testFuzz_cashIsAlwaysNavMinusPrincipal_soUtilizationImpliesLiquidity(
        uint96 dep,
        uint96 p1,
        uint96 p2
    ) public {
        _setEscrow();
        uint256 d = bound(uint256(dep), 4 ether, 1_000_000 * E18);
        _deposit(lp1, d);
        uint256 a = bound(uint256(p1), 1, vault.maxAdvanceNow());
        _fund(1, a);
        uint256 max = vault.maxAdvanceNow();
        if (max > 0) _fund(2, bound(uint256(p2), 1, max));
        assertEq(vault.availableLiquidity(), vault.totalAssets() - vault.outstandingPrincipal());
        assertLe(vault.maxAdvanceNow(), vault.availableLiquidity());
    }

    function testFuzz_maxAdvanceNow_isExactlyTheEnforcedLimit(uint96 dep, uint96 p1, uint96 donate)
        public
    {
        _setEscrow();
        uint256 d = bound(uint256(dep), 100, 1_000_000 * E18);
        _deposit(lp1, d);
        uint256 x = bound(uint256(donate), 0, 100_000 * E18);
        if (x > 0) {
            rlusd.mint(address(vault), x);
        }
        uint256 first = vault.maxAdvanceNow();
        if (first > 0) {
            _fund(1, bound(uint256(p1), 1, first));
        }
        uint256 max = vault.maxAdvanceNow();

        if (max > 0) {
            uint256 snap = vm.snapshotState();
            _fund(2, max); // accepted
            assertEq(vault.maxAdvanceNow() <= max, true);
            vm.revertToState(snap);
        }
        vm.expectRevert(); // one more wei than maxAdvanceNow is always rejected
        _fund(3, max + 1);
    }

    // ------------------------------------------------------------------ pause behavior

    function test_fullPause_blocksFunding() public {
        _ready();
        vm.prank(pauser);
        vault.pause();
        assertEq(vault.maxAdvanceNow(), 0);
        bytes32 snap = _snapshot();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.fund(vault, 1, freelancer, 1000 * E18, 900 * E18, 100 * E18);
        // Authorization is checked first.
        vm.prank(stranger);
        vm.expectRevert(IDuelyVault.NotEscrow.selector);
        vault.fundAdvance(1, freelancer, 1000 * E18, 900 * E18, 100 * E18);
        assertEq(_snapshot(), snap);

        vm.prank(operator);
        vault.unpause();
        escrow.fund(vault, 1, freelancer, 1000 * E18, 900 * E18, 100 * E18);
    }

    function test_advancePause_blocksOnlyFunding_notLps() public {
        _ready();
        vm.prank(pauser);
        vault.pauseAdvances();
        assertEq(vault.maxAdvanceNow(), 0);
        bytes32 snap = _snapshot();
        vm.expectRevert(IDuelyVault.AdvancesAreDisabled.selector);
        escrow.fund(vault, 1, freelancer, 1000 * E18, 900 * E18, 100 * E18);
        assertEq(_snapshot(), snap);

        // LPs unaffected.
        _deposit(lp2, 100 * E18);
        uint256 s = vault.balanceOf(lp2);
        vm.prank(lp2);
        vault.redeem(s, lp2, lp2);

        vm.prank(operator);
        vault.unpauseAdvances();
        escrow.fund(vault, 1, freelancer, 1000 * E18, 900 * E18, 100 * E18);
    }

    function test_bothPauses_mustBeClearedToFund() public {
        _ready();
        vm.startPrank(operator);
        vault.pause();
        vault.pauseAdvances();
        vault.unpause();
        vm.stopPrank();
        vm.expectRevert(IDuelyVault.AdvancesAreDisabled.selector);
        escrow.fund(vault, 1, freelancer, 1000 * E18, 900 * E18, 100 * E18);
        vm.prank(operator);
        vault.unpauseAdvances();
        escrow.fund(vault, 1, freelancer, 1000 * E18, 900 * E18, 100 * E18);
    }
}
