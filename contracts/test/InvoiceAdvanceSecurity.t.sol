// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {InvoiceAdvance} from "../src/InvoiceAdvance.sol";
import {IInvoiceAdvance} from "../src/IInvoiceAdvance.sol";
import {MaliciousToken} from "./mocks/MaliciousToken.sol";
import {ReentrantActor} from "./mocks/ReentrantActor.sol";

/// @notice A4: reentrancy through token callbacks and failed token transfers.
contract InvoiceAdvanceSecurityTest is Test {
    InvoiceAdvance ia;
    MaliciousToken token;
    ReentrantActor attacker;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address evaluator = makeAddr("evaluator");
    address client = makeAddr("client");
    address freelancer = makeAddr("freelancer");

    bytes32 constant META = keccak256("terms-v1");
    bytes32 constant EVAL = keccak256("eval-1");
    bytes32 constant OPERATOR = keccak256("OPERATOR_ROLE");
    bytes32 constant EVALUATOR = keccak256("EVALUATOR_ROLE");
    uint256 constant AMOUNT = 1_000e6;
    uint256 constant ADVANCE = 900e6;
    uint256 constant RESERVE = 10_000e6;

    function setUp() public {
        token = new MaliciousToken();
        ia = new InvoiceAdvance(IERC20(address(token)), admin, operator, evaluator);
        attacker = new ReentrantActor();
        token.setHookTarget(address(attacker));

        token.mint(client, 100_000e6);
        token.mint(operator, 100_000e6);
        token.mint(address(attacker), 100_000e6);
        vm.prank(client);
        token.approve(address(ia), type(uint256).max);
        vm.prank(operator);
        token.approve(address(ia), type(uint256).max);
        attacker.exec(
            address(token), abi.encodeCall(IERC20.approve, (address(ia), type(uint256).max))
        );

        vm.prank(operator);
        ia.depositReserve(RESERVE);
    }

    // ---- helpers ----

    function _fundedBy(address payer, address payee) internal returns (uint256 id) {
        vm.startPrank(payer);
        id = ia.createInvoice(payee, AMOUNT, META);
        ia.fundInvoice(id);
        vm.stopPrank();
    }

    function _grant(bytes32 role, address who) internal {
        vm.prank(admin);
        ia.grantRole(role, who);
    }

    function _assertBooks() internal view {
        assertEq(token.balanceOf(address(ia)), ia.reserveBalance() + ia.totalEscrow());
    }

    function _status(uint256 id) internal view returns (uint256) {
        return uint256(ia.getInvoice(id).status);
    }

    // ---- reentrancy via token callbacks ----

    function test_reentrancy_advanceCannotReenterAdvance() public {
        _grant(EVALUATOR, address(attacker));
        uint256 id = _fundedBy(client, address(attacker));
        attacker.arm(
            address(ia), abi.encodeCall(IInvoiceAdvance.approveAdvance, (id, keccak256("x")))
        );

        vm.prank(evaluator);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        ia.approveAdvance(id, EVAL);

        assertEq(_status(id), uint256(IInvoiceAdvance.InvoiceStatus.Funded));
        assertEq(ia.reserveBalance(), RESERVE);
        _assertBooks();
    }

    function test_reentrancy_settlementCannotReenterWithdrawReserve() public {
        _grant(OPERATOR, address(attacker));
        uint256 id = _fundedBy(client, address(attacker));
        vm.prank(evaluator);
        ia.approveAdvance(id, EVAL); // attacker unarmed: callback is a no-op
        attacker.arm(address(ia), abi.encodeCall(IInvoiceAdvance.withdrawReserve, (RESERVE)));

        vm.prank(client);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        ia.approveCompletion(id);

        assertEq(_status(id), uint256(IInvoiceAdvance.InvoiceStatus.Advanced));
        assertEq(ia.totalEscrow(), AMOUNT);
        _assertBooks();
    }

    function test_reentrancy_fundCannotReenterFund() public {
        bytes memory create =
            abi.encodeCall(IInvoiceAdvance.createInvoice, (freelancer, AMOUNT, META));
        uint256 a = abi.decode(attacker.exec(address(ia), create), (uint256));
        uint256 b = abi.decode(attacker.exec(address(ia), create), (uint256));
        attacker.arm(address(ia), abi.encodeCall(IInvoiceAdvance.fundInvoice, (b)));

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.exec(address(ia), abi.encodeCall(IInvoiceAdvance.fundInvoice, (a)));

        assertEq(ia.totalEscrow(), 0);
        _assertBooks();
    }

    function test_reentrancy_withdrawCannotReenterWithdraw() public {
        _grant(OPERATOR, address(attacker));
        attacker.exec(address(ia), abi.encodeCall(IInvoiceAdvance.depositReserve, (1_000e6)));
        attacker.arm(address(ia), abi.encodeCall(IInvoiceAdvance.withdrawReserve, (500e6)));

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.exec(address(ia), abi.encodeCall(IInvoiceAdvance.withdrawReserve, (500e6)));

        assertEq(ia.reserveBalance(), RESERVE + 1_000e6);
        _assertBooks();
    }

    /// @dev raiseDispute has no guard; CEI means status is already Cancelled when the refund
    /// callback fires, so re-entry is rejected by the status check.
    function test_reentrancy_refundCallbackSeesFinalState() public {
        uint256 id = _fundedBy(address(attacker), freelancer);
        attacker.exec(address(ia), abi.encodeCall(IInvoiceAdvance.raiseDispute, (id)));
        attacker.arm(address(ia), abi.encodeCall(IInvoiceAdvance.raiseDispute, (id)));

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvance.InvalidStatus.selector, id, IInvoiceAdvance.InvoiceStatus.Cancelled
            )
        );
        ia.resolveDispute(id, false);
        assertEq(_status(id), uint256(IInvoiceAdvance.InvoiceStatus.Disputed));
        _assertBooks();
    }

    /// @dev Re-entering an unguarded, transfer-free function on another invoice is permitted and
    /// leaves accounting consistent.
    function test_reentrancy_unguardedCrossInvoiceIsHarmless() public {
        uint256 a = _fundedBy(client, address(attacker));
        bytes memory create =
            abi.encodeCall(IInvoiceAdvance.createInvoice, (freelancer, AMOUNT, META));
        uint256 b = abi.decode(attacker.exec(address(ia), create), (uint256));
        attacker.exec(address(ia), abi.encodeCall(IInvoiceAdvance.fundInvoice, (b)));
        attacker.arm(address(ia), abi.encodeCall(IInvoiceAdvance.raiseDispute, (b)));

        vm.prank(evaluator);
        ia.approveAdvance(a, EVAL);

        assertEq(_status(a), uint256(IInvoiceAdvance.InvoiceStatus.Advanced));
        assertEq(_status(b), uint256(IInvoiceAdvance.InvoiceStatus.Disputed));
        assertEq(ia.reserveBalance(), RESERVE - ADVANCE);
        assertEq(ia.totalEscrow(), 2 * AMOUNT);
        _assertBooks();
    }

    // ---- failed outbound transfers ----

    function test_failedTransfer_returnFalseRevertsAdvance() public {
        uint256 id = _fundedBy(client, freelancer);
        token.setModes(MaliciousToken.Mode.ReturnFalse, MaliciousToken.Mode.Normal);

        vm.prank(evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(token))
        );
        ia.approveAdvance(id, EVAL);
        assertEq(_status(id), uint256(IInvoiceAdvance.InvoiceStatus.Funded));
        assertEq(ia.reserveBalance(), RESERVE);
        assertEq(ia.getInvoice(id).advanceAmount, 0);
    }

    function test_failedTransfer_revertRollsBackSettlementWithdrawAndRefund() public {
        uint256 settleId = _fundedBy(client, freelancer);
        uint256 refundId = _fundedBy(client, freelancer);
        vm.prank(client);
        ia.raiseDispute(refundId);
        token.setModes(MaliciousToken.Mode.Revert, MaliciousToken.Mode.Normal);

        vm.prank(client);
        vm.expectRevert("transfer blocked");
        ia.approveCompletion(settleId);

        vm.startPrank(operator);
        vm.expectRevert("transfer blocked");
        ia.withdrawReserve(1);
        vm.expectRevert("transfer blocked");
        ia.resolveDispute(refundId, false);
        vm.stopPrank();

        assertEq(_status(settleId), uint256(IInvoiceAdvance.InvoiceStatus.Funded));
        assertEq(_status(refundId), uint256(IInvoiceAdvance.InvoiceStatus.Disputed));
        assertEq(ia.reserveBalance(), RESERVE);
        assertEq(ia.totalEscrow(), 2 * AMOUNT);
        _assertBooks();
    }

    // ---- failed inbound transfers ----

    function test_failedTransferFrom_returnFalseRevertsFundAndDeposit() public {
        vm.prank(client);
        uint256 id = ia.createInvoice(freelancer, AMOUNT, META);
        token.setModes(MaliciousToken.Mode.Normal, MaliciousToken.Mode.ReturnFalse);
        bytes memory failed =
            abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(token));

        vm.prank(client);
        vm.expectRevert(failed);
        ia.fundInvoice(id);
        vm.prank(operator);
        vm.expectRevert(failed);
        ia.depositReserve(1_000e6);

        assertEq(_status(id), uint256(IInvoiceAdvance.InvoiceStatus.Created));
        assertEq(ia.totalEscrow(), 0);
        assertEq(ia.reserveBalance(), RESERVE);
    }

    function test_failedTransferFrom_revertRollsBackFund() public {
        vm.prank(client);
        uint256 id = ia.createInvoice(freelancer, AMOUNT, META);
        token.setModes(MaliciousToken.Mode.Normal, MaliciousToken.Mode.Revert);

        vm.prank(client);
        vm.expectRevert("transferFrom blocked");
        ia.fundInvoice(id);
        assertEq(_status(id), uint256(IInvoiceAdvance.InvoiceStatus.Created));
        assertEq(ia.totalEscrow(), 0);
    }
}
