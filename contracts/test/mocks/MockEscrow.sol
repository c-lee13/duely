// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDuelyVault} from "../../src/IDuelyVault.sol";

/// @dev TEST ONLY. Minimal stand-in for InvoiceAdvanceV2 used by the vault-only tests: it exposes
/// the views the vault checks in `setEscrow` and forwards whatever terms/calls a test wants, so the
/// vault's own validation can be exercised in isolation. Not the real escrow logic.
contract MockEscrow {
    address public vault;
    address public paymentToken;
    uint256 public constant FEE_BPS = 300;
    uint256 public constant ADVANCE_BPS = 9000;

    constructor(address vault_, address token_) {
        vault = vault_;
        paymentToken = token_;
    }

    function fund(
        IDuelyVault v,
        uint256 invoiceId,
        address freelancer,
        uint256 invoiceAmount,
        uint256 principal,
        uint256 fee
    ) external {
        v.fundAdvance(invoiceId, freelancer, invoiceAmount, principal, fee);
    }

    /// @dev Approves `approveAmount` (tests may over-approve) then asks the vault to pull the repayment.
    function repay(IDuelyVault v, uint256 invoiceId, uint256 approveAmount) external {
        IERC20(paymentToken).approve(address(v), approveAmount);
        v.recordRepayment(invoiceId);
    }

    function loss(IDuelyVault v, uint256 invoiceId) external {
        v.finalizeLoss(invoiceId);
    }
}
