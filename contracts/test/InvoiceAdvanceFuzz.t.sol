// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {InvoiceAdvance} from "../src/InvoiceAdvance.sol";
import {IInvoiceAdvance} from "../src/IInvoiceAdvance.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @notice A4: stateless fuzzing of rounding, amount boundaries, reserve flows and outcomes.
contract InvoiceAdvanceFuzzTest is Test {
    InvoiceAdvance ia;
    MockUSDC token;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address evaluator = makeAddr("evaluator");
    address client = makeAddr("client");
    address freelancer = makeAddr("freelancer");

    bytes32 constant META = keccak256("terms-v1");
    bytes32 constant EVAL = keccak256("eval-1");

    function setUp() public {
        token = new MockUSDC(address(this));
        ia = new InvoiceAdvance(IERC20(address(token)), admin, operator, evaluator);
        vm.prank(client);
        token.approve(address(ia), type(uint256).max);
        vm.prank(operator);
        token.approve(address(ia), type(uint256).max);
    }

    function _fund(uint256 amount) internal returns (uint256 id) {
        token.mint(client, amount);
        vm.startPrank(client);
        id = ia.createInvoice(freelancer, amount, META);
        ia.fundInvoice(id);
        vm.stopPrank();
    }

    function _deposit(uint256 amount) internal {
        token.mint(operator, amount);
        vm.prank(operator);
        ia.depositReserve(amount);
    }

    function _assertBooks() internal view {
        assertEq(token.balanceOf(address(ia)), ia.reserveBalance() + ia.totalEscrow());
    }

    /// @dev Full uint256 range (halved so escrow + reserve fit in total supply): the advance
    /// matches mulDiv floor, never overflows, and settlement pays exactly `amount`.
    function testFuzz_advanceRoundingFullRange(uint256 amount) public {
        amount = bound(amount, 1, type(uint256).max / 2);
        uint256 expected = Math.mulDiv(amount, 9_000, 10_000);
        uint256 id = _fund(amount);

        if (expected == 0) {
            _deposit(1);
            vm.prank(evaluator);
            vm.expectRevert(IInvoiceAdvance.ZeroAdvance.selector);
            ia.approveAdvance(id, EVAL);
            return;
        }

        _deposit(expected);
        vm.prank(evaluator);
        ia.approveAdvance(id, EVAL);
        assertEq(ia.getInvoice(id).advanceAmount, expected);
        assertLe(expected, amount);
        assertEq(ia.reserveBalance(), 0);
        assertEq(ia.totalEscrow(), amount);

        vm.prank(client);
        ia.approveCompletion(id);
        assertEq(token.balanceOf(freelancer), amount);
        assertEq(ia.reserveBalance(), expected);
        assertEq(ia.totalEscrow(), 0);
        _assertBooks();
    }

    /// @dev Reserve exactly one base unit short of the advance must revert even when escrow
    /// alone could cover it.
    function testFuzz_reserveOneShortReverts(uint256 amount) public {
        amount = bound(amount, 2, type(uint128).max);
        uint256 adv = (amount * 9_000) / 10_000;
        uint256 id = _fund(amount);
        if (adv > 1) _deposit(adv - 1);

        vm.prank(evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(IInvoiceAdvance.InsufficientReserve.selector, adv, adv - 1)
        );
        ia.approveAdvance(id, EVAL);
        assertEq(ia.totalEscrow(), amount);
    }

    /// @dev Random deposit/withdraw sequence against a funded escrow; escrow is never spent.
    function testFuzz_reserveSequence(uint64[6] calldata deposits, uint64[6] calldata withdrawals)
        public
    {
        uint256 escrow = 5_000e6;
        _fund(escrow);
        uint256 expected;
        for (uint256 i; i < 6; i++) {
            if (deposits[i] > 0) {
                _deposit(deposits[i]);
                expected += deposits[i];
            }
            uint256 w = withdrawals[i];
            vm.prank(operator);
            if (w == 0) {
                vm.expectRevert(IInvoiceAdvance.InvalidAmount.selector);
                ia.withdrawReserve(w);
            } else if (w > expected) {
                vm.expectRevert(
                    abi.encodeWithSelector(
                        IInvoiceAdvance.InsufficientReserve.selector, w, expected
                    )
                );
                ia.withdrawReserve(w);
            } else {
                ia.withdrawReserve(w);
                expected -= w;
            }
            assertEq(ia.reserveBalance(), expected);
            assertEq(ia.totalEscrow(), escrow);
            _assertBooks();
        }
    }

    /// @dev Every terminal outcome conserves tokens; the operator loses exactly the advance only
    /// in the refund-after-advance branch.
    function testFuzz_outcomeConservation(uint256 amount, bool advance, bool dispute, bool release)
        public
    {
        amount = bound(amount, 10, 1e30);
        uint256 adv = (amount * 9_000) / 10_000;
        _deposit(adv);
        uint256 reserveStart = ia.reserveBalance();
        uint256 id = _fund(amount);

        if (advance) {
            vm.prank(evaluator);
            ia.approveAdvance(id, EVAL);
        }
        if (dispute) {
            vm.prank(client);
            ia.raiseDispute(id);
            vm.prank(operator);
            ia.resolveDispute(id, release);
        } else {
            vm.prank(client);
            ia.approveCompletion(id);
        }

        bool refunded = dispute && !release;
        uint256 paid = advance ? adv : 0;
        uint256 freelancerGot = token.balanceOf(freelancer);
        uint256 clientGot = token.balanceOf(client);
        uint256 operatorLoss = reserveStart - ia.reserveBalance();

        assertEq(freelancerGot, refunded ? paid : amount);
        assertEq(clientGot, refunded ? amount : 0);
        assertEq(operatorLoss, refunded ? paid : 0);
        assertEq(freelancerGot + clientGot, amount + operatorLoss);
        assertEq(ia.totalEscrow(), 0);
        _assertBooks();
    }
}
