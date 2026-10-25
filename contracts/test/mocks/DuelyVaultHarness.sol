// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DuelyVault} from "../../src/DuelyVault.sol";

/// @dev TEST ONLY. Simulates the A3/A4 accounting transitions (no limits, no escrow, no advance
/// records) so A2 can test share pricing under deployed principal, gains and losses. The real
/// transitions live in the escrow-only functions that A3/A4 implement.
contract DuelyVaultHarness is DuelyVault {
    using SafeERC20 for IERC20;

    constructor(IERC20 asset_, address admin, address operator, address pauser)
        DuelyVault(asset_, admin, operator, pauser)
    {}

    /// @dev principal leaves the vault; NAV unchanged.
    function simulateAdvance(uint256 principal, address to) external {
        outstandingPrincipal += principal;
        IERC20(asset()).safeTransfer(to, principal);
    }

    /// @dev caller must already have sent `principal + fee` to the vault; NAV rises by `fee`.
    function simulateRepayment(uint256 principal, uint256 fee) external {
        outstandingPrincipal -= principal;
        totalFeesEarned += fee;
    }

    /// @dev principal written off; NAV falls by `principal`.
    function simulateLoss(uint256 principal) external {
        outstandingPrincipal -= principal;
        totalRealizedLosses += principal;
    }
}
