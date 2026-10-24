// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceAdvance} from "../src/InvoiceAdvance.sol";
import {IInvoiceAdvance} from "../src/IInvoiceAdvance.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @notice A3: advance, settlement and dispute flows.
contract InvoiceAdvanceSettlementTest is Test {
    InvoiceAdvance ia;
    MockUSDC token;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address evaluator = makeAddr("evaluator");
    address client = makeAddr("client");
    address freelancer = makeAddr("freelancer");
    address stranger = makeAddr("stranger");

    bytes32 constant META = keccak256("terms-v1");
    bytes32 constant EVAL = keccak256("eval-1");
    bytes32 constant OPERATOR = keccak256("OPERATOR_ROLE");
    bytes32 constant EVALUATOR = keccak256("EVALUATOR_ROLE");
    uint256 constant AMOUNT = 1_000e6;
    uint256 constant ADVANCE = 900e6;
    uint256 constant RESERVE = 10_000e6;

    function setUp() public {
        token = new MockUSDC(address(this));
        ia = new InvoiceAdvance(IERC20(address(token)), admin, operator, evaluator);
        token.mint(client, 10_000e6);
        token.mint(operator, 10_000e6);
        vm.prank(client);
        token.approve(address(ia), type(uint256).max);
        vm.prank(operator);
        token.approve(address(ia), type(uint256).max);
        vm.prank(operator);
        ia.depositReserve(RESERVE);
    }

    // ---- helpers ----

    function _funded() internal returns (uint256 id) {
        vm.startPrank(client);
        id = ia.createInvoice(freelancer, AMOUNT, META);
        ia.fundInvoice(id);
        vm.stopPrank();
    }

    function _advanced() internal returns (uint256 id) {
        id = _funded();
        vm.prank(evaluator);
        ia.approveAdvance(id, EVAL);
    }

    function _disputed(bool withAdvance) internal returns (uint256 id) {
        id = withAdvance ? _advanced() : _funded();
        vm.prank(client);
        ia.raiseDispute(id);
    }

    function _status(uint256 id) internal view returns (IInvoiceAdvance.InvoiceStatus) {
        return ia.getInvoice(id).status;
    }

    function _badStatus(uint256 id, IInvoiceAdvance.InvoiceStatus s)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(IInvoiceAdvance.InvalidStatus.selector, id, s);
    }

    function _unauthorized(address who, bytes32 role) internal pure returns (bytes memory) {
        return
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, who, role
            );
    }

    function _assertBooks() internal view {
        assertEq(token.balanceOf(address(ia)), ia.reserveBalance() + ia.totalEscrow());
    }

    // ---- happy path: 1000 -> 900 advance -> 900 repaid + 100 paid ----

    function test_fullWorkflow_advanceThenCompletion() public {
        uint256 id = _funded();
        assertEq(ia.reserveBalance(), RESERVE);
        assertEq(ia.totalEscrow(), AMOUNT);

        vm.expectEmit(true, true, false, true, address(ia));
        emit IInvoiceAdvance.AdvancePaid(id, freelancer, ADVANCE, EVAL);
        vm.prank(evaluator);
        ia.approveAdvance(id, EVAL);

        assertEq(token.balanceOf(freelancer), ADVANCE);
        assertEq(ia.reserveBalance(), RESERVE - ADVANCE);
        assertEq(ia.totalEscrow(), AMOUNT); // escrow untouched by advance
        IInvoiceAdvance.Invoice memory inv = ia.getInvoice(id);
        assertEq(uint256(inv.status), uint256(IInvoiceAdvance.InvoiceStatus.Advanced));
        assertEq(inv.advanceAmount, ADVANCE);
        assertEq(inv.evaluationHash, EVAL);
        _assertBooks();

        uint256 contractBefore = token.balanceOf(address(ia));
        vm.expectEmit(true, false, false, true, address(ia));
        emit IInvoiceAdvance.InvoiceSettled(id, ADVANCE, AMOUNT - ADVANCE);
        vm.prank(client);
        ia.approveCompletion(id);

        assertEq(token.balanceOf(freelancer), AMOUNT); // 900 + 100
        assertEq(ia.reserveBalance(), RESERVE); // repaid internally
        assertEq(ia.totalEscrow(), 0);
        assertEq(token.balanceOf(address(ia)), contractBefore - (AMOUNT - ADVANCE));
        assertEq(uint256(_status(id)), uint256(IInvoiceAdvance.InvoiceStatus.Settled));
        assertEq(ia.getInvoice(id).advanceAmount, ADVANCE); // recorded after settlement
        _assertBooks();
    }

    function test_completionWithoutAdvancePaysFullEscrow() public {
        uint256 id = _funded();
        vm.expectEmit(true, false, false, true, address(ia));
        emit IInvoiceAdvance.InvoiceSettled(id, 0, AMOUNT);
        vm.prank(client);
        ia.approveCompletion(id);

        assertEq(token.balanceOf(freelancer), AMOUNT);
        assertEq(ia.reserveBalance(), RESERVE);
        assertEq(ia.totalEscrow(), 0);
        assertEq(uint256(_status(id)), uint256(IInvoiceAdvance.InvoiceStatus.Settled));
        _assertBooks();
    }

    // ---- approveAdvance failures ----

    function test_advanceRejectsNonEvaluator() public {
        uint256 id = _funded();
        address[3] memory callers = [stranger, client, operator];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(_unauthorized(callers[i], EVALUATOR));
            ia.approveAdvance(id, EVAL);
        }
        vm.prank(admin);
        vm.expectRevert(_unauthorized(admin, EVALUATOR));
        ia.approveAdvance(id, EVAL);
    }

    function test_advanceRejectsDuplicateEvenWithNewHash() public {
        uint256 id = _advanced();
        vm.prank(evaluator);
        vm.expectRevert(_badStatus(id, IInvoiceAdvance.InvoiceStatus.Advanced));
        ia.approveAdvance(id, keccak256("eval-2"));
        assertEq(token.balanceOf(freelancer), ADVANCE);
        assertEq(ia.reserveBalance(), RESERVE - ADVANCE);
    }

    function test_advanceRejectsBeforeFundingAndAfterSettlement() public {
        vm.prank(client);
        uint256 created = ia.createInvoice(freelancer, AMOUNT, META);
        vm.prank(evaluator);
        vm.expectRevert(_badStatus(created, IInvoiceAdvance.InvoiceStatus.Created));
        ia.approveAdvance(created, EVAL);

        uint256 id = _funded();
        vm.prank(client);
        ia.approveCompletion(id);
        vm.prank(evaluator);
        vm.expectRevert(_badStatus(id, IInvoiceAdvance.InvoiceStatus.Settled));
        ia.approveAdvance(id, EVAL);
    }

    function test_advanceRejectsZeroHash() public {
        uint256 id = _funded();
        vm.prank(evaluator);
        vm.expectRevert(IInvoiceAdvance.InvalidHash.selector);
        ia.approveAdvance(id, bytes32(0));
    }

    function test_advanceRejectsUnknownInvoice() public {
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvance.InvoiceNotFound.selector, 99));
        ia.approveAdvance(99, EVAL);
    }

    function test_advanceRejectsInsufficientReserve() public {
        uint256 id = _funded();
        vm.prank(operator);
        ia.withdrawReserve(RESERVE - (ADVANCE - 1)); // leave 899.999999
        vm.prank(evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvance.InsufficientReserve.selector, ADVANCE, ADVANCE - 1
            )
        );
        ia.approveAdvance(id, EVAL);
        // escrow cannot finance the advance even though the contract holds enough tokens
        assertGe(token.balanceOf(address(ia)), ADVANCE);
        assertEq(uint256(_status(id)), uint256(IInvoiceAdvance.InvoiceStatus.Funded));
    }

    function test_advanceRejectsZeroAdvance() public {
        vm.startPrank(client);
        uint256 id = ia.createInvoice(freelancer, 1, META); // floor(1 * 0.9) == 0
        ia.fundInvoice(id);
        vm.stopPrank();
        vm.prank(evaluator);
        vm.expectRevert(IInvoiceAdvance.ZeroAdvance.selector);
        ia.approveAdvance(id, EVAL);
    }

    function test_advanceFloorRounding() public {
        vm.startPrank(client);
        uint256 id = ia.createInvoice(freelancer, 1_234_567, META);
        ia.fundInvoice(id);
        vm.stopPrank();
        vm.prank(evaluator);
        ia.approveAdvance(id, EVAL);
        assertEq(ia.getInvoice(id).advanceAmount, 1_111_110); // floor(1_234_567 * 0.9)
    }

    // ---- approveCompletion failures ----

    function test_completionRejectsNonClient() public {
        uint256 id = _advanced();
        address[3] memory callers = [freelancer, operator, evaluator];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvance.NotInvoiceClient.selector, id));
            ia.approveCompletion(id);
        }
    }

    function test_completionRejectsBeforeFunding() public {
        vm.startPrank(client);
        uint256 id = ia.createInvoice(freelancer, AMOUNT, META);
        vm.expectRevert(_badStatus(id, IInvoiceAdvance.InvoiceStatus.Created));
        ia.approveCompletion(id);
        vm.stopPrank();
    }

    function test_doubleSettlementReverts() public {
        uint256 id = _advanced();
        vm.startPrank(client);
        ia.approveCompletion(id);
        vm.expectRevert(_badStatus(id, IInvoiceAdvance.InvoiceStatus.Settled));
        ia.approveCompletion(id);
        vm.stopPrank();
        assertEq(token.balanceOf(freelancer), AMOUNT);
        assertEq(ia.reserveBalance(), RESERVE);
    }

    // ---- raiseDispute ----

    function test_disputeFreezesAdvanceAndCompletion() public {
        uint256 id = _funded();
        vm.expectEmit(true, true, false, true, address(ia));
        emit IInvoiceAdvance.InvoiceDisputed(id, client, 0);
        vm.prank(client);
        ia.raiseDispute(id);
        assertEq(uint256(_status(id)), uint256(IInvoiceAdvance.InvoiceStatus.Disputed));

        vm.prank(evaluator);
        vm.expectRevert(_badStatus(id, IInvoiceAdvance.InvoiceStatus.Disputed));
        ia.approveAdvance(id, EVAL);

        vm.startPrank(client);
        vm.expectRevert(_badStatus(id, IInvoiceAdvance.InvoiceStatus.Disputed));
        ia.approveCompletion(id);
        vm.expectRevert(_badStatus(id, IInvoiceAdvance.InvoiceStatus.Disputed));
        ia.raiseDispute(id);
        vm.stopPrank();
        assertEq(ia.totalEscrow(), AMOUNT);
    }

    function test_disputeAfterAdvanceReportsAdvance() public {
        uint256 id = _advanced();
        vm.expectEmit(true, true, false, true, address(ia));
        emit IInvoiceAdvance.InvoiceDisputed(id, client, ADVANCE);
        vm.prank(client);
        ia.raiseDispute(id);
    }

    function test_disputeRejections() public {
        uint256 id = _funded();
        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvance.NotInvoiceClient.selector, id));
        ia.raiseDispute(id);

        vm.startPrank(client);
        uint256 created = ia.createInvoice(freelancer, AMOUNT, META);
        vm.expectRevert(_badStatus(created, IInvoiceAdvance.InvoiceStatus.Created));
        ia.raiseDispute(created);

        ia.approveCompletion(id);
        vm.expectRevert(_badStatus(id, IInvoiceAdvance.InvoiceStatus.Settled));
        ia.raiseDispute(id);
        vm.stopPrank();
    }

    // ---- resolveDispute ----

    function test_resolveRelease_noAdvance() public {
        uint256 id = _disputed(false);
        vm.expectEmit(true, false, false, true, address(ia));
        emit IInvoiceAdvance.DisputeResolved(id, true, 0);
        vm.expectEmit(true, false, false, true, address(ia));
        emit IInvoiceAdvance.InvoiceSettled(id, 0, AMOUNT);
        vm.prank(operator);
        ia.resolveDispute(id, true);

        assertEq(token.balanceOf(freelancer), AMOUNT);
        assertEq(ia.reserveBalance(), RESERVE);
        assertEq(ia.totalEscrow(), 0);
        assertEq(uint256(_status(id)), uint256(IInvoiceAdvance.InvoiceStatus.Settled));
        _assertBooks();
    }

    function test_resolveRefund_noAdvance() public {
        uint256 id = _disputed(false);
        uint256 clientBefore = token.balanceOf(client);
        vm.expectEmit(true, false, false, true, address(ia));
        emit IInvoiceAdvance.DisputeResolved(id, false, 0);
        vm.expectEmit(true, false, false, false, address(ia));
        emit IInvoiceAdvance.InvoiceCancelled(id);
        vm.prank(operator);
        ia.resolveDispute(id, false);

        assertEq(token.balanceOf(client), clientBefore + AMOUNT);
        assertEq(token.balanceOf(freelancer), 0);
        assertEq(ia.reserveBalance(), RESERVE);
        assertEq(ia.totalEscrow(), 0);
        assertEq(uint256(_status(id)), uint256(IInvoiceAdvance.InvoiceStatus.Cancelled));
        _assertBooks();
    }

    function test_resolveRelease_withAdvance() public {
        uint256 id = _disputed(true);
        vm.expectEmit(true, false, false, true, address(ia));
        emit IInvoiceAdvance.InvoiceSettled(id, ADVANCE, AMOUNT - ADVANCE);
        vm.prank(operator);
        ia.resolveDispute(id, true);

        assertEq(token.balanceOf(freelancer), AMOUNT);
        assertEq(ia.reserveBalance(), RESERVE);
        assertEq(ia.totalEscrow(), 0);
        _assertBooks();
    }

    function test_resolveRefund_withAdvanceIsOperatorLoss() public {
        uint256 id = _disputed(true);
        uint256 clientBefore = token.balanceOf(client);
        vm.expectEmit(true, false, false, true, address(ia));
        emit IInvoiceAdvance.DisputeResolved(id, false, ADVANCE);
        vm.prank(operator);
        ia.resolveDispute(id, false);

        assertEq(token.balanceOf(client), clientBefore + AMOUNT); // full escrow back
        assertEq(token.balanceOf(freelancer), ADVANCE); // keeps advance
        assertEq(ia.reserveBalance(), RESERVE - ADVANCE); // loss, not double-debited
        assertEq(ia.totalEscrow(), 0);
        assertEq(uint256(_status(id)), uint256(IInvoiceAdvance.InvoiceStatus.Cancelled));
        _assertBooks();
    }

    function test_resolveRejectsNonOperatorAndNotDisputed() public {
        uint256 id = _disputed(true);
        address[4] memory callers = [stranger, client, evaluator, admin];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(_unauthorized(callers[i], OPERATOR));
            ia.resolveDispute(id, true);
        }

        uint256 funded = _funded();
        vm.prank(operator);
        vm.expectRevert(_badStatus(funded, IInvoiceAdvance.InvoiceStatus.Funded));
        ia.resolveDispute(funded, false);
    }

    function test_noActionsAfterResolution() public {
        uint256 id = _disputed(false);
        vm.prank(operator);
        ia.resolveDispute(id, false);

        vm.prank(operator);
        vm.expectRevert(_badStatus(id, IInvoiceAdvance.InvoiceStatus.Cancelled));
        ia.resolveDispute(id, true);
        vm.prank(evaluator);
        vm.expectRevert(_badStatus(id, IInvoiceAdvance.InvoiceStatus.Cancelled));
        ia.approveAdvance(id, EVAL);
        vm.startPrank(client);
        vm.expectRevert(_badStatus(id, IInvoiceAdvance.InvoiceStatus.Cancelled));
        ia.approveCompletion(id);
        vm.expectRevert(_badStatus(id, IInvoiceAdvance.InvoiceStatus.Cancelled));
        ia.raiseDispute(id);
        vm.stopPrank();
    }

    // ---- multi-invoice accounting ----

    function test_reserveWithdrawalBetweenAdvanceAndSettlement() public {
        uint256 a = _advanced();
        uint256 b = _funded();
        uint256 remaining = ia.reserveBalance();
        vm.prank(operator);
        ia.withdrawReserve(remaining); // drain reserve; escrow (2,000) untouched
        assertEq(ia.reserveBalance(), 0);
        assertEq(ia.totalEscrow(), 2 * AMOUNT);

        vm.prank(evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(IInvoiceAdvance.InsufficientReserve.selector, ADVANCE, 0)
        );
        ia.approveAdvance(b, EVAL);

        vm.startPrank(client);
        ia.approveCompletion(a);
        ia.approveCompletion(b);
        vm.stopPrank();
        assertEq(ia.reserveBalance(), ADVANCE);
        assertEq(ia.totalEscrow(), 0);
        assertEq(token.balanceOf(freelancer), 2 * AMOUNT);
        _assertBooks();
    }

    function testFuzz_advanceAndSettlementConservation(uint256 amount) public {
        amount = bound(amount, 2, 10_000e6);
        uint256 expected = (amount * 9_000) / 10_000;
        vm.startPrank(client);
        uint256 id = ia.createInvoice(freelancer, amount, META);
        ia.fundInvoice(id);
        vm.stopPrank();

        if (expected == 0) return;
        vm.assume(expected <= RESERVE);
        vm.prank(evaluator);
        ia.approveAdvance(id, EVAL);
        assertEq(ia.getInvoice(id).advanceAmount, expected);
        assertLe(expected, amount);

        vm.prank(client);
        ia.approveCompletion(id);
        assertEq(token.balanceOf(freelancer), amount);
        assertEq(ia.reserveBalance(), RESERVE);
        assertEq(ia.totalEscrow(), 0);
        _assertBooks();
    }
}
