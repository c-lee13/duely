// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @notice Public interface of DuelyVault (docs/VAULT_IMPLEMENTATION_SPEC.md, A1.5 final).
/// A2: LP side (ERC-4626, share pricing, pause scaffolding). A3: fundAdvance. A4: recordRepayment
/// and finalizeLoss.
/// Types, events and errors below are proposals until the compiled ABI is exported.
interface IDuelyVault is IERC4626 {
    enum AdvanceStatus {
        None,
        Open,
        Repaid,
        Lost
    }

    struct Advance {
        address freelancer;
        uint256 invoiceAmount;
        uint256 principal;
        uint256 fee; // quoted at funding (300 bps of invoiceAmount)
        uint256 principalRepaid;
        uint256 feeEarned; // 0 until repaid; stays 0 on loss
        uint256 loss; // principal when Lost, else 0
        AdvanceStatus status;
    }

    // ---- events (ERC-4626 Deposit/Withdraw and ERC-20 Transfer/Approval are inherited) ----
    /// @param outstandingPrincipalAfter vault-wide outstanding principal after this advance.
    event AdvanceFunded(
        uint256 indexed invoiceId,
        address indexed freelancer,
        uint256 invoiceAmount,
        uint256 principal,
        uint256 fee,
        uint256 outstandingPrincipalAfter
    );
    event AdvanceRepaid(uint256 indexed invoiceId, uint256 principalRepaid, uint256 feeEarned);
    event AdvanceLossFinalized(uint256 indexed invoiceId, uint256 principalLoss);
    event EscrowSet(address indexed escrow);
    event AdvancesPaused(address indexed account);
    event AdvancesUnpaused(address indexed account);
    // The full pause emits OpenZeppelin Pausable's Paused(account) / Unpaused(account).

    // ---- errors ----
    error InvalidAddress();
    error EscrowAlreadySet();
    error EscrowNotSet();
    error NotEscrow();
    error UnsupportedTokenBehavior();
    error AdvancesAreDisabled();
    error EscrowMismatch();
    error InvalidAmount();
    error InvalidFee(uint256 provided, uint256 expected);
    error AdvanceAlreadyExists(uint256 invoiceId);
    error AdvanceNotOpen(uint256 invoiceId, AdvanceStatus actual);
    error AdvanceExceedsInvoiceCap(uint256 principal, uint256 invoiceAmount);
    error ExceedsUtilizationLimit(uint256 outstandingAfter, uint256 maxOutstanding);
    error ExceedsInvoiceExposureLimit(uint256 principal, uint256 maxPrincipal);
    error InsufficientLiquidity(uint256 required, uint256 available);
    // Plus OZ ERC4626 (ERC4626ExceededMax*), Pausable and AccessControl errors.

    // ---- escrow-only writes ----
    function fundAdvance(
        uint256 invoiceId,
        address freelancer,
        uint256 invoiceAmount,
        uint256 principal,
        uint256 fee
    ) external;
    function recordRepayment(uint256 invoiceId) external;
    function finalizeLoss(uint256 invoiceId) external;

    // ---- admin / operator / pauser ----
    function setEscrow(address escrow_) external; // DEFAULT_ADMIN_ROLE, once
    function pause() external; // PAUSER_ROLE or OPERATOR_ROLE (full pause)
    function unpause() external; // OPERATOR_ROLE only
    function pauseAdvances() external; // PAUSER_ROLE or OPERATOR_ROLE
    function unpauseAdvances() external; // OPERATOR_ROLE only

    // ---- views ----
    function escrow() external view returns (address);
    function paused() external view returns (bool);
    function advancesPaused() external view returns (bool);
    function advancesEnabled() external view returns (bool);
    function getAdvance(uint256 invoiceId) external view returns (Advance memory);
    /// @notice RLUSD the vault actually holds; the only amount that can be redeemed or advanced.
    function availableLiquidity() external view returns (uint256);
    function outstandingPrincipal() external view returns (uint256);
    function totalRealizedLosses() external view returns (uint256);
    function totalFeesEarned() external view returns (uint256);
    /// @notice Most assets all LPs together can withdraw now: cash minus `ceil(P / 4)`, so utilization
    /// stays <= 80% after the withdrawal. 0 at or above the cap. Basis of maxRedeem/maxWithdraw.
    function withdrawableLiquidity() external view returns (uint256);
    /// @notice outstandingPrincipal * 10000 / totalAssets (0 when totalAssets is 0).
    function utilizationBps() external view returns (uint256);
    /// @notice Largest principal fundAdvance would accept now (0 while advances are disabled or
    /// no escrow is set). Computed from the same caps fundAdvance enforces.
    function maxAdvanceNow() external view returns (uint256);
    function MAX_ADVANCE_BPS() external view returns (uint256);
    function MAX_UTILIZATION_BPS() external view returns (uint256);
    function MAX_INVOICE_EXPOSURE_BPS() external view returns (uint256);
    function FEE_BPS() external view returns (uint256);
}
