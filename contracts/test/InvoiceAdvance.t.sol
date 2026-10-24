// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceAdvance} from "../src/InvoiceAdvance.sol";
import {IInvoiceAdvance} from "../src/IInvoiceAdvance.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";

contract InvoiceAdvanceTest is Test {
    InvoiceAdvance ia;
    MockUSDC token;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address evaluator = makeAddr("evaluator");
    address client = makeAddr("client");
    address freelancer = makeAddr("freelancer");
    address stranger = makeAddr("stranger");

    bytes32 constant META = keccak256("terms-v1");
    bytes32 constant OPERATOR = keccak256("OPERATOR_ROLE");
    uint256 constant AMOUNT = 1_000e6;

    function setUp() public {
        token = new MockUSDC(address(this));
        ia = new InvoiceAdvance(IERC20(address(token)), admin, operator, evaluator);
        token.mint(client, 10_000e6);
        token.mint(operator, 10_000e6);
        vm.prank(client);
        token.approve(address(ia), type(uint256).max);
        vm.prank(operator);
        token.approve(address(ia), type(uint256).max);
    }

    function _create() internal returns (uint256 id) {
        vm.prank(client);
        id = ia.createInvoice(freelancer, AMOUNT, META);
    }

    function _assertAccounting() internal view {
        assertGe(token.balanceOf(address(ia)), ia.reserveBalance() + ia.totalEscrow());
    }

    // ---- constructor / roles ----

    function test_constructorSetsRolesAndToken() public view {
        assertEq(address(ia.paymentToken()), address(token));
        assertTrue(ia.hasRole(ia.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(ia.hasRole(ia.OPERATOR_ROLE(), operator));
        assertTrue(ia.hasRole(ia.EVALUATOR_ROLE(), evaluator));
        assertFalse(ia.hasRole(ia.OPERATOR_ROLE(), admin));
        assertEq(ia.nextInvoiceId(), 1);
    }

    function test_constructorRejectsZeroAddresses() public {
        IERC20 t = IERC20(address(token));
        vm.expectRevert(IInvoiceAdvance.InvalidAddress.selector);
        new InvoiceAdvance(IERC20(address(0)), admin, operator, evaluator);
        vm.expectRevert(IInvoiceAdvance.InvalidAddress.selector);
        new InvoiceAdvance(t, address(0), operator, evaluator);
        vm.expectRevert(IInvoiceAdvance.InvalidAddress.selector);
        new InvoiceAdvance(t, admin, address(0), evaluator);
        vm.expectRevert(IInvoiceAdvance.InvalidAddress.selector);
        new InvoiceAdvance(t, admin, operator, address(0));
    }

    function test_adminCanRotateEvaluator() public {
        bytes32 role = ia.EVALUATOR_ROLE();
        address newEvaluator = makeAddr("newEvaluator");
        vm.startPrank(admin);
        ia.grantRole(role, newEvaluator);
        ia.revokeRole(role, evaluator);
        vm.stopPrank();
        assertTrue(ia.hasRole(role, newEvaluator));
        assertFalse(ia.hasRole(role, evaluator));
    }

    function test_strangerCannotGrantRoles() public {
        bytes32 role = ia.EVALUATOR_ROLE();
        bytes32 adminRole = ia.DEFAULT_ADMIN_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole
            )
        );
        ia.grantRole(role, stranger);
    }

    // ---- createInvoice ----

    function test_createInvoiceStoresCallerAsClientAndEmits() public {
        vm.expectEmit(true, true, true, true, address(ia));
        emit IInvoiceAdvance.InvoiceCreated(1, freelancer, client, AMOUNT, META);
        uint256 id = _create();

        assertEq(id, 1);
        assertEq(ia.nextInvoiceId(), 2);
        IInvoiceAdvance.Invoice memory inv = ia.getInvoice(id);
        assertEq(inv.client, client);
        assertEq(inv.freelancer, freelancer);
        assertEq(inv.amount, AMOUNT);
        assertEq(inv.advanceAmount, 0);
        assertEq(inv.metadataHash, META);
        assertEq(inv.evaluationHash, bytes32(0));
        assertEq(uint256(inv.status), uint256(IInvoiceAdvance.InvoiceStatus.Created));
        assertEq(token.balanceOf(address(ia)), 0);
    }

    function test_createInvoiceSequentialIds() public {
        assertEq(_create(), 1);
        assertEq(_create(), 2);
        assertEq(_create(), 3);
    }

    function test_createInvoiceReverts() public {
        vm.startPrank(client);
        vm.expectRevert(IInvoiceAdvance.InvalidAddress.selector);
        ia.createInvoice(address(0), AMOUNT, META);
        vm.expectRevert(IInvoiceAdvance.InvalidInvoiceParties.selector);
        ia.createInvoice(client, AMOUNT, META);
        vm.expectRevert(IInvoiceAdvance.InvalidAmount.selector);
        ia.createInvoice(freelancer, 0, META);
        vm.expectRevert(IInvoiceAdvance.InvalidHash.selector);
        ia.createInvoice(freelancer, AMOUNT, bytes32(0));
        vm.stopPrank();
        assertEq(ia.nextInvoiceId(), 1);
    }

    function test_createInvoiceRejectsContractAsFreelancer() public {
        vm.prank(client);
        vm.expectRevert(IInvoiceAdvance.InvalidAddress.selector);
        ia.createInvoice(address(ia), AMOUNT, META);
        assertEq(ia.nextInvoiceId(), 1);
    }

    function test_createInvoiceRejectsPaymentTokenAsFreelancer() public {
        vm.prank(client);
        vm.expectRevert(IInvoiceAdvance.InvalidAddress.selector);
        ia.createInvoice(address(token), AMOUNT, META);
        assertEq(ia.nextInvoiceId(), 1);
    }

    // ---- getInvoice ----

    function test_getInvoiceRevertsForUnknownIds() public {
        _create();
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvance.InvoiceNotFound.selector, 0));
        ia.getInvoice(0);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvance.InvoiceNotFound.selector, 2));
        ia.getInvoice(2);
    }

    // ---- cancelInvoice ----

    function test_cancelCreatedInvoiceThenCannotFund() public {
        uint256 id = _create();
        vm.expectEmit(true, false, false, false, address(ia));
        emit IInvoiceAdvance.InvoiceCancelled(id);
        vm.prank(client);
        ia.cancelInvoice(id);
        assertEq(
            uint256(ia.getInvoice(id).status), uint256(IInvoiceAdvance.InvoiceStatus.Cancelled)
        );

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvance.InvalidStatus.selector, id, IInvoiceAdvance.InvoiceStatus.Cancelled
            )
        );
        ia.fundInvoice(id);
    }

    function test_cancelOnlyClientAndOnlyCreated() public {
        uint256 id = _create();
        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvance.NotInvoiceClient.selector, id));
        ia.cancelInvoice(id);

        vm.startPrank(client);
        ia.fundInvoice(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvance.InvalidStatus.selector, id, IInvoiceAdvance.InvoiceStatus.Funded
            )
        );
        ia.cancelInvoice(id);
        vm.stopPrank();
    }

    function test_cancelUnknownInvoiceReverts() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvance.InvoiceNotFound.selector, 5));
        ia.cancelInvoice(5);
    }

    // ---- fundInvoice ----

    function test_fundInvoiceMovesTokensToEscrowOnly() public {
        uint256 id = _create();
        vm.prank(operator);
        ia.depositReserve(10_000e6);

        vm.expectEmit(true, true, false, true, address(ia));
        emit IInvoiceAdvance.InvoiceFunded(id, client, AMOUNT);
        vm.prank(client);
        ia.fundInvoice(id);

        assertEq(uint256(ia.getInvoice(id).status), uint256(IInvoiceAdvance.InvoiceStatus.Funded));
        assertEq(ia.totalEscrow(), AMOUNT);
        assertEq(ia.reserveBalance(), 10_000e6);
        assertEq(token.balanceOf(client), 9_000e6);
        assertEq(token.balanceOf(address(ia)), 11_000e6);
        assertEq(token.balanceOf(address(ia)), ia.reserveBalance() + ia.totalEscrow());
    }

    function test_fundInvoiceRejectsNonClientAndDoubleFunding() public {
        uint256 id = _create();
        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvance.NotInvoiceClient.selector, id));
        ia.fundInvoice(id);

        vm.startPrank(client);
        ia.fundInvoice(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvance.InvalidStatus.selector, id, IInvoiceAdvance.InvoiceStatus.Funded
            )
        );
        ia.fundInvoice(id);
        vm.stopPrank();
        assertEq(ia.totalEscrow(), AMOUNT);
    }

    function test_fundInvoiceInsufficientAllowance() public {
        uint256 id = _create();
        vm.startPrank(client);
        token.approve(address(ia), AMOUNT - 1);
        vm.expectRevert();
        ia.fundInvoice(id);
        vm.stopPrank();
        assertEq(ia.totalEscrow(), 0);
        assertEq(uint256(ia.getInvoice(id).status), uint256(IInvoiceAdvance.InvoiceStatus.Created));
    }

    function test_fundInvoiceInsufficientBalance() public {
        vm.prank(client);
        uint256 id = ia.createInvoice(freelancer, 50_000e6, META);
        vm.prank(client);
        vm.expectRevert();
        ia.fundInvoice(id);
        assertEq(ia.totalEscrow(), 0);
    }

    function test_fundUnknownInvoiceReverts() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvance.InvoiceNotFound.selector, 1));
        ia.fundInvoice(1);
    }

    // ---- reserve ----

    function test_depositReserve() public {
        vm.expectEmit(true, false, false, true, address(ia));
        emit IInvoiceAdvance.ReserveDeposited(operator, 5_000e6);
        vm.prank(operator);
        ia.depositReserve(5_000e6);

        assertEq(ia.reserveBalance(), 5_000e6);
        assertEq(ia.availableReserve(), 5_000e6);
        assertEq(ia.totalEscrow(), 0);
        assertEq(token.balanceOf(address(ia)), 5_000e6);
    }

    function test_depositReserveAccessAndAmount() public {
        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, OPERATOR
            )
        );
        ia.depositReserve(1);
        vm.stopPrank();

        // admin and client hold no operator authority
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, admin, OPERATOR
            )
        );
        ia.depositReserve(1);

        vm.prank(operator);
        vm.expectRevert(IInvoiceAdvance.InvalidAmount.selector);
        ia.depositReserve(0);
    }

    function test_withdrawReserve() public {
        vm.startPrank(operator);
        ia.depositReserve(5_000e6);
        vm.expectEmit(true, false, false, true, address(ia));
        emit IInvoiceAdvance.ReserveWithdrawn(operator, 2_000e6);
        ia.withdrawReserve(2_000e6);
        vm.stopPrank();

        assertEq(ia.reserveBalance(), 3_000e6);
        assertEq(token.balanceOf(operator), 10_000e6 - 3_000e6);
        _assertAccounting();
    }

    function test_withdrawReserveRejections() public {
        vm.prank(operator);
        ia.depositReserve(1_000e6);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, OPERATOR
            )
        );
        ia.withdrawReserve(1);

        vm.startPrank(operator);
        vm.expectRevert(IInvoiceAdvance.InvalidAmount.selector);
        ia.withdrawReserve(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvance.InsufficientReserve.selector, 1_000e6 + 1, 1_000e6
            )
        );
        ia.withdrawReserve(1_000e6 + 1);
        vm.stopPrank();
    }

    function test_withdrawReserveCannotTouchEscrow() public {
        uint256 id = _create();
        vm.prank(client);
        ia.fundInvoice(id); // 1,000 escrow, 0 reserve
        vm.prank(operator);
        ia.depositReserve(100e6);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IInvoiceAdvance.InsufficientReserve.selector, 101e6, 100e6)
        );
        ia.withdrawReserve(101e6); // contract holds 1,100 but only 100 is reserve
        assertEq(ia.totalEscrow(), AMOUNT);
    }

    function testFuzz_reserveNeverDrawsFromEscrow(uint96 deposit, uint96 withdraw) public {
        deposit = uint96(bound(deposit, 1, 10_000e6));
        uint256 id = _create();
        vm.prank(client);
        ia.fundInvoice(id);
        vm.startPrank(operator);
        ia.depositReserve(deposit);
        if (withdraw == 0 || withdraw > deposit) {
            vm.expectRevert();
            ia.withdrawReserve(withdraw);
        } else {
            ia.withdrawReserve(withdraw);
        }
        vm.stopPrank();
        assertEq(ia.totalEscrow(), AMOUNT);
        assertGe(token.balanceOf(address(ia)), AMOUNT);
        assertEq(token.balanceOf(address(ia)), ia.reserveBalance() + ia.totalEscrow());
    }

    // ---- unsupported tokens / surplus ----

    function test_feeOnTransferTokenRejectedForFundingAndDeposit() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        InvoiceAdvance feeIa = new InvoiceAdvance(IERC20(address(fee)), admin, operator, evaluator);
        fee.mint(client, 10_000e6);
        fee.mint(operator, 10_000e6);
        vm.prank(client);
        fee.approve(address(feeIa), type(uint256).max);
        vm.prank(operator);
        fee.approve(address(feeIa), type(uint256).max);

        vm.prank(client);
        uint256 id = feeIa.createInvoice(freelancer, AMOUNT, META);
        vm.prank(client);
        vm.expectRevert(IInvoiceAdvance.UnsupportedTokenBehavior.selector);
        feeIa.fundInvoice(id);

        vm.prank(operator);
        vm.expectRevert(IInvoiceAdvance.UnsupportedTokenBehavior.selector);
        feeIa.depositReserve(1_000e6);
        assertEq(feeIa.totalEscrow(), 0);
        assertEq(feeIa.reserveBalance(), 0);
    }

    function test_unsolicitedTransferDoesNotChangeAccounting() public {
        vm.prank(client);
        token.transfer(address(ia), 123e6);
        assertEq(ia.reserveBalance(), 0);
        assertEq(ia.totalEscrow(), 0);
        _assertAccounting();
    }

    function test_multipleInvoicesEscrowAccumulates() public {
        uint256 a = _create();
        vm.prank(client);
        uint256 b = ia.createInvoice(freelancer, 250e6, keccak256("b"));
        vm.startPrank(client);
        ia.fundInvoice(a);
        ia.fundInvoice(b);
        vm.stopPrank();
        assertEq(ia.totalEscrow(), AMOUNT + 250e6);
        _assertAccounting();
    }
}
