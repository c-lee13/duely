// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Public interface of InvoiceAdvance (docs/CONTRACT_SPEC.md v1.1).
/// Types, events, errors and functions are frozen; do not change without team agreement.
interface IInvoiceAdvance {
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
        uint256 advanceAmount;
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
    event ReserveDeposited(address indexed operator, uint256 amount);
    event ReserveWithdrawn(address indexed operator, uint256 amount);
    event AdvancePaid(
        uint256 indexed invoiceId,
        address indexed freelancer,
        uint256 amount,
        bytes32 evaluationHash
    );
    event InvoiceSettled(uint256 indexed invoiceId, uint256 reserveRepaid, uint256 freelancerPaid);
    event InvoiceDisputed(
        uint256 indexed invoiceId, address indexed client, uint256 advanceAlreadyPaid
    );
    event DisputeResolved(
        uint256 indexed invoiceId, bool releasedToFreelancer, uint256 unrecoveredAdvance
    );

    error InvoiceNotFound(uint256 invoiceId);
    error InvalidAddress();
    error InvalidAmount();
    error InvalidHash();
    error InvalidInvoiceParties();
    error InvalidStatus(uint256 invoiceId, InvoiceStatus actual);
    error NotInvoiceClient(uint256 invoiceId);
    error NotInvoiceFreelancer(uint256 invoiceId);
    error InsufficientReserve(uint256 required, uint256 available);
    error ZeroAdvance();
    error UnsupportedTokenBehavior();

    function createInvoice(address freelancer, uint256 amount, bytes32 metadataHash)
        external
        returns (uint256 invoiceId);
    function cancelInvoice(uint256 invoiceId) external;
    function fundInvoice(uint256 invoiceId) external;
    function depositReserve(uint256 amount) external;
    function withdrawReserve(uint256 amount) external;
    function approveAdvance(uint256 invoiceId, bytes32 evaluationHash) external;
    function approveCompletion(uint256 invoiceId) external;
    function raiseDispute(uint256 invoiceId) external;
    function resolveDispute(uint256 invoiceId, bool releaseToFreelancer) external;
    function getInvoice(uint256 invoiceId) external view returns (Invoice memory);
    function availableReserve() external view returns (uint256);
}
