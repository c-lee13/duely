// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {DuelyVault} from "../../src/DuelyVault.sol";
import {IDuelyVault} from "../../src/IDuelyVault.sol";
import {InvoiceAdvanceV2} from "../../src/InvoiceAdvanceV2.sol";
import {IInvoiceAdvanceV2} from "../../src/IInvoiceAdvanceV2.sol";
import {ChaosToken} from "../mocks/ChaosToken.sol";
import {V2Handler} from "./V2Handler.sol";

/// @notice A6: stateful invariants over randomized sequences of the complete V2 lifecycle.
///
/// The handler (`V2Handler`) mixes LP deposits/withdrawals/transfers, invoice creation, funding,
/// advances, approvals, both dispute outcomes, claims, donations, pauses and unpauses, issuer
/// pause/blacklist/clawback, and hostile callers. Every handler action checks the outcome it expects
/// and records a violation instead of reverting, so these invariants run under `fail_on_revert`.
///
/// Risk limits are compile-time constants (there is no setter), so "risk-limit changes" cannot be
/// exercised; the handler instead attacks the role-gated functions and `setEscrow` continuously.
abstract contract V2InvariantBase is Test {
    uint256 internal constant OFFSET = 1e6;

    V2Handler internal h;
    ChaosToken internal token;
    DuelyVault internal vault;
    InvoiceAdvanceV2 internal escrow;

    function _allowEscrowClawback() internal pure virtual returns (bool);

    function setUp() public {
        h = new V2Handler(_allowEscrowClawback());
        token = h.token();
        vault = h.vault();
        escrow = h.escrow();
        targetContract(address(h));
    }

    // ------------------------------------------------------------------ helpers

    function _lpHolders() internal view returns (address[] memory a) {
        a = new address[](4);
        a[0] = h.lps(0);
        a[1] = h.lps(1);
        a[2] = h.lps(2);
        a[3] = h.stranger();
    }

    // =================================================================== the handler's own model

    /// Every action's outcome matched the model: authorization, pause behavior, expected reverts and
    /// successes, rounding direction, exact deltas, and one-shot (duplicate) protection.
    function invariant_modelAgreesWithTheContracts() public view {
        assertEq(h.violation(), "", h.violation());
    }

    // =================================================================== vault accounting

    /// NAV = actual RLUSD cash + outstanding principal, with nothing counted twice.
    function invariant_navIsCashPlusPrincipal() public view {
        assertEq(
            vault.totalAssets(), token.balanceOf(address(vault)) + vault.outstandingPrincipal()
        );
        assertEq(vault.availableLiquidity(), token.balanceOf(address(vault)));
    }

    /// Outstanding principal equals the sum of open advances, and matches the independent ghost model.
    function invariant_principalEqualsSumOfOpenAdvances() public view {
        uint256 n = h.idsLength();
        uint256 open;
        uint256 ghostOpen;
        for (uint256 i; i < n; i++) {
            uint256 id = h.ids(i);
            IDuelyVault.Advance memory a = vault.getAdvance(id);
            if (a.status == IDuelyVault.AdvanceStatus.Open) open += a.principal;
            (,,, uint256 gp,, V2Handler.S st) = h.gi(id);
            if (gp > 0 && (st == V2Handler.S.Advanced || st == V2Handler.S.Disputed)) {
                ghostOpen += gp;
            }
        }
        assertEq(vault.outstandingPrincipal(), open, "principal == sum of open advances");
        assertEq(open, ghostOpen, "vault agrees with the ghost model");
    }

    /// Fees and losses are recognized exactly once: the counters equal the sums over terminal advances
    /// and the ghost model, every funded advance is in exactly one state, and terminal states are final.
    function invariant_feesAndLossesRecognizedExactlyOnce() public view {
        uint256 n = h.idsLength();
        uint256 sumFees;
        uint256 sumLosses;
        uint256 open;
        uint256 repaid;
        uint256 lost;
        for (uint256 i; i < n; i++) {
            IDuelyVault.Advance memory a = vault.getAdvance(h.ids(i));
            if (a.status == IDuelyVault.AdvanceStatus.Open) {
                open++;
                assertEq(a.feeEarned + a.loss + a.principalRepaid, 0, "open advance has no outcome");
            } else if (a.status == IDuelyVault.AdvanceStatus.Repaid) {
                repaid++;
                sumFees += a.feeEarned;
                assertEq(a.principalRepaid, a.principal);
                assertEq(a.feeEarned, a.fee);
                assertEq(a.loss, 0, "repaid advance has no loss");
            } else if (a.status == IDuelyVault.AdvanceStatus.Lost) {
                lost++;
                sumLosses += a.loss;
                assertEq(a.loss, a.principal);
                assertEq(a.feeEarned + a.principalRepaid, 0, "lost advance earned nothing");
            }
        }
        assertEq(vault.totalFeesEarned(), sumFees);
        assertEq(vault.totalFeesEarned(), h.ghostFees());
        assertEq(vault.totalRealizedLosses(), sumLosses);
        assertEq(vault.totalRealizedLosses(), h.ghostLosses());
        assertEq(open + repaid + lost, h.nAdvanced(), "one state per funded advance");
        assertEq(repaid, h.nRepaid());
        assertEq(lost, h.nLost());
    }

    /// The escrow and vault ledgers match the ghost state machine for every invoice.
    function invariant_ledgersMatchTheGhostStateMachine() public view {
        uint256 n = h.idsLength();
        for (uint256 i; i < n; i++) {
            uint256 id = h.ids(i);
            (address c, address f, uint256 amount, uint256 gp, uint256 gfee, V2Handler.S st) =
                h.gi(id);
            IInvoiceAdvanceV2.Invoice memory inv = escrow.getInvoice(id);
            assertEq(uint8(inv.status), uint8(st), "invoice status");
            assertEq(inv.client, c);
            assertEq(inv.freelancer, f);
            assertEq(inv.amount, amount);
            assertEq(inv.advanceAmount, gp);
            assertEq(inv.advanceFee, gfee);

            IDuelyVault.AdvanceStatus vs = vault.getAdvance(id).status;
            if (gp == 0) {
                assertEq(uint8(vs), uint8(IDuelyVault.AdvanceStatus.None), "never advanced");
            } else if (st == V2Handler.S.Advanced || st == V2Handler.S.Disputed) {
                assertEq(uint8(vs), uint8(IDuelyVault.AdvanceStatus.Open));
            } else if (st == V2Handler.S.Settled) {
                assertEq(uint8(vs), uint8(IDuelyVault.AdvanceStatus.Repaid));
            } else if (st == V2Handler.S.Cancelled) {
                assertEq(uint8(vs), uint8(IDuelyVault.AdvanceStatus.Lost));
            }
        }
    }

    // =================================================================== risk limits

    /// Utilization stays within 80% of NAV in every reachable state, except after an issuer clawback
    /// from the vault (the only way to lower NAV without lowering principal). Funding and withdrawals
    /// are individually checked inside the handler; deposits, repayments, fees, donations and losses
    /// can only improve utilization.
    function invariant_utilizationWithinCapUnlessClawedBack() public view {
        if (!h.clawedVault()) {
            assertLe(vault.outstandingPrincipal() * 10_000, 8000 * vault.totalAssets());
        }
    }

    /// Above the cap nothing can leave and nothing new can be advanced.
    function invariant_aboveTheCapNothingLeavesAndNothingIsAdvanced() public view {
        if (vault.outstandingPrincipal() * 10_000 > 8000 * vault.totalAssets()) {
            assertEq(vault.withdrawableLiquidity(), 0);
            assertEq(vault.maxAdvanceNow(), 0);
            address[] memory lps = _lpHolders();
            for (uint256 i; i < lps.length; i++) {
                assertEq(vault.maxRedeem(lps[i]), 0);
                assertEq(vault.maxWithdraw(lps[i]), 0);
            }
        }
    }

    // =================================================================== escrow

    /// Escrow RLUSD >= unsettled escrow + unclaimed credits (unless the issuer clawed back from the
    /// escrow itself, which no contract can prevent), the books match the ghost model, and no
    /// allowance from the escrow to the vault survives a transaction.
    function invariant_escrowSolvency() public view {
        uint256 n = h.idsLength();
        uint256 liabilities;
        for (uint256 i; i < n; i++) {
            (,, uint256 amount,,, V2Handler.S st) = h.gi(h.ids(i));
            if (
                st == V2Handler.S.Funded || st == V2Handler.S.Advanced || st == V2Handler.S.Disputed
            ) {
                liabilities += amount;
            }
        }
        assertEq(escrow.totalEscrow(), liabilities, "totalEscrow == funded, unsettled invoices");
        if (!h.clawedEscrow()) {
            assertGe(
                token.balanceOf(address(escrow)),
                escrow.totalEscrow() + escrow.totalClaimable(),
                "escrow balance covers escrow + credits"
            );
        }
        assertEq(token.allowance(address(escrow), address(vault)), 0, "no standing allowance");
    }

    /// Total credits = total claims + outstanding claimable balances, per actor and in total.
    function invariant_creditsEqualClaimsPlusOutstanding() public view {
        uint256 outstanding;
        for (uint256 i; i < 3; i++) {
            address c = h.clients(i);
            address f = h.freelancers(i);
            assertEq(escrow.claimable(c), h.gClaimable(c));
            assertEq(escrow.claimable(f), h.gClaimable(f));
            outstanding += escrow.claimable(c) + escrow.claimable(f);
        }
        assertEq(escrow.totalClaimable(), outstanding, "no credit outside the known payees");
        assertEq(h.ghostCredited(), h.ghostClaimed() + escrow.totalClaimable());
    }

    // =================================================================== ERC-4626

    /// Conversions round against the user, limits are consistent with the cap and with each other.
    function invariant_erc4626RoundingAndLimits() public view {
        uint256 cash = token.balanceOf(address(vault));
        uint256 withdrawable = vault.withdrawableLiquidity();
        assertLe(withdrawable, cash);

        address[] memory lps = _lpHolders();
        for (uint256 i; i < lps.length; i++) {
            uint256 bal = vault.balanceOf(lps[i]);
            uint256 maxR = vault.maxRedeem(lps[i]);
            assertLe(maxR, bal);
            assertLe(vault.previewRedeem(maxR), withdrawable, "an exit never exceeds the cap");
            assertLe(vault.maxWithdraw(lps[i]), withdrawable);
            assertLe(
                vault.convertToAssets(bal), vault.totalAssets(), "no holder is worth more than NAV"
            );
        }
        uint256 supply = vault.totalSupply();
        assertLe(vault.previewRedeem(supply), vault.totalAssets(), "share solvency");
        uint256[4] memory xs = [uint256(1), 1e18, vault.totalAssets(), cash];
        for (uint256 i; i < xs.length; i++) {
            assertLe(
                vault.convertToAssets(vault.convertToShares(xs[i])), xs[i], "assets round trip"
            );
            assertLe(
                vault.convertToShares(vault.convertToAssets(xs[i])), xs[i], "shares round trip"
            );
            assertGe(
                vault.previewMint(xs[i]), vault.previewRedeem(xs[i]), "mint costs >= redeem pays"
            );
            assertGe(
                vault.previewWithdraw(xs[i]),
                vault.previewDeposit(xs[i]),
                "withdraw burns >= deposit mints"
            );
        }
    }

    /// Shares are fully accounted for by the LP holders.
    function invariant_shareSupplyEqualsHolderBalances() public view {
        address[] memory lps = _lpHolders();
        uint256 sum;
        for (uint256 i; i < lps.length; i++) {
            sum += vault.balanceOf(lps[i]);
        }
        assertEq(sum, vault.totalSupply());
    }

    // =================================================================== conservation

    /// RLUSD is conserved across every actor and both contracts: balances sum to the supply, which is
    /// exactly what the harness minted minus what the issuer clawed back.
    function invariant_conservationOfRLUSD() public view {
        address[] memory hs = h.holders();
        uint256 sum = token.balanceOf(address(vault)) + token.balanceOf(address(escrow));
        for (uint256 i; i < hs.length; i++) {
            sum += token.balanceOf(hs[i]);
        }
        assertEq(sum, token.totalSupply(), "every token is held by a tracked address");
        assertEq(token.totalSupply(), h.ghostMinted() - h.ghostClawed());
    }

    // =================================================================== authorization and pauses

    /// Pause flags always equal the model (only authorized calls change them) and nobody gained a role.
    function invariant_pauseStateAndRolesMatchTheModel() public view {
        assertEq(vault.paused(), h.gPaused());
        assertEq(vault.advancesPaused(), h.gAdvancesPaused());
        assertEq(vault.advancesEnabled(), !h.gPaused() && !h.gAdvancesPaused());
        assertEq(vault.escrow(), address(escrow));

        address[] memory hs = h.holders();
        bytes32[3] memory vaultRoles =
            [vault.DEFAULT_ADMIN_ROLE(), vault.OPERATOR_ROLE(), vault.PAUSER_ROLE()];
        bytes32[3] memory escrowRoles =
            [escrow.DEFAULT_ADMIN_ROLE(), escrow.OPERATOR_ROLE(), escrow.EVALUATOR_ROLE()];
        for (uint256 i; i < hs.length; i++) {
            for (uint256 r; r < 3; r++) {
                assertFalse(vault.hasRole(vaultRoles[r], hs[i]), "no escalation on the vault");
                assertFalse(escrow.hasRole(escrowRoles[r], hs[i]), "no escalation on the escrow");
            }
        }
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), h.admin()));
        assertTrue(vault.hasRole(vault.OPERATOR_ROLE(), h.operator()));
        assertTrue(vault.hasRole(vault.PAUSER_ROLE(), h.pauser()));
        assertTrue(escrow.hasRole(escrow.EVALUATOR_ROLE(), h.evaluator()));
        assertTrue(escrow.hasRole(escrow.OPERATOR_ROLE(), h.operator()));
        assertFalse(vault.hasRole(vault.OPERATOR_ROLE(), h.evaluator()));
        assertFalse(escrow.hasRole(escrow.EVALUATOR_ROLE(), h.operator()));
    }

    function afterInvariant() public view {
        string[24] memory names = [
            "lpDeposit",
            "lpRedeem",
            "lpWithdraw",
            "lpTransfer",
            "lpRoundTrip.deposit",
            "createInvoice",
            "cancelInvoice",
            "fundInvoice",
            "approveAdvance",
            "approveCompletion",
            "raiseDispute",
            "resolveRelease",
            "resolveRefund",
            "claim",
            "donate",
            "clawback",
            "toggleTokenPause",
            "toggleBlacklist",
            "pause",
            "unpause",
            "pauseAdvances",
            "unpauseAdvances",
            "unauthorized",
            "dup.approveAdvance"
        ];
        string memory line;
        for (uint256 i; i < names.length; i++) {
            bytes32 k = keccak256(bytes(names[i]));
            line = string.concat(
                line,
                names[i],
                "=",
                vm.toString(h.okCount(k)),
                "/",
                vm.toString(h.rejectedCount(k)),
                " "
            );
        }
        console2.log("calls ok/rejected:", line);
    }
}

