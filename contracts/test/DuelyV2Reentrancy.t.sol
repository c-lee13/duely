// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DuelyVault} from "../src/DuelyVault.sol";
import {IDuelyVault} from "../src/IDuelyVault.sol";
import {InvoiceAdvanceV2} from "../src/InvoiceAdvanceV2.sol";
import {IInvoiceAdvanceV2} from "../src/IInvoiceAdvanceV2.sol";
import {HookToken} from "./mocks/HookToken.sol";
import {HookAttacker} from "./mocks/HookAttacker.sol";

/// A5: reentrancy through ERC-777-style token callbacks into every state-changing entry point of the
/// vault and the escrow, from each position an attacker can occupy (LP, freelancer, client).
contract DuelyV2ReentrancyTest is Test {
    uint256 internal constant E18 = 1e18;
    bytes4 internal constant GUARD = 0x3ee5aeb5; // ReentrancyGuardReentrantCall()
    bytes32 internal constant META = keccak256("agreement");
    bytes32 internal constant EVAL = keccak256("evaluation");

    HookToken internal tok;
    DuelyVault internal vault;
    InvoiceAdvanceV2 internal escrow;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal evaluator = makeAddr("evaluator");
    address internal pauser = makeAddr("pauser");
    address internal lp = makeAddr("lp");
    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");

    function setUp() public {
        tok = new HookToken();
        vault = new DuelyVault(IERC20(address(tok)), admin, operator, pauser);
        escrow = new InvoiceAdvanceV2(
            IERC20(address(tok)), IDuelyVault(address(vault)), admin, operator, evaluator
        );
        vm.prank(admin);
        vault.setEscrow(address(escrow));

        tok.mint(lp, 4000 * E18);
        vm.startPrank(lp);
        tok.approve(address(vault), type(uint256).max);
        vault.deposit(4000 * E18, lp);
        vm.stopPrank();

        tok.mint(client, 10_000 * E18);
        vm.prank(client);
        tok.approve(address(escrow), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _attacker(uint256 funds) internal returns (HookAttacker a) {
        a = new HookAttacker(IDuelyVault(address(vault)));
        tok.mint(address(a), funds);
        a.approve(IERC20(address(tok)), address(vault));
        a.approve(IERC20(address(tok)), address(escrow));
    }

    /// @dev Every entry point an attacker could try to re-enter, with plausible arguments.
    function _payloads(uint256 id, address who) internal view returns (bytes[] memory p) {
        p = new bytes[](12);
        p[0] = abi.encodeCall(vault.deposit, (1, who));
        p[1] = abi.encodeCall(vault.mint, (1, who));
        p[2] = abi.encodeCall(vault.withdraw, (1, who, who));
        p[3] = abi.encodeCall(vault.redeem, (1, who, who));
        p[4] = abi.encodeCall(vault.fundAdvance, (77, who, 1000 * E18, 900 * E18, 100 * E18));
        p[5] = abi.encodeCall(vault.recordRepayment, (id));
        p[6] = abi.encodeCall(vault.finalizeLoss, (id));
        p[7] = abi.encodeCall(escrow.fundInvoice, (id));
        p[8] = abi.encodeCall(escrow.approveAdvance, (id, EVAL));
        p[9] = abi.encodeCall(escrow.approveCompletion, (id));
        p[10] = abi.encodeCall(escrow.resolveDispute, (id, false));
        p[11] = abi.encodeCall(escrow.claim, (who));
    }

    /// @dev `_payloads` indexes 0-6 are vault calls, 7-11 escrow calls.
    function _route(uint256 i) internal view returns (address) {
        return i >= 7 ? address(escrow) : address(vault);
    }

    /// @dev A re-entry into the contract whose guard is currently held must hit the guard; a call into
    /// the other contract is not covered by that guard and must fail on its own authorization/state.
    function _assertBlocked(HookAttacker a, bool sameContractGuardHeld) internal view {
        assertTrue(a.fired(), "hook fired");
        assertFalse(a.ok(), "re-entry must fail");
        if (sameContractGuardHeld) assertEq(a.retSelector(), GUARD);
    }

    function _createFunded(address who, address to, uint256 amount) internal returns (uint256 id) {
        return _createFundedShare(who, to, amount, 10_000);
    }

    function _createFundedShare(address who, address to, uint256 amount, uint256 share) internal returns (uint256 id) {
        vm.prank(who);
        id = escrow.createInvoice(to, amount, META, share);
        vm.prank(who);
        escrow.fundInvoice(id);
    }

    function test_guardSelectorConstantIsRight() public pure {
        assertEq(GUARD, ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    // ------------------------------------------------------------------ attacker as LP

    function test_lp_reentersFromSenderHookDuringDeposit() public {
        HookAttacker a = _attacker(1000 * E18);
        uint256 price = vault.convertToAssets(1e24);
        uint256 nav = vault.totalAssets();
        bytes[] memory p = _payloads(1, address(a));
        for (uint256 i; i < p.length; i++) {
            uint256 snap = vm.snapshotState();
            a.arm(_route(i), p[i], true); // fires BEFORE the deposit transfer moves tokens
            a.exec(address(vault), abi.encodeCall(vault.deposit, (1000 * E18, address(a))));
            _assertBlocked(a, _route(i) == address(vault));
            assertGt(vault.balanceOf(address(a)), 0);
            // The hook ran before any state change, so it saw the pre-deposit state.
            assertEq(a.seenTotalAssets(), nav);
            assertEq(a.seenPrice(), price);
            assertEq(vault.totalAssets(), nav + 1000 * E18, "deposit completed exactly once");
            vm.revertToState(snap);
        }
    }

    function test_lp_reentersFromReceiveHookDuringRedeem() public {
        HookAttacker a = _attacker(1000 * E18);
        a.exec(address(vault), abi.encodeCall(vault.deposit, (1000 * E18, address(a))));
        uint256 half = vault.balanceOf(address(a)) / 2;

        bytes[] memory p = _payloads(1, address(a));
        for (uint256 i; i < p.length; i++) {
            uint256 snap = vm.snapshotState();
            uint256 balBefore = tok.balanceOf(address(a));
            uint256 expected = vault.previewRedeem(half);
            a.arm(_route(i), p[i], false); // fires AFTER the tokens were sent
            a.exec(address(vault), abi.encodeCall(vault.redeem, (half, address(a), address(a))));
            _assertBlocked(a, _route(i) == address(vault));
            assertEq(tok.balanceOf(address(a)) - balBefore, expected, "paid exactly once");
            // Shares were burned before the transfer: the callback saw the final state.
            assertEq(a.seenTotalAssets(), vault.totalAssets());
            assertEq(a.seenPrice(), vault.convertToAssets(1e24));
            vm.revertToState(snap);
        }
    }

    function test_lp_reentersDuringWithdraw_andMint() public {
        HookAttacker a = _attacker(2000 * E18);
        a.exec(address(vault), abi.encodeCall(vault.deposit, (1000 * E18, address(a))));
        bytes memory again = abi.encodeCall(vault.withdraw, (1, address(a), address(a)));

        a.arm(address(vault), again, false);
        a.exec(address(vault), abi.encodeCall(vault.withdraw, (100 * E18, address(a), address(a))));
        assertFalse(a.ok());
        assertEq(a.retSelector(), GUARD);

        a.arm(address(vault), again, true); // sender hook while minting
        a.exec(address(vault), abi.encodeCall(vault.mint, (10 * E18 * 1e6, address(a))));
        assertFalse(a.ok());
        assertEq(a.retSelector(), GUARD);
    }

    // ------------------------------------------------------------------ attacker as freelancer

    function test_freelancer_reentersWhenAdvanceIsPaid() public {
        HookAttacker a = _attacker(0);
        uint256 id = _createFunded(client, address(a), 1000 * E18);
        uint256 price = vault.convertToAssets(1e24);
        bytes[] memory p = _payloads(id, address(a));
        for (uint256 i; i < p.length; i++) {
            uint256 snap = vm.snapshotState();
            a.arm(_route(i), p[i], false);
            vm.prank(evaluator);
            escrow.approveAdvance(id, EVAL);
            _assertBlocked(a, true); // vault.fundAdvance and escrow.approveAdvance both hold their guard
            assertEq(tok.balanceOf(address(a)), 900 * E18, "paid exactly once");
            assertEq(vault.outstandingPrincipal(), 900 * E18);
            // Transfer is the last step, so the callback saw the final, consistent state:
            // NAV and share price unchanged by funding.
            assertEq(a.seenTotalAssets(), 4000 * E18);
            assertEq(a.seenPrice(), price);
            vm.revertToState(snap);
        }
    }

    /// @dev Settlement itself no longer pays the freelancer (pull payments), so the callback fires from the
    /// claim. The escrow guard is held during `claim`; the vault's guard is free, so ordinary LP calls
    /// by the attacker (payloads 0-3) are simply legitimate and are not exercised. Everything privileged
    /// (4-6) and every escrow call (7-11) must fail.
    function test_freelancer_reentersWhenRemainderIsClaimed() public {
        HookAttacker a = _attacker(0);
        // 50% slider: advance 450, fee 100, remainder 450.
        uint256 id = _createFundedShare(client, address(a), 1000 * E18, 5_000);
        vm.prank(evaluator);
        escrow.approveAdvance(id, EVAL);
        vm.prank(client);
        escrow.approveCompletion(id);
        assertEq(tok.balanceOf(address(a)), 450 * E18, "settlement did not push the remainder");
        assertEq(escrow.claimable(address(a)), 450 * E18);

        bytes[] memory p = _payloads(id, address(a));
        for (uint256 i = 4; i < p.length; i++) {
            uint256 snap = vm.snapshotState();
            a.arm(_route(i), p[i], false);
            escrow.claim(address(a)); // anyone can trigger it; the recipient is fixed
            _assertBlocked(a, i >= 7);
            assertEq(tok.balanceOf(address(a)), 900 * E18, "450 + 450, once");
            assertEq(escrow.claimable(address(a)), 0);
            assertEq(escrow.totalClaimable(), 0);
            assertEq(a.seenTotalAssets(), 4100 * E18, "callback saw the fully settled state");
            vm.revertToState(snap);
        }
    }

    // ------------------------------------------------------------------ attacker as client

    function test_client_reentersWhenRefundIsClaimed_exactlyOneRefund() public {
        HookAttacker a = _attacker(1000 * E18);
        uint256 start = tok.balanceOf(address(a));
        a.exec(
            address(escrow), abi.encodeCall(escrow.createInvoice, (freelancer, 1000 * E18, META, 10_000))
        );
        uint256 id = 1;
        a.exec(address(escrow), abi.encodeCall(escrow.fundInvoice, (id)));
        vm.prank(evaluator);
        escrow.approveAdvance(id, EVAL);
        a.exec(address(escrow), abi.encodeCall(escrow.raiseDispute, (id)));
        vm.prank(operator);
        escrow.resolveDispute(id, false);
        assertEq(tok.balanceOf(address(a)), 0, "the ruling itself pays nothing");
        assertEq(escrow.claimable(address(a)), 1000 * E18);
        assertEq(vault.totalRealizedLosses(), 900 * E18, "loss recognized once");

        // Re-entry attempts from inside the claim, including the ones only the client may legitimately call.
        bytes[] memory p = new bytes[](7);
        p[0] = abi.encodeCall(escrow.approveCompletion, (id));
        p[1] = abi.encodeCall(escrow.raiseDispute, (id));
        p[2] = abi.encodeCall(escrow.cancelInvoice, (id));
        p[3] = abi.encodeCall(escrow.fundInvoice, (id));
        p[4] = abi.encodeCall(escrow.claim, (address(a))); // double claim
        p[5] = abi.encodeCall(vault.finalizeLoss, (id));
        p[6] = abi.encodeCall(vault.redeem, (1, address(a), address(a)));
        for (uint256 i; i < p.length; i++) {
            uint256 snap = vm.snapshotState();
            a.arm(i >= 5 ? address(vault) : address(escrow), p[i], false);
            escrow.claim(address(a));
            assertTrue(a.fired());
            assertFalse(a.ok(), "no second payout or state change");
            assertEq(tok.balanceOf(address(a)), start, "refunded exactly once");
            assertEq(tok.balanceOf(address(escrow)), 0);
            assertEq(escrow.claimable(address(a)), 0);
            assertEq(escrow.totalClaimable(), 0);
            assertEq(vault.totalRealizedLosses(), 900 * E18, "loss unchanged");
            vm.revertToState(snap);
        }
    }

    function test_client_reentersWhileFunding_cannotCancelOrDoubleFund() public {
        HookAttacker a = _attacker(1000 * E18);
        a.exec(
            address(escrow), abi.encodeCall(escrow.createInvoice, (freelancer, 1000 * E18, META, 10_000))
        );
        uint256 id = 1;
        bytes[] memory p = new bytes[](3);
        p[0] = abi.encodeCall(escrow.fundInvoice, (id)); // double funding
        p[1] = abi.encodeCall(escrow.cancelInvoice, (id)); // cancel mid-funding to keep the tokens?
        p[2] = abi.encodeCall(escrow.approveCompletion, (id));
        for (uint256 i; i < p.length; i++) {
            uint256 snap = vm.snapshotState();
            a.arm(address(escrow), p[i], true); // sender hook: before the escrow pulls the tokens
            a.exec(address(escrow), abi.encodeCall(escrow.fundInvoice, (id)));
            assertTrue(a.fired());
            assertFalse(a.ok());
            assertEq(tok.balanceOf(address(escrow)), 1000 * E18, "escrow holds exactly the invoice");
            assertEq(escrow.totalEscrow(), 1000 * E18);
            assertEq(
                uint8(escrow.getInvoice(id).status), uint8(IInvoiceAdvanceV2.InvoiceStatus.Funded)
            );
            vm.revertToState(snap);
        }
    }

    /// @dev A client may legitimately raise a dispute at any point once Funded, including from inside
    /// its own funding callback. The result must still be consistent: escrow solvent, invoice Disputed.
    function test_client_disputeFromInsideFundingCallback_staysConsistent() public {
        HookAttacker a = _attacker(1000 * E18);
        a.exec(
            address(escrow), abi.encodeCall(escrow.createInvoice, (freelancer, 1000 * E18, META, 10_000))
        );
        a.arm(address(escrow), abi.encodeCall(escrow.raiseDispute, (1)), true);
        a.exec(address(escrow), abi.encodeCall(escrow.fundInvoice, (1)));
        assertTrue(a.ok());
        assertEq(
            uint8(escrow.getInvoice(1).status), uint8(IInvoiceAdvanceV2.InvoiceStatus.Disputed)
        );
        assertGe(tok.balanceOf(address(escrow)), escrow.totalEscrow(), "escrow solvent");
        // Operator still resolves it normally.
        vm.prank(operator);
        escrow.resolveDispute(1, false);
        escrow.claim(address(a));
        assertEq(tok.balanceOf(address(a)), 1000 * E18);
    }
}
