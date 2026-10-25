// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {InvoiceAdvance} from "../src/InvoiceAdvance.sol";
import {IInvoiceAdvance} from "../src/IInvoiceAdvance.sol";
import {RLUSDLikeToken} from "./mocks/RLUSDLikeToken.sol";

/// @notice InvoiceAdvance against an 18-decimal, issuer-controlled token (RLUSD-shaped). The
/// contract is decimals-agnostic; these tests pin that and document the issuer-control risks.
contract InvoiceAdvanceRLUSDTest is Test {
    InvoiceAdvance ia;
    RLUSDLikeToken token;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address evaluator = makeAddr("evaluator");
    address client = makeAddr("client");
    address freelancer = makeAddr("freelancer");

    bytes32 constant META = keccak256("terms-v1");
    bytes32 constant EVAL = keccak256("eval-1");
    uint256 constant ONE = 1e18;
    uint256 constant AMOUNT = 1_000 * ONE;
    uint256 constant ADVANCE = 900 * ONE;
    uint256 constant RESERVE = 10_000 * ONE;

    function setUp() public {
        token = new RLUSDLikeToken();
        ia = new InvoiceAdvance(IERC20(address(token)), admin, operator, evaluator);
        token.mint(client, 10_000 * ONE);
        token.mint(operator, 10_000 * ONE);
        vm.prank(client);
        token.approve(address(ia), type(uint256).max);
        vm.prank(operator);
        token.approve(address(ia), type(uint256).max);
        vm.prank(operator);
        ia.depositReserve(RESERVE);
    }

    function _funded(uint256 amount) internal returns (uint256 id) {
        vm.startPrank(client);
        id = ia.createInvoice(freelancer, amount, META);
        ia.fundInvoice(id);
        vm.stopPrank();
    }

    function test_decimals_are18() public view {
        assertEq(token.decimals(), 18);
    }

    function test_advanceIsExactly90PercentAt18Decimals() public {
        uint256 id = _funded(AMOUNT);
        vm.prank(evaluator);
        ia.approveAdvance(id, EVAL);
        assertEq(token.balanceOf(freelancer), ADVANCE);
        assertEq(ia.getInvoice(id).advanceAmount, ADVANCE);
        assertEq(ia.availableReserve(), RESERVE - ADVANCE);
    }

    function test_advanceFloorsWithOddBaseUnits() public {
        uint256 amount = 1_000 * ONE + 7; // 90% = 900e18 + 6.3 -> floor 6
        uint256 id = _funded(amount);
        vm.prank(evaluator);
        ia.approveAdvance(id, EVAL);
        assertEq(ia.getInvoice(id).advanceAmount, 900 * ONE + 6);
    }

    function testFuzz_advanceMatchesFormula(uint128 raw) public {
        uint256 amount = bound(uint256(raw), 1, 5_000 * ONE);
        if ((amount * 9000) / 10000 == 0) return; // ZeroAdvance case covered elsewhere
        uint256 id = _funded(amount);
        vm.prank(evaluator);
        ia.approveAdvance(id, EVAL);
        assertEq(ia.getInvoice(id).advanceAmount, (amount * 9000) / 10000);
    }

    function test_settleWithAdvanceReimbursesReserveAndPaysRemainder() public {
        uint256 id = _funded(AMOUNT);
        vm.prank(evaluator);
        ia.approveAdvance(id, EVAL);
        vm.prank(client);
        ia.approveCompletion(id);
        assertEq(token.balanceOf(freelancer), AMOUNT); // 900 advance + 100 remainder
        assertEq(ia.availableReserve(), RESERVE); // reserve whole again
        assertEq(token.balanceOf(address(ia)), RESERVE);
    }

    function test_settleWithoutAdvancePaysFullInvoice() public {
        uint256 id = _funded(AMOUNT);
        vm.prank(client);
        ia.approveCompletion(id);
        assertEq(token.balanceOf(freelancer), AMOUNT);
        assertEq(ia.availableReserve(), RESERVE);
    }

    // ---- issuer controls: documented risk, not mitigated by the contract ----

    function test_pausedTokenBlocksFunding() public {
        vm.startPrank(client);
        uint256 id = ia.createInvoice(freelancer, AMOUNT, META);
        vm.stopPrank();
        token.pause();
        vm.prank(client);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        ia.fundInvoice(id);
    }

    function test_pausedTokenBlocksSettlementUntilUnpaused() public {
        uint256 id = _funded(AMOUNT);
        token.pause();
        vm.prank(client);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        ia.approveCompletion(id);
        // The invoice is unchanged, so settlement works once the issuer unpauses.
        assertEq(uint256(ia.getInvoice(id).status), uint256(IInvoiceAdvance.InvoiceStatus.Funded));
        token.unpause();
        vm.prank(client);
        ia.approveCompletion(id);
        assertEq(token.balanceOf(freelancer), AMOUNT);
    }

    function test_pausedTokenBlocksAdvance() public {
        uint256 id = _funded(AMOUNT);
        token.pause();
        vm.prank(evaluator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        ia.approveAdvance(id, EVAL);
    }

    /// @dev An issuer clawback from the contract burns real tokens while the books still record
    /// them, so the contract becomes insolvent. Nothing in InvoiceAdvance can prevent this.
    function test_issuerClawbackBreaksSolvency() public {
        uint256 id = _funded(AMOUNT);
        token.clawback(address(ia), 10_800 * ONE); // leaves 200 of the 11,000 the books record
        assertLt(token.balanceOf(address(ia)), ia.availableReserve() + AMOUNT);
        vm.prank(client);
        vm.expectRevert(); // ERC20InsufficientBalance on the payout
        ia.approveCompletion(id);
        assertEq(uint256(ia.getInvoice(id).status), uint256(IInvoiceAdvance.InvoiceStatus.Funded));
    }
}
