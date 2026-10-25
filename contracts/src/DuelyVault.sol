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

/// @title DuelyVault
/// @notice Pooled RLUSD vault. LPs deposit the underlying asset and receive transferable
/// `dvRLUSD` shares. A2 FOUNDATION: LP deposits/redemptions, share pricing and pause scaffolding
/// only. The advance, repayment and loss functions revert until A3/A4.
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

    address public escrow;
    bool public advancesPaused;

    // Advance ledger. Written only by the A3/A4 escrow-only functions; zero in A2.
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

    /// @notice Shares redeemable right now: the owner's balance, capped by what the vault's
    /// actual token balance can pay. 0 while fully paused. `maxWithdraw` follows from this.
    function maxRedeem(address owner_) public view override(ERC4626, IERC4626) returns (uint256) {
        if (paused()) return 0;
        return
            Math.min(balanceOf(owner_), _convertToShares(availableLiquidity(), Math.Rounding.Floor));
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
    // Advance flow: not implemented until A3/A4
    // ---------------------------------------------------------------------

    function fundAdvance(uint256, address, uint256, uint256, uint256) external pure {
        revert AdvanceFlowNotImplemented();
    }

    function recordRepayment(uint256) external pure {
        revert AdvanceFlowNotImplemented();
    }

    function finalizeLoss(uint256) external pure {
        revert AdvanceFlowNotImplemented();
    }

    // ---------------------------------------------------------------------
    // Admin scaffolding
    // ---------------------------------------------------------------------

    /// @notice One-time authorization of the escrow. A3 adds the cross-checks against the escrow
    /// (`escrow.vault() == this`, matching payment token).
    function setEscrow(address escrow_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (escrow != address(0)) revert EscrowAlreadySet();
        if (escrow_ == address(0) || escrow_.code.length == 0) revert InvalidAddress();
        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    /// @notice Full emergency pause: blocks deposits, mints, withdrawals and redemptions (and,
    /// from A3, advance funding). Repayment and loss finalization will never be blocked.
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

    function utilizationBps() external view returns (uint256) {
        uint256 nav = totalAssets();
        if (nav == 0) return 0;
        return Math.mulDiv(outstandingPrincipal, BPS, nav);
    }

    function maxAdvanceNow() external view returns (uint256) {
        if (!advancesEnabled() || escrow == address(0)) return 0;
        uint256 nav = totalAssets();
        uint256 maxOutstanding = Math.mulDiv(nav, MAX_UTILIZATION_BPS, BPS);
        uint256 headroom =
            outstandingPrincipal >= maxOutstanding ? 0 : maxOutstanding - outstandingPrincipal;
        uint256 perInvoice = Math.mulDiv(nav, MAX_INVOICE_EXPOSURE_BPS, BPS);
        return Math.min(availableLiquidity(), Math.min(headroom, perInvoice));
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _checkPauserOrOperator() private view {
        if (!hasRole(PAUSER_ROLE, msg.sender)) _checkRole(OPERATOR_ROLE);
    }
}
