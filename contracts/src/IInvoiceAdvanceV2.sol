// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDuelyVault} from "./IDuelyVault.sol";

/// @notice Public interface of InvoiceAdvanceV2 (docs/VAULT_IMPLEMENTATION_SPEC.md §5.2).
/// V2 funds advances from DuelyVault instead of an operator reserve. The `Invoice` struct differs
/// from V1 (adds `advanceFee`), so V2 has its own ABI. Proposal until the compiled ABI is exported.
interface IInvoiceAdvanceV2 {
    enum InvoiceStatus {
        Created,
        Funded,
        Advanced,
        Settled,
        Disputed,
        Cancelled
    }

    struct Invoice {
        address freelancer;
        address client;
        uint256 amount;
        uint256 advanceAmount; // principal advanced by the vault, 0 before advance
        uint256 advanceFee; // 300 bps of `amount`, stored at advance time, 0 before advance
        bytes32 metadataHash;
        bytes32 evaluationHash;
        InvoiceStatus status;
    }

    event InvoiceCreated(
        uint256 indexed invoiceId,
        address indexed freelancer,
        address indexed client,
        uint256 amount,
        bytes32 metadataHash
    );
    event InvoiceFunded(uint256 indexed invoiceId, address indexed client, uint256 amount);
    event InvoiceCancelled(uint256 indexed invoiceId);
    event AdvancePaid(
        uint256 indexed invoiceId,
        address indexed freelancer,
        uint256 amount,
        uint256 fee,
        bytes32 evaluationHash
    );
    /// @param freelancerCredited remainder credited to the freelancer's claimable balance (pull payment).
    event InvoiceSettled(
        uint256 indexed invoiceId,
        uint256 vaultPrincipalRepaid,
        uint256 vaultFeePaid,
        uint256 freelancerCredited
    );
    /// @notice Escrow RLUSD reserved for `recipient` (freelancer remainder or client refund).
    event ProceedsCredited(uint256 indexed invoiceId, address indexed recipient, uint256 amount);
    event ProceedsClaimed(address indexed recipient, address indexed caller, uint256 amount);
    event InvoiceDisputed(
        uint256 indexed invoiceId, address indexed client, uint256 advanceAlreadyPaid
    );
    event DisputeResolved(uint256 indexed invoiceId, bool releasedToFreelancer, uint256 vaultLoss);

    error InvoiceNotFound(uint256 invoiceId);
    error InvalidAddress();
    error InvalidAmount();
    error InvalidHash();
    error InvalidInvoiceParties();
    error InvalidStatus(uint256 invoiceId, InvoiceStatus actual);
    error NotInvoiceClient(uint256 invoiceId);
    error ZeroAdvance();
    error UnsupportedTokenBehavior();
    error VaultMismatch();
    error NothingToClaim(address recipient);

    function createInvoice(address freelancer, uint256 amount, bytes32 metadataHash)
        external
        returns (uint256 invoiceId);
    function cancelInvoice(uint256 invoiceId) external;
    function fundInvoice(uint256 invoiceId) external;
    function approveAdvance(uint256 invoiceId, bytes32 evaluationHash) external;
    function approveCompletion(uint256 invoiceId) external;
    function raiseDispute(uint256 invoiceId) external;
    function resolveDispute(uint256 invoiceId, bool releaseToFreelancer) external;

    /// @notice Permissionless: pays `recipient`'s whole claimable balance to `recipient` (never elsewhere).
    function claim(address recipient) external returns (uint256 amount);

    function getInvoice(uint256 invoiceId) external view returns (Invoice memory);
    function claimable(address recipient) external view returns (uint256);
    function totalClaimable() external view returns (uint256);
    function quoteAdvance(uint256 amount)
        external
        pure
        returns (uint256 advance, uint256 fee, uint256 vaultRepayment, uint256 freelancerRemainder);
    function vault() external view returns (IDuelyVault);
    function paymentToken() external view returns (IERC20);
    function totalEscrow() external view returns (uint256);
    function nextInvoiceId() external view returns (uint256);
    function ADVANCE_BPS() external view returns (uint256);
    function FEE_BPS() external view returns (uint256);
}
