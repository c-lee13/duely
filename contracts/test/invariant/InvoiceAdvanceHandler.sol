// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvoiceAdvance} from "../../src/InvoiceAdvance.sol";
import {IInvoiceAdvance} from "../../src/IInvoiceAdvance.sol";
import {MockUSDC} from "../../src/MockUSDC.sol";

/// @dev Drives randomized valid sequences across many invoices and records ghost accounting.
/// Every handler action either succeeds or asserts its expected revert, so the suite can run
/// with fail_on_revert.
contract InvoiceAdvanceHandler is Test {
    InvoiceAdvance public immutable ia;
    MockUSDC public immutable token;
    address public immutable operator;
    address public immutable evaluator;
    address[3] public clients;

    uint256[] public ids;
    mapping(uint256 => address) public freelancerOf;

    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    uint256 public ghostAdvanced;
    uint256 public ghostRepaid;
    uint256 public ghostUnrecovered;
    uint256 public ghostDonated;
    bool public ghostEscrowFinanced;

    uint256 constant MAX_AMOUNT = 1_000_000e6;

    constructor(InvoiceAdvance ia_, MockUSDC token_, address operator_, address evaluator_) {
        ia = ia_;
        token = token_;
        operator = operator_;
        evaluator = evaluator_;
        for (uint256 i; i < 3; i++) {
            clients[i] = address(uint160(uint256(keccak256(abi.encode("client", i)))));
            vm.prank(clients[i]);
            token.approve(address(ia_), type(uint256).max);
        }
        vm.prank(operator_);
        token.approve(address(ia_), type(uint256).max);
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    // ---- actions ----

    function create(uint256 clientSeed, uint256 amount, bool andFund) external {
        amount = bound(amount, 1, MAX_AMOUNT);
        address c = clients[clientSeed % 3];
        address f = address(uint160(uint256(keccak256(abi.encode("freelancer", ids.length)))));
        token.mint(c, amount);

        vm.startPrank(c);
        uint256 id = ia.createInvoice(f, amount, keccak256(abi.encode(ids.length)));
        if (andFund) ia.fundInvoice(id);
        vm.stopPrank();

        ids.push(id);
        freelancerOf[id] = f;
    }

    function fund(uint256 seed) external {
        (uint256 id, IInvoiceAdvance.Invoice memory inv) = _pick(seed, _bit(0));
        if (id == 0) return;
        vm.prank(inv.client);
        ia.fundInvoice(id);
    }

    function cancel(uint256 seed) external {
        (uint256 id, IInvoiceAdvance.Invoice memory inv) = _pick(seed, _bit(0));
        if (id == 0) return;
        vm.prank(inv.client);
        ia.cancelInvoice(id);
    }

    function advance(uint256 seed) external {
        (uint256 id, IInvoiceAdvance.Invoice memory inv) = _pick(seed, _bit(1));
        if (id == 0) return;
        uint256 adv = (inv.amount * 9_000) / 10_000;
        uint256 reserveBefore = ia.reserveBalance();
        uint256 escrowBefore = ia.totalEscrow();

        vm.prank(evaluator);
        if (adv == 0) {
            vm.expectRevert(IInvoiceAdvance.ZeroAdvance.selector);
            ia.approveAdvance(id, keccak256(abi.encode("eval", id)));
            return;
        }
        if (adv > reserveBefore) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IInvoiceAdvance.InsufficientReserve.selector, adv, reserveBefore
                )
            );
            ia.approveAdvance(id, keccak256(abi.encode("eval", id)));
            return;
        }
        ia.approveAdvance(id, keccak256(abi.encode("eval", id)));

        if (ia.totalEscrow() != escrowBefore || ia.reserveBalance() != reserveBefore - adv) {
            ghostEscrowFinanced = true;
        }
        ghostAdvanced += adv;
    }

    function complete(uint256 seed) external {
        (uint256 id, IInvoiceAdvance.Invoice memory inv) = _pick(seed, _bit(1) | _bit(2));
        if (id == 0) return;
        vm.prank(inv.client);
        ia.approveCompletion(id);
        ghostRepaid += inv.advanceAmount;
    }

    function dispute(uint256 seed) external {
        (uint256 id, IInvoiceAdvance.Invoice memory inv) = _pick(seed, _bit(1) | _bit(2));
        if (id == 0) return;
        vm.prank(inv.client);
        ia.raiseDispute(id);
    }

    function resolve(uint256 seed, bool release) external {
        (uint256 id, IInvoiceAdvance.Invoice memory inv) = _pick(seed, _bit(4));
        if (id == 0) return;
        vm.prank(operator);
        ia.resolveDispute(id, release);
        if (release) ghostRepaid += inv.advanceAmount;
        else ghostUnrecovered += inv.advanceAmount;
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, MAX_AMOUNT);
        token.mint(operator, amount);
        vm.prank(operator);
        ia.depositReserve(amount);
        ghostDeposited += amount;
    }

    function withdraw(uint256 amount, bool overdraw) external {
        uint256 reserve = ia.reserveBalance();
        uint256 escrowBefore = ia.totalEscrow();
        vm.prank(operator);
        if (overdraw || reserve == 0) {
            // Anything above reserve must fail even though escrow tokens are present.
            amount = bound(amount, reserve + 1, reserve + escrowBefore + 1);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IInvoiceAdvance.InsufficientReserve.selector, amount, reserve
                )
            );
            ia.withdrawReserve(amount);
            return;
        }
        amount = bound(amount, 1, reserve);
        ia.withdrawReserve(amount);
        if (ia.totalEscrow() != escrowBefore) ghostEscrowFinanced = true;
        ghostWithdrawn += amount;
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, MAX_AMOUNT);
        token.mint(address(ia), amount);
        ghostDonated += amount;
    }

    // ---- helpers ----

    function _bit(uint256 status) private pure returns (uint256) {
        return 1 << status;
    }

    /// @dev First invoice (starting at a seeded offset) whose status is in `mask`; 0 if none.
    function _pick(uint256 seed, uint256 mask)
        private
        view
        returns (uint256 id, IInvoiceAdvance.Invoice memory inv)
    {
        uint256 n = ids.length;
        if (n == 0) return (0, inv);
        uint256 start = seed % n;
        for (uint256 i; i < n; i++) {
            uint256 candidate = ids[(start + i) % n];
            inv = ia.getInvoice(candidate);
            if (mask & _bit(uint256(inv.status)) != 0) return (candidate, inv);
        }
    }
}
