// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDuelyVault} from "../../src/IDuelyVault.sol";

/// @dev TEST ONLY. Minimal stand-in for InvoiceAdvanceV2 (A4): forwards whatever invoice terms the
/// test wants so the vault's own validation can be exercised. Not the real escrow logic.
contract MockEscrow {
    function fund(
        IDuelyVault vault,
        uint256 invoiceId,
        address freelancer,
        uint256 invoiceAmount,
        uint256 principal,
        uint256 fee
    ) external {
        vault.fundAdvance(invoiceId, freelancer, invoiceAmount, principal, fee);
    }
}
