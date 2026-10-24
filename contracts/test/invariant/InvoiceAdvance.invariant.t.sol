// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceAdvance} from "../../src/InvoiceAdvance.sol";
import {IInvoiceAdvance} from "../../src/IInvoiceAdvance.sol";
import {MockUSDC} from "../../src/MockUSDC.sol";
import {InvoiceAdvanceHandler} from "./InvoiceAdvanceHandler.sol";

/// @notice A4: stateful invariants over randomized multi-invoice sequences.
contract InvoiceAdvanceInvariantTest is Test {
    InvoiceAdvance ia;
    MockUSDC token;
    InvoiceAdvanceHandler handler;

    function setUp() public {
        address operator = makeAddr("operator");
        address evaluator = makeAddr("evaluator");
        token = new MockUSDC(address(this));
        ia = new InvoiceAdvance(IERC20(address(token)), makeAddr("admin"), operator, evaluator);
        handler = new InvoiceAdvanceHandler(ia, token, operator, evaluator);
        token.transferOwnership(address(handler));
        targetContract(address(handler));
    }

    /// Solvency: held tokens always cover reserve + escrow.
    function invariant_solvency() public view {
        assertGe(token.balanceOf(address(ia)), ia.reserveBalance() + ia.totalEscrow());
    }

    /// Exact books: the only surplus is unsolicited donations.
    function invariant_exactBooks() public view {
        assertEq(
            token.balanceOf(address(ia)),
            ia.reserveBalance() + ia.totalEscrow() + handler.ghostDonated()
        );
    }

    /// Reserve moves only by deposits, withdrawals, advances and settlement repayments.
    function invariant_reserveLedger() public view {
        assertEq(
            ia.reserveBalance(),
            handler.ghostDeposited() + handler.ghostRepaid() - handler.ghostWithdrawn()
                - handler.ghostAdvanced()
        );
    }

    /// Escrow never finances advances or reserve withdrawals.
    function invariant_escrowNeverFinancesReserve() public view {
        assertFalse(handler.ghostEscrowFinanced());
    }

    /// Escrow, advances, losses and freelancer receipts reconcile per invoice.
    function invariant_perInvoice() public view {
        uint256 escrow;
        uint256 outstanding;
        uint256 unrecovered;
        uint256 n = handler.idCount();
        for (uint256 i; i < n; i++) {
            uint256 id = handler.ids(i);
            IInvoiceAdvance.Invoice memory inv = ia.getInvoice(id);
            IInvoiceAdvance.InvoiceStatus s = inv.status;
            uint256 adv = (inv.amount * 9_000) / 10_000;
            uint256 received = token.balanceOf(handler.freelancerOf(id));

            assertLe(inv.advanceAmount, inv.amount);
            assertTrue(inv.advanceAmount == 0 || inv.advanceAmount == adv);
            assertEq(inv.evaluationHash == bytes32(0), inv.advanceAmount == 0);

            if (
                s == IInvoiceAdvance.InvoiceStatus.Created
                    || s == IInvoiceAdvance.InvoiceStatus.Funded
            ) {
                assertEq(inv.advanceAmount, 0);
                assertEq(received, 0);
            } else if (s == IInvoiceAdvance.InvoiceStatus.Advanced) {
                assertGt(inv.advanceAmount, 0);
            }

            if (
                s == IInvoiceAdvance.InvoiceStatus.Funded
                    || s == IInvoiceAdvance.InvoiceStatus.Advanced
                    || s == IInvoiceAdvance.InvoiceStatus.Disputed
            ) {
                escrow += inv.amount;
                outstanding += inv.advanceAmount;
                assertEq(received, inv.advanceAmount);
            } else if (s == IInvoiceAdvance.InvoiceStatus.Settled) {
                assertEq(received, inv.amount);
            } else {
                // Cancelled: unfunded cancel (no advance) or refund (advance is an operator loss)
                unrecovered += inv.advanceAmount;
                assertEq(received, inv.advanceAmount);
            }
        }
        assertEq(ia.totalEscrow(), escrow);
        assertEq(handler.ghostUnrecovered(), unrecovered);
        assertEq(handler.ghostAdvanced() - handler.ghostRepaid(), outstanding + unrecovered);
    }
}
