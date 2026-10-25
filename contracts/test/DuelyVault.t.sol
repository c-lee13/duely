// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {DuelyVault} from "../src/DuelyVault.sol";
import {IDuelyVault} from "../src/IDuelyVault.sol";
import {DuelyVaultHarness} from "./mocks/DuelyVaultHarness.sol";
import {RLUSDLikeToken} from "./mocks/RLUSDLikeToken.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";

/// A2 foundation tests: LP side only. Advance/repayment/loss transitions are simulated through the
/// test-only harness; the real escrow-only functions are asserted to revert until A3/A4.
contract DuelyVaultTest is Test {
    uint256 internal constant E18 = 1e18;

    RLUSDLikeToken internal rlusd;
    DuelyVaultHarness internal vault;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal pauser = makeAddr("pauser");
    address internal lp1 = makeAddr("lp1");
    address internal lp2 = makeAddr("lp2");
    address internal lp3 = makeAddr("lp3");
    address internal attacker = makeAddr("attacker");
    address internal sink = makeAddr("sink");

    function setUp() public {
        rlusd = new RLUSDLikeToken();
        vault = new DuelyVaultHarness(IERC20(address(rlusd)), admin, operator, pauser);
        _fund(lp1, 1_000_000 * E18);
        _fund(lp2, 1_000_000 * E18);
        _fund(lp3, 1_000_000 * E18);
        _fund(attacker, 10_000_000 * E18);
    }

    function _fund(address who, uint256 amount) internal {
        rlusd.mint(who, amount);
        vm.prank(who);
        rlusd.approve(address(vault), type(uint256).max);
    }

    function _deposit(address who, uint256 assets) internal returns (uint256 shares) {
        vm.prank(who);
        shares = vault.deposit(assets, who);
    }

    // ------------------------------------------------------------------ metadata / ctor

    function test_metadata() public view {
        assertEq(vault.name(), "Duely Vault Share");
        assertEq(vault.symbol(), "dvRLUSD");
        assertEq(vault.decimals(), 24, "18-decimal asset + offset 6");
        assertEq(vault.asset(), address(rlusd));
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.MAX_ADVANCE_BPS(), 9000);
        assertEq(vault.MAX_UTILIZATION_BPS(), 8000);
        assertEq(vault.MAX_INVOICE_EXPOSURE_BPS(), 2500);
    }

    function test_constructor_rejectsZeroAddresses() public {
        IERC20 t = IERC20(address(rlusd));
        vm.expectRevert(IDuelyVault.InvalidAddress.selector);
        new DuelyVault(IERC20(address(0)), admin, operator, pauser);
        vm.expectRevert(IDuelyVault.InvalidAddress.selector);
        new DuelyVault(t, address(0), operator, pauser);
        vm.expectRevert(IDuelyVault.InvalidAddress.selector);
        new DuelyVault(t, admin, address(0), pauser);
        vm.expectRevert(IDuelyVault.InvalidAddress.selector);
        new DuelyVault(t, admin, operator, address(0));
    }

    function test_roles() public view {
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(vault.hasRole(vault.OPERATOR_ROLE(), operator));
        assertTrue(vault.hasRole(vault.PAUSER_ROLE(), pauser));
        assertFalse(vault.hasRole(vault.OPERATOR_ROLE(), admin));
    }

    // ------------------------------------------------------------------ deposits

    function test_firstDeposit_mintsAssetsTimesOffset() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit IERC4626.Deposit(lp1, lp1, 1000 * E18, 1000 * E18 * 1e6);
        uint256 shares = _deposit(lp1, 1000 * E18);

        assertEq(shares, 1000 * E18 * 1e6);
        assertEq(vault.balanceOf(lp1), shares);
        assertEq(vault.totalAssets(), 1000 * E18);
        assertEq(rlusd.balanceOf(address(vault)), 1000 * E18);
        assertEq(vault.availableLiquidity(), 1000 * E18);
    }

    function test_deposit_toDifferentReceiver() public {
        vm.prank(lp1);
        uint256 shares = vault.deposit(100 * E18, lp2);
        assertEq(vault.balanceOf(lp2), shares);
        assertEq(vault.balanceOf(lp1), 0);
        assertEq(rlusd.balanceOf(lp1), 1_000_000 * E18 - 100 * E18);
    }

    function test_mint_pullsExactPreviewedAssets() public {
        uint256 want = 500 * E18 * 1e6;
        uint256 preview = vault.previewMint(want);
        vm.prank(lp1);
        uint256 paid = vault.mint(want, lp1);
        assertEq(paid, preview);
        assertEq(vault.balanceOf(lp1), want);
        assertEq(vault.totalAssets(), paid);
    }

    function test_deposit_zeroReceiverReverts() public {
        vm.prank(lp1);
        vm.expectRevert();
        vault.deposit(1 * E18, address(0));
    }

    function test_deposit_withoutAllowanceReverts() public {
        address nobody = makeAddr("nobody");
        rlusd.mint(nobody, 10 * E18);
        vm.prank(nobody);
        vm.expectRevert();
        vault.deposit(10 * E18, nobody);
    }

    function test_deposit_zeroAssetsMintsNothing() public {
        vm.prank(lp1);
        uint256 shares = vault.deposit(0, lp1);
        assertEq(shares, 0);
        assertEq(vault.totalSupply(), 0);
    }

    function test_deposit_rejectsFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        DuelyVault v = new DuelyVault(IERC20(address(fot)), admin, operator, pauser);
        fot.mint(lp1, 1_000_000);
        vm.startPrank(lp1);
        fot.approve(address(v), type(uint256).max);
        vm.expectRevert(IDuelyVault.UnsupportedTokenBehavior.selector);
        v.deposit(100_000, lp1);
        vm.stopPrank();
        assertEq(v.totalSupply(), 0);
    }

    // ------------------------------------------------------------------ redemptions

    function test_singleLp_roundTripReturnsDeposit() public {
        uint256 shares = _deposit(lp1, 1000 * E18);
        uint256 before = rlusd.balanceOf(lp1);

        vm.expectEmit(true, true, true, true, address(vault));
        emit IERC4626.Withdraw(lp1, lp1, lp1, 1000 * E18, shares);
        vm.prank(lp1);
        uint256 out = vault.redeem(shares, lp1, lp1);

        assertEq(out, 1000 * E18, "single LP gets the deposit back exactly");
        assertEq(rlusd.balanceOf(lp1), before + out);
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.totalAssets(), 0);
    }

    function test_withdraw_burnsCeilShares() public {
        _deposit(lp1, 1000 * E18);
        _deposit(lp2, 1000 * E18);
        uint256 preview = vault.previewWithdraw(250 * E18);
        uint256 sharesBefore = vault.balanceOf(lp1);
        vm.prank(lp1);
        uint256 burned = vault.withdraw(250 * E18, lp1, lp1);
        assertEq(burned, preview);
        assertEq(vault.balanceOf(lp1), sharesBefore - burned);
    }

    function test_redeem_toDifferentReceiver() public {
        uint256 shares = _deposit(lp1, 100 * E18);
        vm.prank(lp1);
        vault.redeem(shares, lp3, lp1);
        assertEq(rlusd.balanceOf(lp3), 1_000_000 * E18 + 100 * E18);
    }

    // ------------------------------------------------------------------ transferable shares

    function test_shares_areTransferable_andRedeemableByRecipient() public {
        uint256 shares = _deposit(lp1, 1000 * E18);
        vm.prank(lp1);
        vault.transfer(lp2, shares);
        assertEq(vault.balanceOf(lp1), 0);

        vm.prank(lp1);
        vm.expectRevert();
        vault.redeem(1, lp1, lp1);

        vm.prank(lp2);
        uint256 out = vault.redeem(shares, lp2, lp2);
        assertEq(out, 1000 * E18);
    }

    function test_redeem_bySpender_needsAllowance() public {
        uint256 shares = _deposit(lp1, 1000 * E18);

        vm.prank(lp2);
        vm.expectRevert();
        vault.redeem(shares, lp2, lp1);

        vm.prank(lp1);
        vault.approve(lp2, shares);
        vm.prank(lp2);
        uint256 out = vault.redeem(shares, lp2, lp1);
        assertEq(out, 1000 * E18);
        assertEq(vault.allowance(lp1, lp2), 0);
    }

    // ------------------------------------------------------------------ multiple LPs

    function test_multipleLps_proRata() public {
        _deposit(lp1, 1000 * E18);
        _deposit(lp2, 500 * E18);
        _deposit(lp3, 2500 * E18);

        assertEq(vault.totalAssets(), 4000 * E18);
        _assertValue(lp1, 1000 * E18);
        _assertValue(lp2, 500 * E18);
        _assertValue(lp3, 2500 * E18);

        // Everyone exits; vault ends (near) empty and nobody gains from rounding.
        uint256 dust;
        for (uint256 i; i < 3; i++) {
            address lp = i == 0 ? lp1 : i == 1 ? lp2 : lp3;
            uint256 s = vault.balanceOf(lp);
            vm.prank(lp);
            vault.redeem(s, lp, lp);
        }
        dust = rlusd.balanceOf(address(vault));
        assertLe(dust, 3, "only wei-level rounding dust remains");
    }

    /// @dev value of an LP's shares equals `expected` up to wei-level virtual-asset rounding.
    function _assertValue(address lp, uint256 expected) internal view {
        uint256 v = vault.convertToAssets(vault.balanceOf(lp));
        assertLe(v, expected, "never above fair value");
        assertGe(v, expected - 2, "within rounding");
    }

    // ------------------------------------------------------------------ gains, losses, later deposits

    function test_donation_raisesShareValueForExistingLps() public {
        _deposit(lp1, 1000 * E18);
        _deposit(lp2, 3000 * E18);

        vm.prank(attacker);
        rlusd.transfer(address(vault), 400 * E18); // direct donation

        assertEq(vault.totalAssets(), 4400 * E18, "donation counted exactly once");
        _assertValue(lp1, 1100 * E18);
        _assertValue(lp2, 3300 * E18);
    }

    function test_fee_raisesNavByExactlyFee_thenLaterDepositGetsFewerShares() public {
        uint256 sharesA = _deposit(lp1, 1000 * E18);
        // 900 advanced out, then 930 comes back (900 principal + 30 fee).
        vault.simulateAdvance(900 * E18, sink);
        assertEq(vault.totalAssets(), 1000 * E18, "advance does not change NAV");
        rlusd.mint(sink, 30 * E18); // the freelancer/escrow side supplies the fee
        vm.prank(sink);
        rlusd.transfer(address(vault), 930 * E18);
        vault.simulateRepayment(900 * E18, 30 * E18);

        assertEq(vault.outstandingPrincipal(), 0);
        assertEq(vault.totalAssets(), 1030 * E18, "NAV +fee only");

        uint256 sharesB = _deposit(lp2, 1030 * E18);
        // LP2 paid the post-gain price, so LP2 receives (almost exactly) the same shares as LP1.
        assertApproxEqRel(sharesB, sharesA, 1e9);
        _assertValue(lp1, 1030 * E18);
    }

    function test_loss_lowersNavOnce_andLaterDepositorBuysCheaper() public {
        _deposit(lp1, 1000 * E18);
        _deposit(lp2, 1000 * E18);
        vault.simulateAdvance(900 * E18, sink);
        vault.simulateLoss(900 * E18);

        assertEq(vault.totalAssets(), 1100 * E18, "NAV fell by exactly the principal");
        assertEq(vault.totalRealizedLosses(), 900 * E18);
        _assertValue(lp1, 550 * E18);
        _assertValue(lp2, 550 * E18);

        // New LP deposits 1100 at the lower price and receives twice an original LP's shares.
        uint256 original = vault.balanceOf(lp1);
        uint256 newShares = _deposit(lp3, 1100 * E18);
        assertApproxEqRel(newShares, original * 2, 1e9);
        // Value is unchanged for existing LPs after the new deposit.
        _assertValue(lp1, 550 * E18);
        _assertValue(lp3, 1100 * E18);
    }

    function test_totalLoss_vaultStaysUsable() public {
        _deposit(lp1, 1000 * E18);
        vault.simulateAdvance(1000 * E18, sink);
        vault.simulateLoss(1000 * E18);
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.convertToAssets(vault.balanceOf(lp1)), 0);

        // A new depositor can still enter and gets a sensible position.
        uint256 shares = _deposit(lp2, 100 * E18);
        assertGt(shares, 0);
        uint256 value = vault.convertToAssets(shares);
        assertLe(value, 100 * E18);
        assertGe(value, 100 * E18 - 1e12, "loses at most dust to the virtual position");
    }

    function test_sharePriceIsMonotonicUnderFeesAndDonations() public {
        _deposit(lp1, 1000 * E18);
        uint256 p0 = vault.convertToAssets(1e24);
        vm.prank(attacker);
        rlusd.transfer(address(vault), 1 * E18);
        uint256 p1 = vault.convertToAssets(1e24);
        assertGt(p1, p0);
        _deposit(lp2, 777 * E18);
        assertGe(vault.convertToAssets(1e24), p1, "deposits never dilute");
    }

    // ------------------------------------------------------------------ liquidity-capped redemptions

    function test_redeem_cappedByAvailableLiquidity() public {
        uint256 s1 = _deposit(lp1, 1000 * E18);
        _deposit(lp2, 1000 * E18);
        vault.simulateAdvance(1500 * E18, sink); // deliberately beyond A3 limits: harness bypass

        assertEq(vault.availableLiquidity(), 500 * E18);
        assertEq(vault.totalAssets(), 2000 * E18, "principal still counted at par");

        uint256 maxShares = vault.maxRedeem(lp1);
        assertLt(maxShares, s1, "cap is below the LP's full balance");
        assertLe(vault.previewRedeem(maxShares), 500 * E18, "cap never exceeds cash");
        assertEq(vault.maxWithdraw(lp1), vault.previewRedeem(maxShares));

        vm.prank(lp1);
        vm.expectRevert(
            abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, lp1, s1, maxShares)
        );
        vault.redeem(s1, lp1, lp1);

        vm.prank(lp1);
        uint256 out = vault.redeem(maxShares, lp1, lp1);
        assertLe(out, 500 * E18);
        assertGe(out, 500 * E18 - 2);
        assertLe(rlusd.balanceOf(address(vault)), 2, "vault cash fully used");
    }

    function test_withdraw_aboveLiquidityReverts() public {
        _deposit(lp1, 1000 * E18);
        vault.simulateAdvance(800 * E18, sink);
        uint256 max = vault.maxWithdraw(lp1);
        assertLe(max, 200 * E18);
        vm.prank(lp1);
        vm.expectRevert();
        vault.withdraw(max + 1, lp1, lp1);
        vm.prank(lp1);
        vault.withdraw(max, lp1, lp1);
    }

    function test_maxRedeem_isBalanceWhenLiquid() public {
        uint256 s = _deposit(lp1, 1000 * E18);
        assertEq(vault.maxRedeem(lp1), s);
        assertEq(vault.maxRedeem(lp2), 0, "non-holder");
    }

    function test_utilizationAndTotalAssetsWithOutstandingPrincipal() public {
        _deposit(lp1, 4000 * E18);
        assertEq(vault.utilizationBps(), 0);
        vault.simulateAdvance(900 * E18, sink);
        assertEq(vault.outstandingPrincipal(), 900 * E18);
        assertEq(vault.totalAssets(), 4000 * E18);
        assertEq(vault.utilizationBps(), 2250);
    }

    function test_utilization_zeroWhenNavZero() public view {
        assertEq(vault.utilizationBps(), 0);
    }

    // ------------------------------------------------------------------ inflation / dust / rounding

    function test_inflationAttack_victimLosesOnlyDust_attackerLosesMoney() public {
        // Attacker front-runs: 1 wei deposit, then donates a large amount.
        vm.prank(attacker);
        vault.deposit(1, attacker);
        uint256 donation = 1000 * E18;
        vm.prank(attacker);
        rlusd.transfer(address(vault), donation);

        uint256 victimDeposit = 1000 * E18;
        uint256 vShares = _deposit(lp1, victimDeposit);
        assertGt(vShares, 0, "victim is not rounded to zero shares");

        uint256 victimValue = vault.convertToAssets(vShares);
        assertGe(victimValue, victimDeposit - victimDeposit / 1e6, "victim loss < 1e-6 relative");

        uint256 attackerValue = vault.convertToAssets(vault.balanceOf(attacker));
        assertLt(attackerValue, donation + 1, "attacker cannot profit from the donation");
    }

    function test_dust_oneWeiDepositRoundTripNeverProfits() public {
        vm.prank(lp1);
        uint256 shares = vault.deposit(1, lp1);
        assertEq(shares, 1e6);
        vm.prank(lp1);
        uint256 out = vault.redeem(shares, lp1, lp1);
        assertLe(out, 1);
    }

    function test_dust_subOneWeiShares_redeemZeroAssets() public {
        _deposit(lp1, 1000 * E18);
        _deposit(lp2, 1000 * E18);
        // 1 share-wei (1e-24 shares) is worth far less than 1 wei of RLUSD.
        vm.prank(lp1);
        uint256 out = vault.redeem(1, lp1, lp1);
        assertEq(out, 0);
    }

    function testFuzz_roundTripNeverProfits(uint96 a, uint96 b, uint96 donation) public {
        uint256 first = bound(uint256(a), 1, 1_000_000 * E18);
        uint256 second = bound(uint256(b), 1, 1_000_000 * E18);
        _deposit(lp1, first);
        uint256 donated = bound(uint256(donation), 0, 1_000_000 * E18);
        if (donated > 0) {
            vm.prank(attacker);
            rlusd.transfer(address(vault), donated);
        }
        uint256 s2 = _deposit(lp2, second);

        uint256 before = rlusd.balanceOf(lp2);
        vm.prank(lp2);
        uint256 out = vault.redeem(s2, lp2, lp2);
        assertLe(out, second, "second depositor never profits from rounding");
        assertEq(rlusd.balanceOf(lp2), before + out);
    }

    function testFuzz_conversionsConsistent(uint96 deposits, uint96 shares) public {
        _deposit(lp1, bound(uint256(deposits), 1, 1_000_000 * E18));
        uint256 s = bound(uint256(shares), 0, vault.totalSupply());
        uint256 assets = vault.convertToAssets(s);
        assertLe(vault.convertToShares(assets), s, "assets->shares never exceeds original shares");
        assertLe(vault.previewRedeem(s), vault.previewMint(s), "mint costs at least redeem pays");
    }

    function testFuzz_totalAssetsEqualsCashPlusPrincipal(uint96 dep, uint96 adv, uint96 don)
        public
    {
        uint256 d = bound(uint256(dep), 1 * E18, 1_000_000 * E18);
        _deposit(lp1, d);
        uint256 a = bound(uint256(adv), 0, d);
        vault.simulateAdvance(a, sink);
        uint256 x = bound(uint256(don), 0, 1_000_000 * E18);
        if (x > 0) {
            vm.prank(attacker);
            rlusd.transfer(address(vault), x);
        }
        assertEq(
            vault.totalAssets(), rlusd.balanceOf(address(vault)) + vault.outstandingPrincipal()
        );
        assertEq(vault.totalAssets(), d + x);
        assertLe(vault.maxWithdraw(lp1), vault.availableLiquidity());
    }

    function testFuzz_maxWithdrawIsWithdrawable(uint96 dep, uint96 adv) public {
        uint256 d = bound(uint256(dep), 1 * E18, 1_000_000 * E18);
        _deposit(lp1, d);
        _deposit(lp2, d);
        vault.simulateAdvance(bound(uint256(adv), 0, 2 * d), sink);
        uint256 max = vault.maxWithdraw(lp1);
        assertLe(max, vault.availableLiquidity());
        vm.prank(lp1);
        vault.withdraw(max, lp1, lp1);
        uint256 maxR = vault.maxRedeem(lp2);
        vm.prank(lp2);
        vault.redeem(maxR, lp2, lp2);
    }

    // ------------------------------------------------------------------ pause scaffolding

    function test_fullPause_blocksLpFlow_andMaxViewsReturnZero() public {
        uint256 s = _deposit(lp1, 1000 * E18);
        vm.prank(pauser);
        vault.pause();
        assertTrue(vault.paused());
        assertFalse(vault.advancesEnabled());

        assertEq(vault.maxDeposit(lp1), 0);
        assertEq(vault.maxMint(lp1), 0);
        assertEq(vault.maxRedeem(lp1), 0);
        assertEq(vault.maxWithdraw(lp1), 0);

        vm.startPrank(lp1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(1, lp1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.mint(1, lp1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.withdraw(1, lp1, lp1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.redeem(s, lp1, lp1);
        vm.stopPrank();

        // Shares stay transferable and the vault resumes after unpause.
        vm.prank(operator);
        vault.unpause();
        vm.prank(lp1);
        vault.redeem(s, lp1, lp1);
    }

    function test_advancePause_doesNotBlockLps() public {
        uint256 s = _deposit(lp1, 1000 * E18);
        vm.prank(pauser);
        vault.pauseAdvances();
        assertTrue(vault.advancesPaused());
        assertFalse(vault.paused());
        assertFalse(vault.advancesEnabled());

        _deposit(lp2, 10 * E18);
        vm.prank(lp1);
        vault.redeem(s, lp1, lp1);

        vm.prank(operator);
        vault.unpauseAdvances();
        assertTrue(vault.advancesEnabled());
    }

    function test_pauseAuthorization() public {
        // pauser and operator can pause; others cannot.
        vm.prank(lp1);
        vm.expectRevert();
        vault.pause();
        vm.prank(admin);
        vm.expectRevert();
        vault.pause();
        vm.prank(operator);
        vault.pause();

        // only the operator can unpause: pauser, admin and strangers cannot.
        vm.prank(pauser);
        vm.expectRevert();
        vault.unpause();
        vm.prank(admin);
        vm.expectRevert();
        vault.unpause();
        vm.prank(operator);
        vault.unpause();

        vm.prank(pauser);
        vault.pauseAdvances();
        vm.prank(pauser);
        vm.expectRevert();
        vault.unpauseAdvances();
        vm.prank(lp1);
        vm.expectRevert();
        vault.pauseAdvances();
        vm.prank(operator);
        vault.unpauseAdvances();
    }

    function test_pauseFlagsAreIndependent() public {
        vm.startPrank(operator);
        vault.pause();
        vault.pauseAdvances();
        vault.unpause();
        assertFalse(vault.paused());
        assertTrue(vault.advancesPaused());
        assertFalse(vault.advancesEnabled());
        vault.unpauseAdvances();
        assertTrue(vault.advancesEnabled());
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ escrow scaffolding

    function test_setEscrow_adminOnce() public {
        address esc = address(new DuelyVault(IERC20(address(rlusd)), admin, operator, pauser));
        assertEq(vault.escrow(), address(0));

        vm.prank(operator);
        vm.expectRevert();
        vault.setEscrow(esc);

        vm.prank(admin);
        vm.expectEmit(true, false, false, false, address(vault));
        emit IDuelyVault.EscrowSet(esc);
        vault.setEscrow(esc);
        assertEq(vault.escrow(), esc);

        vm.prank(admin);
        vm.expectRevert(IDuelyVault.EscrowAlreadySet.selector);
        vault.setEscrow(address(this));
    }

    function test_setEscrow_rejectsZeroAndEoa() public {
        vm.startPrank(admin);
        vm.expectRevert(IDuelyVault.InvalidAddress.selector);
        vault.setEscrow(address(0));
        vm.expectRevert(IDuelyVault.InvalidAddress.selector);
        vault.setEscrow(makeAddr("eoa"));
        vm.stopPrank();
        assertEq(vault.escrow(), address(0), "failed attempts do not spend the one-time right");
    }

    function test_advanceFlow_revertsUntilA3_forEveryCaller() public {
        address esc = address(new DuelyVault(IERC20(address(rlusd)), admin, operator, pauser));
        vm.prank(admin);
        vault.setEscrow(esc);
        _deposit(lp1, 4000 * E18);

        address[5] memory callers = [esc, admin, operator, lp1, address(this)];
        for (uint256 i; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert(IDuelyVault.AdvanceFlowNotImplemented.selector);
            vault.fundAdvance(1, lp2, 1000 * E18, 900 * E18, 30 * E18);
            vm.expectRevert(IDuelyVault.AdvanceFlowNotImplemented.selector);
            vault.recordRepayment(1);
            vm.expectRevert(IDuelyVault.AdvanceFlowNotImplemented.selector);
            vault.finalizeLoss(1);
            vm.stopPrank();
        }
        assertEq(vault.outstandingPrincipal(), 0);
        assertEq(rlusd.balanceOf(lp2), 1_000_000 * E18, "no funds moved");
    }

    // ------------------------------------------------------------------ views

    function test_getAdvance_defaultsToNone() public view {
        IDuelyVault.Advance memory a = vault.getAdvance(42);
        assertEq(uint8(a.status), uint8(IDuelyVault.AdvanceStatus.None));
        assertEq(a.principal, 0);
        assertEq(a.freelancer, address(0));
    }

    function test_maxAdvanceNow_zeroUntilEscrowSet_thenMinOfLimits() public {
        _deposit(lp1, 4000 * E18);
        assertEq(vault.maxAdvanceNow(), 0, "no escrow yet");

        address esc = address(new DuelyVault(IERC20(address(rlusd)), admin, operator, pauser));
        vm.prank(admin);
        vault.setEscrow(esc);
        assertEq(vault.maxAdvanceNow(), 1000 * E18, "25% of NAV binds first");

        vm.prank(pauser);
        vault.pauseAdvances();
        assertEq(vault.maxAdvanceNow(), 0, "advances paused");
        vm.prank(operator);
        vault.unpauseAdvances();

        vault.simulateAdvance(2500 * E18, sink); // utilization headroom: 3200 - 2500 = 700
        assertEq(vault.maxAdvanceNow(), 700 * E18);
    }

    // ------------------------------------------------------------------ issuer controls on RLUSD

    function test_issuerPause_blocksDepositAndRedeem_noAccountingDrift() public {
        uint256 s = _deposit(lp1, 1000 * E18);
        rlusd.pause();
        vm.prank(lp2);
        vm.expectRevert();
        vault.deposit(1 * E18, lp2);
        vm.prank(lp1);
        vm.expectRevert();
        vault.redeem(s, lp1, lp1);
        assertEq(vault.balanceOf(lp1), s, "failed redeem burned nothing");
        assertEq(vault.totalAssets(), 1000 * E18);
        rlusd.unpause();
    }

    function test_issuerClawback_lowersNavWithRealBalance() public {
        _deposit(lp1, 1000 * E18);
        rlusd.clawback(address(vault), 100 * E18);
        assertEq(vault.totalAssets(), 900 * E18);
        _assertValue(lp1, 900 * E18);
    }
}
