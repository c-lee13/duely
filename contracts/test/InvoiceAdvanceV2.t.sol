// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {DuelyVault} from "../src/DuelyVault.sol";
import {IDuelyVault} from "../src/IDuelyVault.sol";
import {InvoiceAdvanceV2} from "../src/InvoiceAdvanceV2.sol";
import {IInvoiceAdvanceV2} from "../src/IInvoiceAdvanceV2.sol";
import {RLUSDLikeToken} from "./mocks/RLUSDLikeToken.sol";
import {TogglableFeeToken} from "./mocks/TogglableFeeToken.sol";

/// A4: InvoiceAdvanceV2 + DuelyVault settlement, end to end with the real contracts.
contract InvoiceAdvanceV2Test is Test {
    uint256 internal constant E18 = 1e18;
    bytes32 internal constant META = keccak256("agreement");
    bytes32 internal constant EVAL = keccak256("evaluation");

    RLUSDLikeToken internal rlusd;
    DuelyVault internal vault;
    InvoiceAdvanceV2 internal escrow;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal evaluator = makeAddr("evaluator");
    address internal pauser = makeAddr("pauser");
    address internal lp1 = makeAddr("lp1");
    address internal lp2 = makeAddr("lp2");
    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal stranger = makeAddr("stranger");

    struct Balances {
        uint256 client;
        uint256 freelancer;
        uint256 vault;
        uint256 escrow;
    }

    function setUp() public {
        rlusd = new RLUSDLikeToken();
        vault = new DuelyVault(IERC20(address(rlusd)), admin, operator, pauser);
        escrow = new InvoiceAdvanceV2(
            IERC20(address(rlusd)), IDuelyVault(address(vault)), admin, operator, evaluator
        );
        vm.prank(admin);
        vault.setEscrow(address(escrow));

        _lp(lp1, 3000 * E18);
        _lp(lp2, 1000 * E18);
        rlusd.mint(client, 10_000 * E18);
        vm.prank(client);
        rlusd.approve(address(escrow), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _lp(address who, uint256 amount) internal {
        rlusd.mint(who, amount);
        vm.startPrank(who);
        rlusd.approve(address(vault), type(uint256).max);
        vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _bal() internal view returns (Balances memory b) {
        b = Balances(
            rlusd.balanceOf(client),
            rlusd.balanceOf(freelancer),
            rlusd.balanceOf(address(vault)),
            rlusd.balanceOf(address(escrow))
        );
    }

    function _sum(Balances memory b) internal pure returns (uint256) {
        return b.client + b.freelancer + b.vault + b.escrow;
    }

    function _create(uint256 amount) internal returns (uint256 id) {
        vm.prank(client);
        id = escrow.createInvoice(freelancer, amount, META);
    }

    function _funded(uint256 amount) internal returns (uint256 id) {
        id = _create(amount);
        vm.prank(client);
        escrow.fundInvoice(id);
    }

    function _advanced(uint256 amount) internal returns (uint256 id) {
        id = _funded(amount);
        vm.prank(evaluator);
        escrow.approveAdvance(id, EVAL);
    }

    function _status(uint256 id) internal view returns (IInvoiceAdvanceV2.InvoiceStatus) {
        return escrow.getInvoice(id).status;
    }

    function _lpValue(address lp) internal view returns (uint256) {
        return vault.convertToAssets(vault.balanceOf(lp));
    }

    function _snapshot(uint256 id) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                _bal(),
                escrow.totalEscrow(),
                escrow.getInvoice(id),
                vault.outstandingPrincipal(),
                vault.totalAssets(),
                vault.totalFeesEarned(),
                vault.totalRealizedLosses(),
                vault.getAdvance(id)
            )
        );
    }

    // ------------------------------------------------------------------ lifecycle: approved

    function test_lifecycle_approval_withAdvance_everyBalanceMove() public {
        Balances memory s0 = _bal();
        uint256 total0 = _sum(s0);
        assertEq(s0.client, 10_000 * E18);
        assertEq(s0.vault, 4000 * E18);

        // 1. Client escrows 100% (1,000).
        uint256 id = _funded(1000 * E18);
        Balances memory s1 = _bal();
        assertEq(s1.client, 9000 * E18);
        assertEq(s1.escrow, 1000 * E18);
        assertEq(escrow.totalEscrow(), 1000 * E18);
        assertEq(_sum(s1), total0);

        // 2. Evaluator approves; the VAULT pays the freelancer 900. Escrow is untouched.
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IInvoiceAdvanceV2.AdvancePaid(id, freelancer, 900 * E18, 30 * E18, EVAL);
        vm.prank(evaluator);
        escrow.approveAdvance(id, EVAL);
        Balances memory s2 = _bal();
        assertEq(s2.freelancer, 900 * E18);
        assertEq(s2.vault, 3100 * E18);
        assertEq(s2.escrow, 1000 * E18, "client escrow untouched");
        assertEq(vault.outstandingPrincipal(), 900 * E18);
        assertEq(vault.totalAssets(), 4000 * E18, "advance does not change NAV");
        assertEq(_sum(s2), total0);
        IInvoiceAdvanceV2.Invoice memory inv = escrow.getInvoice(id);
        assertEq(inv.advanceAmount, 900 * E18);
        assertEq(inv.advanceFee, 30 * E18, "fee fixed at funding");
        assertEq(inv.evaluationHash, EVAL);
        assertEq(uint8(inv.status), uint8(IInvoiceAdvanceV2.InvoiceStatus.Advanced));

        // 3. Client approves: the vault is repaid 930 (900 + 30); the freelancer's remaining 70 is
        // CREDITED and stays reserved in the escrow (pull payment).
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IInvoiceAdvanceV2.InvoiceSettled(id, 900 * E18, 30 * E18, 70 * E18);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IInvoiceAdvanceV2.ProceedsCredited(id, freelancer, 70 * E18);
        vm.prank(client);
        escrow.approveCompletion(id);
        Balances memory s3 = _bal();
        assertEq(s3.client, 9000 * E18, "client paid 1,000 total");
        assertEq(s3.freelancer, 900 * E18, "nothing pushed to the freelancer yet");
        assertEq(s3.vault, 4030 * E18, "vault 3100 + 930");
        assertEq(s3.escrow, 70 * E18, "the 70 stays reserved in the escrow");
        assertEq(escrow.totalEscrow(), 0);
        assertEq(escrow.claimable(freelancer), 70 * E18);
        assertEq(escrow.totalClaimable(), 70 * E18);
        assertEq(_sum(s3), total0, "exact conservation");
        assertEq(vault.outstandingPrincipal(), 0);
        assertEq(vault.totalAssets(), 4030 * E18, "NAV +30");
        assertEq(vault.totalFeesEarned(), 30 * E18);
        assertEq(vault.totalRealizedLosses(), 0);
        assertEq(uint8(vault.getAdvance(id).status), uint8(IDuelyVault.AdvanceStatus.Repaid));
        assertEq(uint8(_status(id)), uint8(IInvoiceAdvanceV2.InvoiceStatus.Settled));

        // 4. Anyone may trigger the claim; the money still goes to the freelancer.
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IInvoiceAdvanceV2.ProceedsClaimed(freelancer, stranger, 70 * E18);
        vm.prank(stranger);
        escrow.claim(freelancer);
        Balances memory s4 = _bal();
        assertEq(s4.freelancer, 970 * E18, "900 + 70");
        assertEq(s4.escrow, 0);
        assertEq(escrow.totalClaimable(), 0);
        assertEq(_sum(s4), total0);
        // LP value: +0.75% pro rata.
        assertApproxEqAbs(_lpValue(lp1), 3022.5e18, 2);
        assertApproxEqAbs(_lpValue(lp2), 1007.5e18, 2);
    }

    function test_lifecycle_approval_withoutAdvance_fullAmountToFreelancer_noFee() public {
        uint256 id = _funded(1000 * E18);
        uint256 total0 = _sum(_bal());
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IInvoiceAdvanceV2.InvoiceSettled(id, 0, 0, 1000 * E18);
        vm.prank(client);
        escrow.approveCompletion(id);
        assertEq(escrow.claimable(freelancer), 1000 * E18, "credited, still reserved in the escrow");
        assertEq(_bal().escrow, 1000 * E18);
        escrow.claim(freelancer);
        Balances memory s = _bal();
        assertEq(s.freelancer, 1000 * E18);
        assertEq(s.client, 9000 * E18);
        assertEq(s.escrow, 0);
        assertEq(s.vault, 4000 * E18, "vault untouched");
        assertEq(_sum(s), total0);
        assertEq(vault.totalAssets(), 4000 * E18);
        assertEq(vault.totalFeesEarned(), 0);
        assertEq(uint8(vault.getAdvance(id).status), uint8(IDuelyVault.AdvanceStatus.None));
    }

    // ------------------------------------------------------------------ lifecycle: disputes

    function test_dispute_freelancerWins_settlesLikeApproval() public {
        uint256 id = _advanced(1000 * E18);
        uint256 total0 = _sum(_bal());

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IInvoiceAdvanceV2.InvoiceDisputed(id, client, 900 * E18);
        vm.prank(client);
        escrow.raiseDispute(id);

        // Ordinary settlement and further advances are frozen.
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvanceV2.InvalidStatus.selector,
                id,
                IInvoiceAdvanceV2.InvoiceStatus.Disputed
            )
        );
        escrow.approveCompletion(id);
        vm.prank(evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvanceV2.InvalidStatus.selector,
                id,
                IInvoiceAdvanceV2.InvoiceStatus.Disputed
            )
        );
        escrow.approveAdvance(id, EVAL);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit IInvoiceAdvanceV2.DisputeResolved(id, true, 0);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IInvoiceAdvanceV2.InvoiceSettled(id, 900 * E18, 30 * E18, 70 * E18);
        vm.prank(operator);
        escrow.resolveDispute(id, true);
        escrow.claim(freelancer);

        Balances memory s = _bal();
        assertEq(s.client, 9000 * E18);
        assertEq(s.freelancer, 970 * E18);
        assertEq(s.vault, 4030 * E18);
        assertEq(s.escrow, 0);
        assertEq(_sum(s), total0);
        assertEq(vault.totalAssets(), 4030 * E18);
        assertEq(vault.totalRealizedLosses(), 0);
        assertEq(uint8(_status(id)), uint8(IInvoiceAdvanceV2.InvoiceStatus.Settled));
    }

    function test_dispute_clientWins_withAdvance_refundsAll_vaultRealizesLoss() public {
        uint256 id = _advanced(1000 * E18);
        uint256 total0 = _sum(_bal());
        vm.prank(client);
        escrow.raiseDispute(id);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit IInvoiceAdvanceV2.DisputeResolved(id, false, 900 * E18);
        vm.expectEmit(true, false, false, false, address(escrow));
        emit IInvoiceAdvanceV2.InvoiceCancelled(id);
        vm.prank(operator);
        escrow.resolveDispute(id, false);

        // Ruling recorded; the refund is credited, not yet paid.
        Balances memory mid = _bal();
        assertEq(mid.client, 9000 * E18);
        assertEq(mid.escrow, 1000 * E18, "refund reserved in the escrow");
        assertEq(escrow.claimable(client), 1000 * E18);
        assertEq(escrow.totalEscrow(), 0);
        assertEq(vault.totalRealizedLosses(), 900 * E18, "loss does not wait for the claim");

        escrow.claim(client);
        Balances memory s = _bal();
        assertEq(s.client, 10_000 * E18, "client refunded the full 1,000");
        assertEq(s.freelancer, 900 * E18, "advance is never clawed back");
        assertEq(s.vault, 3100 * E18, "vault does not recover any cash");
        assertEq(s.escrow, 0);
        assertEq(_sum(s), total0);
        assertEq(escrow.totalClaimable(), 0);

        assertEq(vault.outstandingPrincipal(), 0);
        assertEq(vault.totalAssets(), 3100 * E18, "NAV -900, exactly once");
        assertEq(vault.totalFeesEarned(), 0, "no fee on a loss");
        IDuelyVault.Advance memory a = vault.getAdvance(id);
        assertEq(uint8(a.status), uint8(IDuelyVault.AdvanceStatus.Lost));
        assertEq(a.loss, 900 * E18);
        assertEq(a.feeEarned, 0);
        assertEq(uint8(_status(id)), uint8(IInvoiceAdvanceV2.InvoiceStatus.Cancelled));
        // LPs bear 22.5% pro rata.
        assertApproxEqAbs(_lpValue(lp1), 2325 * E18, 2);
        assertApproxEqAbs(_lpValue(lp2), 775 * E18, 2);
    }

    function test_dispute_clientWins_withoutAdvance_justRefunds() public {
        uint256 id = _funded(1000 * E18);
        vm.prank(client);
        escrow.raiseDispute(id);
        vm.prank(operator);
        escrow.resolveDispute(id, false);
        escrow.claim(client);

        Balances memory s = _bal();
        assertEq(s.client, 10_000 * E18);
        assertEq(s.freelancer, 0);
        assertEq(s.vault, 4000 * E18);
        assertEq(s.escrow, 0);
        assertEq(vault.totalAssets(), 4000 * E18);
        assertEq(vault.totalRealizedLosses(), 0);
        assertEq(uint8(vault.getAdvance(id).status), uint8(IDuelyVault.AdvanceStatus.None));
    }

    // ------------------------------------------------------------------ duplicates / terminal states

    function test_noDoubleSettlement_noDoubleAdvance() public {
        uint256 id = _advanced(1000 * E18);
        vm.prank(evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvanceV2.InvalidStatus.selector,
                id,
                IInvoiceAdvanceV2.InvoiceStatus.Advanced
            )
        );
        escrow.approveAdvance(id, EVAL);

        vm.prank(client);
        escrow.approveCompletion(id);
        bytes32 snap = _snapshot(id);

        vm.startPrank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvanceV2.InvalidStatus.selector,
                id,
                IInvoiceAdvanceV2.InvoiceStatus.Settled
            )
        );
        escrow.approveCompletion(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvanceV2.InvalidStatus.selector,
                id,
                IInvoiceAdvanceV2.InvoiceStatus.Settled
            )
        );
        escrow.raiseDispute(id);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvanceV2.InvalidStatus.selector,
                id,
                IInvoiceAdvanceV2.InvoiceStatus.Settled
            )
        );
        escrow.resolveDispute(id, true);
        vm.prank(evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvanceV2.InvalidStatus.selector,
                id,
                IInvoiceAdvanceV2.InvoiceStatus.Settled
            )
        );
        escrow.approveAdvance(id, EVAL);
        assertEq(_snapshot(id), snap, "nothing moved on any duplicate");
    }

    function test_noDoubleResolution() public {
        uint256 id = _advanced(1000 * E18);
        vm.prank(client);
        escrow.raiseDispute(id);
        vm.prank(operator);
        escrow.resolveDispute(id, false);
        bytes32 snap = _snapshot(id);

        vm.startPrank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvanceV2.InvalidStatus.selector,
                id,
                IInvoiceAdvanceV2.InvoiceStatus.Cancelled
            )
        );
        escrow.resolveDispute(id, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvanceV2.InvalidStatus.selector,
                id,
                IInvoiceAdvanceV2.InvoiceStatus.Cancelled
            )
        );
        escrow.resolveDispute(id, true);
        vm.stopPrank();
        assertEq(_snapshot(id), snap, "loss is recognized once");
    }

    // ------------------------------------------------------------------ authorization

    function test_approveAdvance_onlyEvaluator() public {
        uint256 id = _funded(1000 * E18);
        bytes32 role = escrow.EVALUATOR_ROLE();
        address[5] memory callers = [client, freelancer, operator, admin, stranger];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector, callers[i], role
                )
            );
            escrow.approveAdvance(id, EVAL);
        }
        assertEq(vault.outstandingPrincipal(), 0);
    }

    function test_evaluatorCannotSettleDisputeOrTouchVault() public {
        uint256 id = _advanced(1000 * E18);
        vm.startPrank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvanceV2.NotInvoiceClient.selector, id));
        escrow.approveCompletion(id);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvanceV2.NotInvoiceClient.selector, id));
        escrow.raiseDispute(id);
        vm.expectRevert();
        escrow.resolveDispute(id, true);
        vm.expectRevert(IDuelyVault.NotEscrow.selector);
        vault.fundAdvance(99, freelancer, 1000 * E18, 900 * E18, 30 * E18);
        vm.expectRevert(IDuelyVault.NotEscrow.selector);
        vault.recordRepayment(id);
        vm.expectRevert(IDuelyVault.NotEscrow.selector);
        vault.finalizeLoss(id);
        vm.stopPrank();
    }

    function test_onlyOperatorResolves_onlyClientApprovesOrDisputes() public {
        uint256 id = _advanced(1000 * E18);
        address[4] memory notClient = [freelancer, operator, admin, stranger];
        for (uint256 i; i < notClient.length; i++) {
            vm.startPrank(notClient[i]);
            vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvanceV2.NotInvoiceClient.selector, id));
            escrow.approveCompletion(id);
            vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvanceV2.NotInvoiceClient.selector, id));
            escrow.raiseDispute(id);
            vm.stopPrank();
        }
        vm.prank(client);
        escrow.raiseDispute(id);
        address[4] memory notOperator = [client, freelancer, evaluator, admin];
        for (uint256 i; i < notOperator.length; i++) {
            vm.prank(notOperator[i]);
            vm.expectRevert();
            escrow.resolveDispute(id, false);
        }
    }

    function test_createFundCancel_rules() public {
        uint256 id = _create(500 * E18);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvanceV2.NotInvoiceClient.selector, id));
        escrow.fundInvoice(id);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvanceV2.NotInvoiceClient.selector, id));
        escrow.cancelInvoice(id);

        // An unfunded invoice cannot be advanced.
        vm.prank(evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvanceV2.InvalidStatus.selector,
                id,
                IInvoiceAdvanceV2.InvoiceStatus.Created
            )
        );
        escrow.approveAdvance(id, EVAL);

        vm.prank(client);
        escrow.cancelInvoice(id);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvanceV2.InvalidStatus.selector,
                id,
                IInvoiceAdvanceV2.InvoiceStatus.Cancelled
            )
        );
        escrow.fundInvoice(id);

        // Once funded, cancellation is no longer possible.
        uint256 id2 = _funded(500 * E18);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvanceV2.InvalidStatus.selector,
                id2,
                IInvoiceAdvanceV2.InvoiceStatus.Funded
            )
        );
        escrow.cancelInvoice(id2);
    }

    function test_createInvoice_validation() public {
        vm.startPrank(client);
        vm.expectRevert(IInvoiceAdvanceV2.InvalidAddress.selector);
        escrow.createInvoice(address(0), 1, META);
        vm.expectRevert(IInvoiceAdvanceV2.InvalidAddress.selector);
        escrow.createInvoice(address(vault), 1, META);
        vm.expectRevert(IInvoiceAdvanceV2.InvalidAddress.selector);
        escrow.createInvoice(address(escrow), 1, META);
        vm.expectRevert(IInvoiceAdvanceV2.InvalidAddress.selector);
        escrow.createInvoice(address(rlusd), 1, META);
        vm.expectRevert(IInvoiceAdvanceV2.InvalidInvoiceParties.selector);
        escrow.createInvoice(client, 1, META);
        vm.expectRevert(IInvoiceAdvanceV2.InvalidAmount.selector);
        escrow.createInvoice(freelancer, 0, META);
        vm.expectRevert(IInvoiceAdvanceV2.InvalidHash.selector);
        escrow.createInvoice(freelancer, 1, bytes32(0));
        vm.stopPrank();
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvanceV2.InvoiceNotFound.selector, 99));
        escrow.approveAdvance(99, EVAL);
    }

    function test_approveAdvance_requiresEvaluationHash() public {
        uint256 id = _funded(1000 * E18);
        vm.prank(evaluator);
        vm.expectRevert(IInvoiceAdvanceV2.InvalidHash.selector);
        escrow.approveAdvance(id, bytes32(0));
    }

    // ------------------------------------------------------------------ failed transfers roll back everything

    function test_approveAdvance_vaultRejection_rollsBackInvoiceState() public {
        uint256 big = _funded(2000 * E18); // 1,800 advance > 25% of NAV (1,000)
        bytes32 snap = _snapshot(big);
        vm.prank(evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDuelyVault.ExceedsInvoiceExposureLimit.selector, 1800 * E18, 1000 * E18
            )
        );
        escrow.approveAdvance(big, EVAL);
        assertEq(_snapshot(big), snap);
        assertEq(uint8(_status(big)), uint8(IInvoiceAdvanceV2.InvoiceStatus.Funded));
        assertEq(escrow.getInvoice(big).advanceAmount, 0);
        assertEq(escrow.getInvoice(big).evaluationHash, bytes32(0));
    }

    function test_approveAdvance_respectsBothVaultPauses() public {
        uint256 id = _funded(1000 * E18);
        bytes32 snap = _snapshot(id);

        vm.prank(pauser);
        vault.pause();
        vm.prank(evaluator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.approveAdvance(id, EVAL);
        vm.prank(operator);
        vault.unpause();

        vm.prank(pauser);
        vault.pauseAdvances();
        vm.prank(evaluator);
        vm.expectRevert(IDuelyVault.AdvancesAreDisabled.selector);
        escrow.approveAdvance(id, EVAL);
        assertEq(_snapshot(id), snap);

        vm.prank(operator);
        vault.unpauseAdvances();
        vm.prank(evaluator);
        escrow.approveAdvance(id, EVAL);
    }

    function test_settlement_failedTransfer_revertsWholeSettlement() public {
        uint256 id = _advanced(1000 * E18);
        bytes32 snap = _snapshot(id);
        rlusd.pause(); // issuer pause: every transfer reverts
        vm.prank(client);
        vm.expectRevert();
        escrow.approveCompletion(id);
        rlusd.unpause();
        assertEq(_snapshot(id), snap, "no half-settled state");
        assertEq(uint8(_status(id)), uint8(IInvoiceAdvanceV2.InvoiceStatus.Advanced));
        assertEq(uint8(vault.getAdvance(id).status), uint8(IDuelyVault.AdvanceStatus.Open));

        vm.prank(client);
        escrow.approveCompletion(id); // retry succeeds
        assertEq(vault.totalAssets(), 4030 * E18);
    }

    /// @dev Pull payments: the refund ruling no longer moves tokens, so an issuer pause cannot block it or
    /// the loss recognition; the client's credit survives until the token works again.
    function test_refund_isCredited_issuerPauseCannotBlockRulingOrLoseTheClaim() public {
        uint256 id = _advanced(1000 * E18);
        vm.prank(client);
        escrow.raiseDispute(id);
        rlusd.pause();
        vm.prank(operator);
        escrow.resolveDispute(id, false);
        assertEq(vault.totalRealizedLosses(), 900 * E18, "loss recorded despite the pause");
        assertEq(uint8(_status(id)), uint8(IInvoiceAdvanceV2.InvoiceStatus.Cancelled));
        assertEq(escrow.claimable(client), 1000 * E18);

        vm.expectRevert();
        escrow.claim(client);
        assertEq(escrow.claimable(client), 1000 * E18, "failed claim destroys nothing");
        rlusd.unpause();
        escrow.claim(client);
        assertEq(rlusd.balanceOf(client), 10_000 * E18);
    }

    function test_fundInvoice_failures_leaveInvoiceCreated() public {
        uint256 id = _create(1000 * E18);
        vm.prank(client);
        rlusd.approve(address(escrow), 0);
        vm.prank(client);
        vm.expectRevert();
        escrow.fundInvoice(id);
        assertEq(uint8(_status(id)), uint8(IInvoiceAdvanceV2.InvoiceStatus.Created));
        assertEq(escrow.totalEscrow(), 0);
    }

    function test_fundInvoice_rejectsFeeOnTransferToken() public {
        TogglableFeeToken tok = new TogglableFeeToken();
        DuelyVault v = new DuelyVault(IERC20(address(tok)), admin, operator, pauser);
        InvoiceAdvanceV2 e = new InvoiceAdvanceV2(
            IERC20(address(tok)), IDuelyVault(address(v)), admin, operator, evaluator
        );
        tok.mint(client, 1000 * E18);
        vm.startPrank(client);
        tok.approve(address(e), type(uint256).max);
        uint256 id = e.createInvoice(freelancer, 1000 * E18, META);
        tok.setTax(true);
        vm.expectRevert(IInvoiceAdvanceV2.UnsupportedTokenBehavior.selector);
        e.fundInvoice(id);
        vm.stopPrank();
        assertEq(e.totalEscrow(), 0);
    }

    // ------------------------------------------------------------------ pauses never block settlement

    function test_settlement_andRefund_workDuringFullVaultPause() public {
        uint256 a = _advanced(1000 * E18);
        uint256 b = _advanced(1000 * E18);
        vm.prank(client);
        escrow.raiseDispute(b);
        vm.startPrank(operator);
        vault.pause();
        vault.pauseAdvances();
        vm.stopPrank();

        vm.prank(client);
        escrow.approveCompletion(a);
        vm.prank(operator);
        escrow.resolveDispute(b, false);

        assertEq(vault.totalAssets(), 4000 * E18 + 30 * E18 - 900 * E18);
        assertEq(vault.outstandingPrincipal(), 0);
        assertEq(vault.maxRedeem(lp1), 0, "LPs stay locked until unpause");
    }

    // ------------------------------------------------------------------ multiple LPs and concurrent advances

    function test_multiLp_profitThenLoss_distributedProRata() public {
        uint256 ok = _advanced(1000 * E18);
        vm.prank(client);
        escrow.approveCompletion(ok); // NAV 4030
        uint256 bad = _advanced(1000 * E18);
        vm.prank(client);
        escrow.raiseDispute(bad);
        vm.prank(operator);
        escrow.resolveDispute(bad, false); // NAV 3130

        assertEq(vault.totalAssets(), 3130 * E18);
        assertApproxEqAbs(_lpValue(lp1), 2347.5e18, 3);
        assertApproxEqAbs(_lpValue(lp2), 782.5e18, 3);
        assertApproxEqRel(_lpValue(lp1), 3 * _lpValue(lp2), 1e9, "still 3:1");
        assertEq(vault.totalFeesEarned(), 30 * E18);
        assertEq(vault.totalRealizedLosses(), 900 * E18);
    }

    function test_lpDepositingMidLifecycle_sharesCorrectly() public {
        uint256 id = _advanced(1000 * E18); // 900 deployed, NAV 4000
        address lp3 = makeAddr("lp3");
        _lp(lp3, 1000 * E18); // enters at the par price, NAV 5000
        vm.prank(client);
        escrow.approveCompletion(id); // +30 across 5000 of NAV
        assertApproxEqAbs(_lpValue(lp3), 1006 * E18, 3);
        assertApproxEqAbs(_lpValue(lp1), 3018 * E18, 3);
        assertApproxEqAbs(_lpValue(lp2), 1006 * E18, 3);
    }

    function test_concurrentAdvances_settleIndependently() public {
        uint256 a = _advanced(1000 * E18);
        uint256 b = _advanced(1000 * E18);
        uint256 c = _advanced(1000 * E18);
        assertEq(vault.outstandingPrincipal(), 2700 * E18);
        assertEq(vault.utilizationBps(), 6750);

        vm.prank(client);
        escrow.approveCompletion(a);
        vm.prank(client);
        escrow.raiseDispute(b);
        vm.prank(operator);
        escrow.resolveDispute(b, false);
        assertEq(vault.outstandingPrincipal(), 900 * E18, "only c still open");
        vm.prank(client);
        escrow.approveCompletion(c);

        assertEq(vault.outstandingPrincipal(), 0);
        assertEq(vault.totalAssets(), 4000 * E18 + 60 * E18 - 900 * E18);
        assertEq(escrow.totalEscrow(), 0);
        assertEq(rlusd.balanceOf(address(escrow)), escrow.totalClaimable(), "only credits remain");
        escrow.claim(freelancer);
        escrow.claim(client);
        assertEq(rlusd.balanceOf(address(escrow)), 0);
        assertEq(rlusd.balanceOf(address(vault)), vault.totalAssets(), "all principal back as cash");
    }

    // ------------------------------------------------------------------ quote and rounding

    function test_quoteAdvance() public view {
        (uint256 adv, uint256 fee, uint256 repay, uint256 rem) = escrow.quoteAdvance(1000 * E18);
        assertEq(adv, 900 * E18);
        assertEq(fee, 30 * E18);
        assertEq(repay, 930 * E18);
        assertEq(rem, 70 * E18);
        (adv, fee, repay, rem) = escrow.quoteAdvance(33);
        assertEq(adv, 29);
        assertEq(fee, 0);
        assertEq(rem, 4);
        (adv, fee, repay, rem) = escrow.quoteAdvance(0);
        assertEq(adv + fee + repay + rem, 0);
    }

    function testFuzz_quoteConservesAmount(uint128 amount) public view {
        (uint256 adv, uint256 fee, uint256 repay, uint256 rem) = escrow.quoteAdvance(amount);
        assertEq(adv + fee + rem, amount);
        assertEq(repay, adv + fee);
        assertLe(repay, amount);
    }

    function test_smallInvoices_roundingAndZeroAdvance() public {
        // 1 wei: floor(0.9) = 0 -> cannot be advanced, but can still be settled in full.
        uint256 tiny = _funded(1);
        vm.prank(evaluator);
        vm.expectRevert(IInvoiceAdvanceV2.ZeroAdvance.selector);
        escrow.approveAdvance(tiny, EVAL);
        vm.prank(client);
        escrow.approveCompletion(tiny);
        escrow.claim(freelancer);
        assertEq(rlusd.balanceOf(freelancer), 1);

        // 4 wei: advance 3, fee 0, remainder 1.
        uint256 small = _advanced(4);
        assertEq(escrow.getInvoice(small).advanceAmount, 3);
        assertEq(escrow.getInvoice(small).advanceFee, 0);
        vm.prank(client);
        escrow.approveCompletion(small);
        escrow.claim(freelancer);
        assertEq(rlusd.balanceOf(freelancer), 1 + 3 + 1);
        assertEq(vault.getAdvance(small).feeEarned, 0);
        assertEq(vault.totalAssets(), 4000 * E18, "zero fee, NAV unchanged");
    }

    // ------------------------------------------------------------------ wiring

    function test_constructor_validation() public {
        IERC20 t = IERC20(address(rlusd));
        IDuelyVault v = IDuelyVault(address(vault));
        vm.expectRevert(IInvoiceAdvanceV2.InvalidAddress.selector);
        new InvoiceAdvanceV2(IERC20(address(0)), v, admin, operator, evaluator);
        vm.expectRevert(IInvoiceAdvanceV2.InvalidAddress.selector);
        new InvoiceAdvanceV2(t, IDuelyVault(address(0)), admin, operator, evaluator);
        vm.expectRevert(IInvoiceAdvanceV2.InvalidAddress.selector);
        new InvoiceAdvanceV2(t, v, address(0), operator, evaluator);
        vm.expectRevert(IInvoiceAdvanceV2.InvalidAddress.selector);
        new InvoiceAdvanceV2(t, v, admin, address(0), evaluator);
        vm.expectRevert(IInvoiceAdvanceV2.InvalidAddress.selector);
        new InvoiceAdvanceV2(t, v, admin, operator, address(0));
        // Token that differs from the vault's asset.
        vm.expectRevert(IInvoiceAdvanceV2.VaultMismatch.selector);
        new InvoiceAdvanceV2(IERC20(address(new RLUSDLikeToken())), v, admin, operator, evaluator);
    }

    function test_vaultOnlyAcceptsItsOwnEscrow_andOnlyOnce() public {
        DuelyVault other = new DuelyVault(IERC20(address(rlusd)), admin, operator, pauser);
        // This escrow is wired to `vault`, not `other`.
        vm.prank(admin);
        vm.expectRevert(IDuelyVault.EscrowMismatch.selector);
        other.setEscrow(address(escrow));

        InvoiceAdvanceV2 mine = new InvoiceAdvanceV2(
            IERC20(address(rlusd)), IDuelyVault(address(other)), admin, operator, evaluator
        );
        vm.prank(admin);
        other.setEscrow(address(mine));
        vm.prank(admin);
        vm.expectRevert(IDuelyVault.EscrowAlreadySet.selector);
        other.setEscrow(address(escrow));
        assertEq(vault.escrow(), address(escrow));
    }

    function test_roles_areDistinctAndAdminHoldsNoInvoiceAuthority() public view {
        assertTrue(escrow.hasRole(escrow.EVALUATOR_ROLE(), evaluator));
        assertTrue(escrow.hasRole(escrow.OPERATOR_ROLE(), operator));
        assertFalse(escrow.hasRole(escrow.EVALUATOR_ROLE(), operator));
        assertFalse(escrow.hasRole(escrow.EVALUATOR_ROLE(), admin));
        assertFalse(escrow.hasRole(escrow.OPERATOR_ROLE(), admin));
        assertEq(address(escrow.vault()), address(vault));
        assertEq(address(escrow.paymentToken()), address(rlusd));
        assertEq(escrow.FEE_BPS(), vault.FEE_BPS());
    }

    // ------------------------------------------------------------------ light conservation fuzz (full suite is A5)

    function testFuzz_everyOutcomeConservesFunds(uint96 rawAmount, uint8 outcome, bool advance)
        public
    {
        uint256 amount = bound(uint256(rawAmount), 1, 1100 * E18);
        outcome = uint8(bound(outcome, 0, 2));
        Balances memory s0 = _bal();
        uint256 supply = rlusd.totalSupply();
        uint256 nav0 = vault.totalAssets();

        uint256 id = _funded(amount);
        (uint256 adv, uint256 fee,,) = escrow.quoteAdvance(amount);
        bool advanced;
        if (advance && adv > 0) {
            vm.prank(evaluator);
            escrow.approveAdvance(id, EVAL);
            advanced = true;
        }
        if (outcome == 0) {
            vm.prank(client);
            escrow.approveCompletion(id);
        } else {
            vm.prank(client);
            escrow.raiseDispute(id);
            vm.prank(operator);
            escrow.resolveDispute(id, outcome == 1);
        }

        // Everything credited is still reserved in the escrow until claimed.
        assertEq(rlusd.balanceOf(address(escrow)), escrow.totalClaimable());
        if (escrow.claimable(freelancer) > 0) escrow.claim(freelancer);
        if (escrow.claimable(client) > 0) escrow.claim(client);
        Balances memory s = _bal();
        assertEq(rlusd.totalSupply(), supply);
        assertEq(_sum(s), _sum(s0), "no value created or destroyed");
        assertEq(s.escrow, 0);
        assertEq(escrow.totalEscrow(), 0);
        assertEq(vault.outstandingPrincipal(), 0);

        if (outcome == 2) {
            // client wins: client whole, freelancer keeps any advance, vault loses it
            assertEq(s.client, s0.client);
            assertEq(s.freelancer, advanced ? adv : 0);
            assertEq(vault.totalAssets(), nav0 - (advanced ? adv : 0));
            assertEq(vault.totalRealizedLosses(), advanced ? adv : 0);
            assertEq(vault.totalFeesEarned(), 0);
        } else {
            uint256 feePaid = advanced ? fee : 0;
            assertEq(s.client, s0.client - amount);
            assertEq(s.freelancer, amount - feePaid);
            assertEq(vault.totalAssets(), nav0 + feePaid);
            assertEq(vault.totalFeesEarned(), feePaid);
            assertEq(vault.totalRealizedLosses(), 0);
        }
    }
}
