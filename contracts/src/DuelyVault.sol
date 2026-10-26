// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IDuelyVault} from "./IDuelyVault.sol";
import {IInvoiceAdvanceV2} from "./IInvoiceAdvanceV2.sol";

/// @title DuelyVault
/// @notice Pooled RLUSD vault. LPs deposit the underlying asset and receive transferable
/// `dvRLUSD` shares. A2: LP deposits/redemptions, share pricing, pause scaffolding. A3: advance
/// funding. A4: repayment (fee income) and loss finalization.
///
/// Accounting (docs/VAULT_IMPLEMENTATION_SPEC.md §4.2):
///   totalAssets = token.balanceOf(vault) + outstandingPrincipal          (impairment is 0)
/// Cash is the real token balance, so direct donations raise share value for all LPs; the
/// virtual offset (6) provides inflation-attack resistance. Redemptions are capped by the
/// vault's actual token balance (deployed principal is never redeemable).
contract DuelyVault is IDuelyVault, ERC4626, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint8 private constant DECIMALS_OFFSET = 6;
    uint256 private constant BPS = 10_000;

    uint256 public constant MAX_ADVANCE_BPS = 9_000;
    uint256 public constant MAX_UTILIZATION_BPS = 8_000;
    uint256 public constant MAX_INVOICE_EXPOSURE_BPS = 2_500;
    /// @notice Financing fee, in bps of invoice value, that the escrow must quote at funding.
    uint256 public constant FEE_BPS = 1_000;

    address public escrow;
    bool public advancesPaused;

    // Advance ledger. Written only by the escrow-only functions (fundAdvance in A3;
    // recordRepayment / finalizeLoss in A4).
    uint256 public outstandingPrincipal;
    uint256 public totalRealizedLosses;
    uint256 public totalFeesEarned;
    mapping(uint256 => Advance) private advances;

    constructor(IERC20 asset_, address admin, address operator, address pauser)
        ERC20("Duely Vault Share", "dvRLUSD")
        ERC4626(asset_)
    {
        if (
            address(asset_) == address(0) || admin == address(0) || operator == address(0)
                || pauser == address(0)
        ) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, operator);
        _grantRole(PAUSER_ROLE, pauser);
    }

    // ---------------------------------------------------------------------
    // ERC-4626 (LP side)
    // ---------------------------------------------------------------------

    /// @notice Real token balance plus principal currently advanced (carried at par).
    function totalAssets() public view override(ERC4626, IERC4626) returns (uint256) {
        return availableLiquidity() + outstandingPrincipal;
    }

    function deposit(uint256 assets, address receiver)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return super.redeem(shares, receiver, owner_);
    }

    /// @notice No TVL cap; 0 while the vault is fully paused.
    function maxDeposit(address receiver)
        public
        view
        override(ERC4626, IERC4626)
        returns (uint256)
    {
        return paused() ? 0 : super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override(ERC4626, IERC4626) returns (uint256) {
        return paused() ? 0 : super.maxMint(receiver);
    }

    /// @notice Shares redeemable right now: the owner's balance, capped by `withdrawableLiquidity()`
    /// (cash that can leave without pushing utilization above the 80% cap). 0 while fully paused.
    /// `maxWithdraw` follows from this (it is `previewRedeem(maxRedeem)`), so both are conservative:
    /// shares are rounded down, so the assets they redeem never exceed the cap.
    function maxRedeem(address owner_) public view override(ERC4626, IERC4626) returns (uint256) {
        if (paused()) return 0;
        return
            Math.min(
                balanceOf(owner_), _convertToShares(withdrawableLiquidity(), Math.Rounding.Floor)
            );
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }

    /// @dev Pulls `assets` and requires that exactly `assets` arrive (rejects fee-on-transfer
    /// tokens, as in V1) so shares are never minted against value that did not arrive.
    function _transferIn(address from, uint256 assets) internal override {
        uint256 balanceBefore = availableLiquidity();
        super._transferIn(from, assets);
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (availableLiquidity() - balanceBefore != assets) revert UnsupportedTokenBehavior();
    }

    // ---------------------------------------------------------------------
    // Advance flow (escrow-only)
    // ---------------------------------------------------------------------

    /// @notice Escrow-only. Pays `principal` from the vault's cash to `freelancer` and records
    /// the advance as Open. The escrow is the trust anchor for the invoice terms (it is immutable
    /// once set and is the only caller); the vault re-validates them against the finalized
    /// limits so an escrow bug cannot exceed 90% of the invoice, the exposure cap, the
    /// utilization cap, available cash, or advance the same invoice twice.
    /// Funding moves value from cash to outstanding principal, so NAV and share price are
    /// unchanged. All limits are measured against NAV before the advance.
    function fundAdvance(
        uint256 invoiceId,
        address freelancer,
        uint256 invoiceAmount,
        uint256 principal,
        uint256 fee
    ) external nonReentrant {
        address escrow_ = escrow;
        if (escrow_ == address(0)) revert EscrowNotSet();
        if (msg.sender != escrow_) revert NotEscrow();
        _requireNotPaused();
        if (advancesPaused) revert AdvancesAreDisabled();

        // Invoice terms.
        IERC20 token = IERC20(asset());
        if (
            freelancer == address(0) || freelancer == address(this) || freelancer == escrow_
                || freelancer == address(token)
        ) revert InvalidAddress();
        if (invoiceAmount == 0 || principal == 0) revert InvalidAmount();
        Advance storage adv = advances[invoiceId];
        if (adv.status != AdvanceStatus.None) revert AdvanceAlreadyExists(invoiceId);
        if (principal > Math.mulDiv(invoiceAmount, MAX_ADVANCE_BPS, BPS)) {
            revert AdvanceExceedsInvoiceCap(principal, invoiceAmount);
        }
        uint256 expectedFee = Math.mulDiv(invoiceAmount, FEE_BPS, BPS);
        if (fee != expectedFee) revert InvalidFee(fee, expectedFee);

        // Liquidity and risk limits (NAV before the advance).
        uint256 cash = availableLiquidity();
        if (principal > cash) revert InsufficientLiquidity(principal, cash);
        (, uint256 invoiceCap, uint256 headroom) = _riskCaps();
        if (principal > invoiceCap) revert ExceedsInvoiceExposureLimit(principal, invoiceCap);
        if (principal > headroom) {
            revert ExceedsUtilizationLimit(
                outstandingPrincipal + principal, outstandingPrincipal + headroom
            );
        }

        // Effects.
        adv.freelancer = freelancer;
        adv.invoiceAmount = invoiceAmount;
        adv.principal = principal;
        adv.fee = fee;
        adv.status = AdvanceStatus.Open;
        uint256 outstandingAfter = outstandingPrincipal + principal;
        outstandingPrincipal = outstandingAfter;

        // Interaction: exactly `principal` must leave the vault.
        token.safeTransfer(freelancer, principal);
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (cash - availableLiquidity() != principal) revert UnsupportedTokenBehavior();

        emit AdvanceFunded(invoiceId, freelancer, invoiceAmount, principal, fee, outstandingAfter);
    }

    /// @notice Escrow-only. Closes an Open advance as Repaid. The amounts come from the advance
    /// stored at funding (principal + fee), never from the caller: the vault pulls exactly that
    /// from the escrow (which must have approved it) and requires the balance to rise by exactly
    /// that amount. Principal returns from outstanding to cash and the fee becomes realized NAV.
    /// Never blocked by either pause, so settlement cannot be trapped.
    function recordRepayment(uint256 invoiceId) external nonReentrant {
        address escrow_ = _requireEscrowCaller();
        Advance storage adv = _openAdvance(invoiceId);

        uint256 principal = adv.principal;
        uint256 fee = adv.fee;
        uint256 expected = principal + fee;

        adv.status = AdvanceStatus.Repaid;
        adv.principalRepaid = principal;
        adv.feeEarned = fee;
        outstandingPrincipal -= principal;
        totalFeesEarned += fee;

        uint256 balanceBefore = availableLiquidity();
        IERC20(asset()).safeTransferFrom(escrow_, address(this), expected);
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (availableLiquidity() - balanceBefore != expected) revert UnsupportedTokenBehavior();

        emit AdvanceRepaid(invoiceId, principal, fee);
    }

    /// @notice Escrow-only. Finalizes an Open advance as a realized loss of its whole principal
    /// (binary dispute outcome: the client was refunded in full and nothing was recovered). No
    /// fee is earned and no tokens move; NAV falls by the principal exactly once because the
    /// advance leaves Open. Never blocked by either pause.
    function finalizeLoss(uint256 invoiceId) external nonReentrant {
        _requireEscrowCaller();
        Advance storage adv = _openAdvance(invoiceId);

        uint256 principal = adv.principal;
        adv.status = AdvanceStatus.Lost;
        adv.loss = principal;
        outstandingPrincipal -= principal;
        totalRealizedLosses += principal;

        emit AdvanceLossFinalized(invoiceId, principal);
    }

    // ---------------------------------------------------------------------
    // Admin scaffolding
    // ---------------------------------------------------------------------

    /// @notice One-time authorization of the escrow. The escrow must point back at this vault, use
    /// the same payment token and the same fee/advance schedule. This catches miswiring; it does
    /// NOT authenticate the contract: a malicious admin could authorize a contract that merely
    /// mimics these views, so the admin is trusted for this single call (deploy scripts must verify
    /// the escrow's bytecode and the admin should be a multisig). The right is spent only by a
    /// successful call.
    function setEscrow(address escrow_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (escrow != address(0)) revert EscrowAlreadySet();
        if (escrow_ == address(0) || escrow_.code.length == 0) revert InvalidAddress();
        if (!_isCompatibleEscrow(escrow_)) revert EscrowMismatch();
        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    /// @notice Full emergency pause: blocks deposits, mints, withdrawals, redemptions and advance
    /// funding. Repayment and loss finalization are never blocked.
    function pause() external {
        _checkPauserOrOperator();
        _pause();
    }

    function unpause() external onlyRole(OPERATOR_ROLE) {
        _unpause();
    }

    /// @notice Advance-only pause: LP deposits and withdrawals continue.
    function pauseAdvances() external {
        _checkPauserOrOperator();
        advancesPaused = true;
        emit AdvancesPaused(msg.sender);
    }

    function unpauseAdvances() external onlyRole(OPERATOR_ROLE) {
        advancesPaused = false;
        emit AdvancesUnpaused(msg.sender);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function paused() public view override(IDuelyVault, Pausable) returns (bool) {
        return super.paused();
    }

    function advancesEnabled() public view returns (bool) {
        return !paused() && !advancesPaused;
    }

    function getAdvance(uint256 invoiceId) external view returns (Advance memory) {
        return advances[invoiceId];
    }

    function availableLiquidity() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @notice The most assets all LPs together can withdraw right now: cash minus a buffer that keeps
    /// outstanding principal at or below 80% of NAV after the withdrawal. A withdrawal of `w` lowers
    /// NAV and cash by exactly `w`, so the condition `P * 10000 <= 8000 * (NAV - w)` gives
    /// `w <= cash - ceil(P * (10000 - 8000) / 8000)`; the buffer is rounded UP. 0 when utilization is
    /// already at or above the cap (for example after a loss). Independent of the pause flags.
    function withdrawableLiquidity() public view returns (uint256) {
        uint256 cash = availableLiquidity();
        uint256 buffer = Math.mulDiv(
            outstandingPrincipal, BPS - MAX_UTILIZATION_BPS, MAX_UTILIZATION_BPS, Math.Rounding.Ceil
        );
        return cash > buffer ? cash - buffer : 0;
    }

    function utilizationBps() external view returns (uint256) {
        uint256 nav = totalAssets();
        if (nav == 0) return 0;
        return Math.mulDiv(outstandingPrincipal, BPS, nav);
    }

    /// @notice The largest principal fundAdvance would accept right now, ignoring the per-invoice
    /// 90% terms (which depend on the invoice). Shares `_riskCaps` with fundAdvance so the two
    /// cannot drift apart.
    function maxAdvanceNow() external view returns (uint256) {
        if (!advancesEnabled() || escrow == address(0)) return 0;
        (, uint256 invoiceCap, uint256 headroom) = _riskCaps();
        return Math.min(availableLiquidity(), Math.min(headroom, invoiceCap));
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev NAV, the per-invoice exposure cap and the remaining utilization headroom, all floored
    /// so that `principal <= cap` is exactly `principal * 10000 <= NAV * bps`.
    function _riskCaps() private view returns (uint256 nav, uint256 invoiceCap, uint256 headroom) {
        nav = totalAssets();
        invoiceCap = Math.mulDiv(nav, MAX_INVOICE_EXPOSURE_BPS, BPS);
        uint256 maxOutstanding = Math.mulDiv(nav, MAX_UTILIZATION_BPS, BPS);
        headroom =
            outstandingPrincipal >= maxOutstanding ? 0 : maxOutstanding - outstandingPrincipal;
    }

    function _requireEscrowCaller() private view returns (address escrow_) {
        escrow_ = escrow;
        if (escrow_ == address(0)) revert EscrowNotSet();
        if (msg.sender != escrow_) revert NotEscrow();
    }

    function _openAdvance(uint256 invoiceId) private view returns (Advance storage adv) {
        adv = advances[invoiceId];
        if (adv.status != AdvanceStatus.Open) revert AdvanceNotOpen(invoiceId, adv.status);
    }

    function _isCompatibleEscrow(address escrow_) private view returns (bool) {
        IInvoiceAdvanceV2 e = IInvoiceAdvanceV2(escrow_);
        try e.vault() returns (IDuelyVault v) {
            if (address(v) != address(this)) return false;
        } catch {
            return false;
        }
        try e.paymentToken() returns (IERC20 token) {
            if (address(token) != asset()) return false;
        } catch {
            return false;
        }
        try e.FEE_BPS() returns (uint256 feeBps) {
            if (feeBps != FEE_BPS) return false;
        } catch {
            return false;
        }
        try e.ADVANCE_BPS() returns (uint256 advanceBps) {
            return advanceBps <= MAX_ADVANCE_BPS;
        } catch {
            return false;
        }
    }

    function _checkPauserOrOperator() private view {
        if (!hasRole(PAUSER_ROLE, msg.sender)) _checkRole(OPERATOR_ROLE);
    }
}