/// @dev Issuer may pause, blacklist and claw back from every holder EXCEPT the escrow: the full
/// solvency invariant is asserted.
contract V2InvariantsTest is V2InvariantBase {
    function _allowEscrowClawback() internal pure override returns (bool) {
        return false;
    }
}

/// @dev Also lets the issuer claw back from the escrow. Escrow solvency is then a property of the
/// issuer, not the contracts, so only that one inequality is exempted (`clawedEscrow`); every other
/// invariant (NAV, principal, once-only fees/losses, credits = claims + outstanding, conservation,
/// one-shot protection, authorization) must still hold.
contract V2InvariantsEscrowClawbackTest is V2InvariantBase {
    function _allowEscrowClawback() internal pure override returns (bool) {
        return true;
    }
}

/// @notice Non-vacuity: a scripted sequence must reach every outcome the invariants rely on, with no
/// model violation, so the randomized suite cannot silently be exercising only reverting paths.
contract V2HandlerReachabilityTest is Test {
    function _ok(V2Handler h, string memory n) internal view returns (uint256) {
        return h.okCount(keccak256(bytes(n)));
    }

    function _no(V2Handler h, string memory n) internal view returns (uint256) {
        return h.rejectedCount(keccak256(bytes(n)));
    }

    /// @dev Creates, funds and advances one invoice for client `c` / freelancer `f`, trying invoice sizes
    /// until one fits under the vault's caps. Returns its index in the handler's id list.
    function _advanced(V2Handler h, uint256 c, uint256 f) internal returns (uint256 last) {
        uint256 before = h.nAdvanced();
        for (uint256 s = 2; s < 600; s++) {
            if (s % 5 < 2) continue; // skip dust-sized seeds
            h.createInvoice(c, f, s);
            last = h.idsLength() - 1;
            h.fundInvoice(last);
            h.approveAdvance(last);
            if (h.nAdvanced() > before) return last;
        }
        revert("no invoice size could be advanced");
    }

    function test_scriptedSequenceReachesEveryOutcome() public {
        V2Handler h = new V2Handler(false);
        uint256 i;

        // approved with advance -> freelancer claims
        i = _advanced(h, 0, 0);
        h.approveCompletion(i);
        h.claim(1, 0); // freelancer0
        // refund with advance (loss) -> client claims
        i = _advanced(h, 1, 1);
        h.raiseDispute(i);
        h.resolveDispute(i, false);
        h.claim(2, 0); // client1
        // release with advance
        i = _advanced(h, 2, 2);
        h.raiseDispute(i);
        h.resolveDispute(i, true);
        // no advance: approve; and cancel
        h.createInvoice(0, 1, 7);
        i = h.idsLength() - 1;
        h.fundInvoice(i);
        h.approveCompletion(i);
        h.createInvoice(1, 2, 8);
        h.cancelInvoice(h.idsLength() - 1);
        // LPs: every direction, including a transfer and a round trip
        h.lpDeposit(0, 2);
        h.lpTransfer(1, 0, 9);
        h.lpRedeem(0, 1);
        h.lpWithdraw(1, 0);
        h.lpRoundTrip(2, 3);
        // boundary probes: invoices sized at the vault's current limit (some accepted, some refused)
        h.boundaryAdvance(0, 0, 1);
        h.boundaryAdvance(1, 1, 2);
        h.boundaryAdvance(2, 2, 3);
        h.boundaryAdvance(0, 1, 0);
        // environment
        h.donate(0, 2, true);
        h.donate(1, 3, false);
        h.clawback(0, 5);
        h.toggleTokenPause(0); // pauses the token (seed % 4 == 0)
        h.claim(3, 1);
        h.toggleTokenPause(0); // lifts it
        h.toggleBlacklist(12);
        h.pauseOps(0, 0);
        h.pauseOps(2, 1);
        h.pauseOps(1, 1);
        h.pauseOps(3, 1);
        h.unauthorized(0, 3, 0);
        h.unauthorized(4, 5, 1);
        h.duplicates(0, 0);
        h.duplicates(0, 3);
        h.duplicates(0, 5);

        assertEq(h.violation(), "", h.violation());
        assertGt(_ok(h, "createInvoice"), 3);
        assertGt(_ok(h, "fundInvoice"), 3);
        assertGe(_ok(h, "approveAdvance"), 3);
        assertEq(_ok(h, "approveCompletion"), 2);
        assertEq(_ok(h, "raiseDispute"), 2);
        assertEq(_ok(h, "resolveRelease"), 1);
        assertEq(_ok(h, "resolveRefund"), 1);
        assertGt(_ok(h, "claim"), 1);
        assertGt(_ok(h, "lpDeposit"), 0);
        assertGt(_ok(h, "lpRedeem"), 0);
        assertGt(_ok(h, "lpWithdraw"), 0);
        assertGt(_ok(h, "lpTransfer"), 0);
        assertGt(_ok(h, "pause") + _ok(h, "pauseAdvances") + _ok(h, "unpause"), 0);
        assertGt(
            _no(h, "unauthorized") + _no(h, "dup.approveAdvance") + _no(h, "dup.recordRepayment"), 0
        );
        assertGe(h.nAdvanced(), 3);
        assertEq(h.nRepaid(), 2);
        assertEq(h.nLost(), 1);
        assertGt(_ok(h, "approveAdvance") + _no(h, "approveAdvance"), 3, "boundary probes ran");
        assertGt(h.ghostFees(), 0);
        assertGt(h.ghostLosses(), 0);
        assertGt(h.ghostCredited(), 0);
        assertGt(h.ghostClaimed(), 0);
    }
}
