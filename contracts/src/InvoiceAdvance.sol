// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IInvoiceAdvance} from "./IInvoiceAdvance.sol";

/// @title InvoiceAdvance
/// @notice Escrow-backed early payment for freelance invoices using an operator-funded reserve.
/// Client escrow and operator reserve are separately accounted balances in this one contract.
contract InvoiceAdvance is IInvoiceAdvance, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant EVALUATOR_ROLE = keccak256("EVALUATOR_ROLE");

    IERC20 public immutable paymentToken;
    uint256 public nextInvoiceId = 1;
    /// @notice Operator-owned reserve liquidity (base units).
    uint256 public reserveBalance;
    /// @notice Sum of client escrow liabilities for funded, unsettled invoices (base units).
    uint256 public totalEscrow;

    mapping(uint256 => Invoice) private invoices;

    constructor(IERC20 paymentToken_, address admin, address operator, address evaluator) {
        if (
            address(paymentToken_) == address(0) || admin == address(0) || operator == address(0)
                || evaluator == address(0)
        ) revert InvalidAddress();
        paymentToken = paymentToken_;
        // Admin administers both roles (default OZ behavior) but holds no invoice authority.
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, operator);
        _grantRole(EVALUATOR_ROLE, evaluator);
    }

    // ---------------------------------------------------------------------
    // Invoice lifecycle
    // ---------------------------------------------------------------------

    /// @inheritdoc IInvoiceAdvance
    function createInvoice(address freelancer, uint256 amount, bytes32 metadataHash)
        external
        returns (uint256 invoiceId)
    {
        if (freelancer == address(0)) revert InvalidAddress();
        if (freelancer == msg.sender) revert InvalidInvoiceParties();
        if (amount == 0) revert InvalidAmount();
        if (metadataHash == bytes32(0)) revert InvalidHash();

        invoiceId = nextInvoiceId++;
        invoices[invoiceId] = Invoice({
            freelancer: freelancer,
            client: msg.sender,
            amount: amount,
            advanceAmount: 0,
            metadataHash: metadataHash,
            evaluationHash: bytes32(0),
            status: InvoiceStatus.Created
        });

        emit InvoiceCreated(invoiceId, freelancer, msg.sender, amount, metadataHash);
    }

    /// @inheritdoc IInvoiceAdvance
    function cancelInvoice(uint256 invoiceId) external {
        Invoice storage inv = _loadClientInvoice(invoiceId);
        if (inv.status != InvoiceStatus.Created) revert InvalidStatus(invoiceId, inv.status);

        inv.status = InvoiceStatus.Cancelled;
        emit InvoiceCancelled(invoiceId);
    }

    /// @inheritdoc IInvoiceAdvance
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

    /// @inheritdoc IInvoiceAdvance
    /// @dev The backend must verify an explicit freelancer request and a passing evaluation first;
    /// the contract cannot verify either. Paid from reserve only; escrow is untouched.
    function approveAdvance(uint256 invoiceId, bytes32 evaluationHash)
        external
        nonReentrant
        onlyRole(EVALUATOR_ROLE)
    {
        Invoice storage inv = _load(invoiceId);
        if (inv.status != InvoiceStatus.Funded) revert InvalidStatus(invoiceId, inv.status);
        if (evaluationHash == bytes32(0)) revert InvalidHash();

        uint256 advance = _advanceFor(inv.amount);
        if (advance == 0) revert ZeroAdvance();
        if (advance > reserveBalance) revert InsufficientReserve(advance, reserveBalance);

        inv.advanceAmount = advance;
        inv.evaluationHash = evaluationHash;
        inv.status = InvoiceStatus.Advanced;
        reserveBalance -= advance;

        address freelancer = inv.freelancer;
        paymentToken.safeTransfer(freelancer, advance);
        emit AdvancePaid(invoiceId, freelancer, advance, evaluationHash);
    }

    /// @inheritdoc IInvoiceAdvance
    function approveCompletion(uint256 invoiceId) external nonReentrant {
        Invoice storage inv = _loadClientInvoice(invoiceId);
        if (inv.status != InvoiceStatus.Funded && inv.status != InvoiceStatus.Advanced) {
            revert InvalidStatus(invoiceId, inv.status);
        }
        _settleInvoice(invoiceId, inv);
    }

    /// @inheritdoc IInvoiceAdvance
    function raiseDispute(uint256 invoiceId) external {
        Invoice storage inv = _loadClientInvoice(invoiceId);
        if (inv.status != InvoiceStatus.Funded && inv.status != InvoiceStatus.Advanced) {
            revert InvalidStatus(invoiceId, inv.status);
        }

        inv.status = InvoiceStatus.Disputed;
        emit InvoiceDisputed(invoiceId, msg.sender, inv.advanceAmount);
    }

    /// @inheritdoc IInvoiceAdvance
    /// @dev Refund never recovers a prior advance: it was already debited from reserve when paid
    /// and stays an operator loss, reported as `unrecoveredAdvance`.
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
        inv.status = InvoiceStatus.Cancelled;
        totalEscrow -= amount;

        paymentToken.safeTransfer(inv.client, amount);
        emit DisputeResolved(invoiceId, false, inv.advanceAmount);
        emit InvoiceCancelled(invoiceId);
    }

    // ---------------------------------------------------------------------
    // Reserve
    // ---------------------------------------------------------------------

    /// @inheritdoc IInvoiceAdvance
    function depositReserve(uint256 amount) external nonReentrant onlyRole(OPERATOR_ROLE) {
        if (amount == 0) revert InvalidAmount();

        reserveBalance += amount;
        _pullExact(msg.sender, amount);
        emit ReserveDeposited(msg.sender, amount);
    }

    /// @inheritdoc IInvoiceAdvance
    function withdrawReserve(uint256 amount) external nonReentrant onlyRole(OPERATOR_ROLE) {
        if (amount == 0) revert InvalidAmount();
        if (amount > reserveBalance) revert InsufficientReserve(amount, reserveBalance);

        reserveBalance -= amount;
        paymentToken.safeTransfer(msg.sender, amount);
        emit ReserveWithdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @inheritdoc IInvoiceAdvance
    function getInvoice(uint256 invoiceId) external view returns (Invoice memory) {
        return _load(invoiceId);
    }

    /// @inheritdoc IInvoiceAdvance
    function availableReserve() external view returns (uint256) {
        return reserveBalance;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev floor(amount * 9000 / 10000) without intermediate overflow.
    function _advanceFor(uint256 amount) private pure returns (uint256) {
        // Exact floor: q*9000 + floor(r*9000/10000) where amount = q*10000 + r.
        // forge-lint: disable-next-line(divide-before-multiply)
        return (amount / 10_000) * 9_000 + ((amount % 10_000) * 9_000) / 10_000;
    }

    /// @dev Shared by approveCompletion and resolveDispute(release). Repays any advance by
    /// reclassifying escrow into reserve internally; only the remainder leaves the contract.
    function _settleInvoice(uint256 invoiceId, Invoice storage inv) private {
        uint256 amount = inv.amount;
        uint256 reserveRepaid = inv.advanceAmount;
        uint256 freelancerPaid = amount - reserveRepaid;

        inv.status = InvoiceStatus.Settled;
        totalEscrow -= amount;
        reserveBalance += reserveRepaid;

        if (freelancerPaid > 0) paymentToken.safeTransfer(inv.freelancer, freelancerPaid);
        emit InvoiceSettled(invoiceId, reserveRepaid, freelancerPaid);
    }

    function _load(uint256 invoiceId) private view returns (Invoice storage inv) {
        if (invoiceId == 0 || invoiceId >= nextInvoiceId) revert InvoiceNotFound(invoiceId);
        inv = invoices[invoiceId];
    }

    function _loadClientInvoice(uint256 invoiceId) private view returns (Invoice storage inv) {
        inv = _load(invoiceId);
        if (inv.client != msg.sender) revert NotInvoiceClient(invoiceId);
    }

    /// @dev Pulls `amount` from `from` and reverts unless exactly `amount` arrives
    /// (rejects fee-on-transfer tokens).
    function _pullExact(address from, uint256 amount) private {
        uint256 balanceBefore = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(from, address(this), amount);
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (paymentToken.balanceOf(address(this)) - balanceBefore != amount) {
            revert UnsupportedTokenBehavior();
        }
    }
}
