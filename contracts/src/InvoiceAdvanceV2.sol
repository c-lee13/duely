// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IDuelyVault} from "./IDuelyVault.sol";
import {IInvoiceAdvanceV2} from "./IInvoiceAdvanceV2.sol";

/// @title InvoiceAdvanceV2
/// @notice Client escrow for freelance invoices. Advances are paid from the pooled DuelyVault, not
/// from an operator reserve. This contract holds only client escrow; it never holds LP funds.
///
/// Settlement economics (1,000 invoice): vault advances 900; the 30 fee (300 bps of invoice) is
/// fixed when the advance is funded. On approval the escrow repays the vault 930 and pays the
/// freelancer the remaining 70. On a client-win dispute the client is refunded all 1,000 and the
/// vault finalizes the 900 principal as a loss (no fee). Without an advance, the freelancer gets
/// the full amount and no fee exists.
///
/// Pull payments: the freelancer's remainder and the client's refund are CREDITED to a claimable
/// balance (RLUSD stays reserved in this contract) and paid out by the permissionless `claim`. A
/// payee that cannot receive tokens (issuer blacklist or pause) therefore never blocks settlement,
/// the vault's repayment or the loss recognition, and its credit is never destroyed. Only the vault
/// is paid directly. Liabilities: balance >= totalEscrow + totalClaimable.
contract InvoiceAdvanceV2 is IInvoiceAdvanceV2, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant EVALUATOR_ROLE = keccak256("EVALUATOR_ROLE");

    uint256 public constant ADVANCE_BPS = 9_000;
    uint256 public constant FEE_BPS = 300;
    uint256 private constant BPS = 10_000;

    IERC20 public immutable paymentToken;
    IDuelyVault public immutable vault;
    uint256 public nextInvoiceId = 1;
    /// @notice Sum of client escrow liabilities for funded, unsettled invoices (base units).
    uint256 public totalEscrow;
    /// @notice RLUSD credited to payees and not yet claimed (base units).
    uint256 public totalClaimable;
    /// @notice Per-payee credited balance (freelancer remainders and client refunds).
    mapping(address => uint256) public claimable;

    mapping(uint256 => Invoice) private invoices;

    constructor(
        IERC20 paymentToken_,
        IDuelyVault vault_,
        address admin,
        address operator,
        address evaluator
    ) {
        if (
            address(paymentToken_) == address(0) || address(vault_) == address(0)
                || admin == address(0) || operator == address(0) || evaluator == address(0)
        ) revert InvalidAddress();
        // The vault must hold the same token and use the same advance/fee schedule.
        if (
            vault_.asset() != address(paymentToken_) || vault_.FEE_BPS() != FEE_BPS
                || vault_.MAX_ADVANCE_BPS() < ADVANCE_BPS
        ) revert VaultMismatch();
        paymentToken = paymentToken_;
        vault = vault_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, operator);
        _grantRole(EVALUATOR_ROLE, evaluator);
    }

    // ---------------------------------------------------------------------
    // Invoice lifecycle
    // ---------------------------------------------------------------------

    function createInvoice(address freelancer, uint256 amount, bytes32 metadataHash)
        external
        returns (uint256 invoiceId)
    {
        if (
            freelancer == address(0) || freelancer == address(this)
                || freelancer == address(paymentToken) || freelancer == address(vault)
        ) revert InvalidAddress();
        if (freelancer == msg.sender) revert InvalidInvoiceParties();
        if (amount == 0) revert InvalidAmount();
        if (metadataHash == bytes32(0)) revert InvalidHash();

        invoiceId = nextInvoiceId++;
        invoices[invoiceId] = Invoice({
            freelancer: freelancer,
            client: msg.sender,
            amount: amount,
            advanceAmount: 0,
            advanceFee: 0,
            metadataHash: metadataHash,
            evaluationHash: bytes32(0),
            status: InvoiceStatus.Created
        });

        emit InvoiceCreated(invoiceId, freelancer, msg.sender, amount, metadataHash);
    }

    function cancelInvoice(uint256 invoiceId) external {
        Invoice storage inv = _loadClientInvoice(invoiceId);
        if (inv.status != InvoiceStatus.Created) revert InvalidStatus(invoiceId, inv.status);

        inv.status = InvoiceStatus.Cancelled;
        emit InvoiceCancelled(invoiceId);
    }

    /// @notice Client escrows 100% of the invoice value.
    function fundInvoice(uint256 invoiceId) external nonReentrant {
        Invoice storage inv = _loadClientInvoice(invoiceId);
        if (inv.status != InvoiceStatus.Created) revert InvalidStatus(invoiceId, inv.status);

        uint256 amount = inv.amount;
        inv.status = InvoiceStatus.Funded;
        totalEscrow += amount;

        _pullExact(msg.sender, amount);
        emit InvoiceFunded(invoiceId, msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Advance, settlement, disputes
    // ---------------------------------------------------------------------

    /// @notice Evaluator approves an advance; the vault pays the freelancer directly. The backend
    /// must verify an explicit freelancer request and a passing evaluation first; the contract
    /// cannot. The vault independently enforces liquidity, risk limits, the 90% cap, the fee and
    /// one advance per invoice. Client escrow is untouched.
    function approveAdvance(uint256 invoiceId, bytes32 evaluationHash)
        external
        nonReentrant
        onlyRole(EVALUATOR_ROLE)
    {
        Invoice storage inv = _load(invoiceId);
        if (inv.status != InvoiceStatus.Funded) revert InvalidStatus(invoiceId, inv.status);
        if (evaluationHash == bytes32(0)) revert InvalidHash();

        uint256 amount = inv.amount;
        (uint256 advance, uint256 fee,,) = quoteAdvance(amount);
        if (advance == 0) revert ZeroAdvance();

        address freelancer = inv.freelancer;
        inv.advanceAmount = advance;
        inv.advanceFee = fee;
        inv.evaluationHash = evaluationHash;
        inv.status = InvoiceStatus.Advanced;

        vault.fundAdvance(invoiceId, freelancer, amount, advance, fee);
        emit AdvancePaid(invoiceId, freelancer, advance, fee, evaluationHash);
    }

    /// @notice Client approves: settles from escrow (vault repaid first if an advance exists).
    function approveCompletion(uint256 invoiceId) external nonReentrant {
        Invoice storage inv = _loadClientInvoice(invoiceId);
        if (inv.status != InvoiceStatus.Funded && inv.status != InvoiceStatus.Advanced) {
            revert InvalidStatus(invoiceId, inv.status);
        }
        _settleInvoice(invoiceId, inv);
    }

    function raiseDispute(uint256 invoiceId) external {
        Invoice storage inv = _loadClientInvoice(invoiceId);
        if (inv.status != InvoiceStatus.Funded && inv.status != InvoiceStatus.Advanced) {
            revert InvalidStatus(invoiceId, inv.status);
        }

        inv.status = InvoiceStatus.Disputed;
        emit InvoiceDisputed(invoiceId, msg.sender, inv.advanceAmount);
    }

    /// @notice Binary ruling. `true`: normal settlement. `false`: the client is credited the full
    /// escrow (claimable) and the vault finalizes any advance principal as a realized loss (no fee).
    /// The freelancer keeps the advance already paid; it is never clawed back. The ruling cannot be
    /// blocked by the client's ability to receive tokens.
    function resolveDispute(uint256 invoiceId, bool releaseToFreelancer)
        external
        nonReentrant
        onlyRole(OPERATOR_ROLE)
    {
        Invoice storage inv = _load(invoiceId);
        if (inv.status != InvoiceStatus.Disputed) revert InvalidStatus(invoiceId, inv.status);

        if (releaseToFreelancer) {
            emit DisputeResolved(invoiceId, true, 0);
            _settleInvoice(invoiceId, inv);
            return;
        }

        uint256 amount = inv.amount;
        uint256 vaultLoss = inv.advanceAmount;
        inv.status = InvoiceStatus.Cancelled;
        totalEscrow -= amount;

        if (vaultLoss > 0) vault.finalizeLoss(invoiceId);
        _credit(invoiceId, inv.client, amount);

        emit DisputeResolved(invoiceId, false, vaultLoss);
        emit InvoiceCancelled(invoiceId);
    }

    // ---------------------------------------------------------------------
    // Claims (pull payments)
    // ---------------------------------------------------------------------

    /// @notice Permissionless. Pays `recipient` its entire claimable balance, to `recipient` and
    /// nowhere else, so nobody can redirect funds. The credit is zeroed before the transfer; if the
    /// token transfer fails (issuer pause, blacklist) the whole call reverts and the credit is intact.
    function claim(address recipient) external nonReentrant returns (uint256 amount) {
        amount = claimable[recipient];
        if (amount == 0) revert NothingToClaim(recipient);

        claimable[recipient] = 0;
        totalClaimable -= amount;

        uint256 balanceBefore = paymentToken.balanceOf(address(this));
        paymentToken.safeTransfer(recipient, amount);
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (balanceBefore - paymentToken.balanceOf(address(this)) != amount) {
            revert UnsupportedTokenBehavior();
        }
        emit ProceedsClaimed(recipient, msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getInvoice(uint256 invoiceId) external view returns (Invoice memory) {
        return _load(invoiceId);
    }

    /// @notice advance = floor(amount * 9000 / 10000); fee = floor(amount * 300 / 10000);
    /// vaultRepayment = advance + fee; freelancerRemainder = amount - vaultRepayment.
    function quoteAdvance(uint256 amount)
        public
        pure
        returns (uint256 advance, uint256 fee, uint256 vaultRepayment, uint256 freelancerRemainder)
    {
        advance = Math.mulDiv(amount, ADVANCE_BPS, BPS);
        fee = Math.mulDiv(amount, FEE_BPS, BPS);
        vaultRepayment = advance + fee;
        freelancerRemainder = amount - vaultRepayment;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev Shared by approveCompletion and resolveDispute(release). With an advance, the vault is
    /// repaid principal + the stored fee (vault pulls exactly that, checked by balance delta on both
    /// sides) and only the remainder is credited to the freelancer; without one, the freelancer is
    /// credited the full amount. The only token movement is the vault repayment; any failure there
    /// reverts all of it.
    function _settleInvoice(uint256 invoiceId, Invoice storage inv) private {
        uint256 amount = inv.amount;
        uint256 principal = inv.advanceAmount;
        uint256 fee = inv.advanceFee;
        uint256 toVault = principal + fee;
        uint256 toFreelancer = amount - toVault;

        inv.status = InvoiceStatus.Settled;
        totalEscrow -= amount;

        if (principal > 0) {
            uint256 balanceBefore = paymentToken.balanceOf(address(this));
            paymentToken.forceApprove(address(vault), toVault);
            vault.recordRepayment(invoiceId);
            // forge-lint: disable-next-line(incorrect-strict-equality)
            if (balanceBefore - paymentToken.balanceOf(address(this)) != toVault) {
                revert UnsupportedTokenBehavior();
            }
        }
        emit InvoiceSettled(invoiceId, principal, fee, toFreelancer);
        if (toFreelancer > 0) _credit(invoiceId, inv.freelancer, toFreelancer);
    }

    /// @dev Moves `amount` of already-escrowed RLUSD from the invoice's escrow liability to the payee's
    /// claimable balance. No tokens move; the reserve stays in this contract.
    function _credit(uint256 invoiceId, address recipient, uint256 amount) private {
        claimable[recipient] += amount;
        totalClaimable += amount;
        emit ProceedsCredited(invoiceId, recipient, amount);
    }

    function _load(uint256 invoiceId) private view returns (Invoice storage inv) {
        if (invoiceId == 0 || invoiceId >= nextInvoiceId) revert InvoiceNotFound(invoiceId);
        inv = invoices[invoiceId];
    }

    function _loadClientInvoice(uint256 invoiceId) private view returns (Invoice storage inv) {
        inv = _load(invoiceId);
        if (inv.client != msg.sender) revert NotInvoiceClient(invoiceId);
    }

    /// @dev Pulls `amount` from `from` and reverts unless exactly `amount` arrives.
    function _pullExact(address from, uint256 amount) private {
        uint256 balanceBefore = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(from, address(this), amount);
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (paymentToken.balanceOf(address(this)) - balanceBefore != amount) {
            revert UnsupportedTokenBehavior();
        }
    }
}
