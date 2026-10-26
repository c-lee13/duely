// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {DuelyVault} from "../src/DuelyVault.sol";
import {IDuelyVault} from "../src/IDuelyVault.sol";
import {InvoiceAdvanceV2} from "../src/InvoiceAdvanceV2.sol";
import {IInvoiceAdvanceV2} from "../src/IInvoiceAdvanceV2.sol";
import {RLUSDLikeToken} from "./mocks/RLUSDLikeToken.sol";
import {BlacklistToken} from "./mocks/BlacklistToken.sol";

/// A5: adversarial review of the V2 financial lifecycle. Tests named `test_KNOWN_*` pin down
/// weaknesses that are documented design limitations (see docs/V2_SECURITY_REVIEW.md); they assert
/// the CURRENT behavior so that any future mitigation shows up as an intentional change.
contract DuelyV2SecurityTest is Test {
    uint256 internal constant E18 = 1e18;
    bytes32 internal constant META = keccak256("agreement");
    bytes32 internal constant EVAL = keccak256("evaluation");

    RLUSDLikeToken internal rlusd;
    DuelyVault internal vault;
    InvoiceAdvanceV2 internal escrow;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal pauser = makeAddr("pauser");
    address internal evaluator = makeAddr("evaluator");
    address internal lp1 = makeAddr("lp1");
    address internal lp2 = makeAddr("lp2");
    address internal lp3 = makeAddr("lp3");
    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal stranger = makeAddr("stranger");

    // ------------------------------------------------------------------ fixture

    function setUp() public {
        rlusd = new RLUSDLikeToken();
        (vault, escrow) = _deploy(IERC20(address(rlusd)));
        _lp(lp1, 3000 * E18);
        _lp(lp2, 1000 * E18);
        _lp(lp3, 8000 * E18); // NAV 12,000: caps are not the limiting factor in most tests
        rlusd.mint(client, 100_000 * E18);
        vm.prank(client);
        rlusd.approve(address(escrow), type(uint256).max);
    }

    function _deploy(IERC20 token) internal returns (DuelyVault v, InvoiceAdvanceV2 e) {
        v = new DuelyVault(token, admin, operator, pauser);
        e = new InvoiceAdvanceV2(token, IDuelyVault(address(v)), admin, operator, evaluator);
        vm.prank(admin);
        v.setEscrow(address(e));
    }

    function _lp(address who, uint256 amount) internal {
        rlusd.mint(who, amount);
        vm.startPrank(who);
        rlusd.approve(address(vault), type(uint256).max);
        vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _create(address who, address to, uint256 amount) internal returns (uint256 id) {
        vm.prank(who);
        id = escrow.createInvoice(to, amount, META, 10_000);
    }

    function _funded(uint256 amount) internal returns (uint256 id) {
        id = _create(client, freelancer, amount);
        vm.prank(client);
        escrow.fundInvoice(id);
    }

    function _advanced(uint256 amount) internal returns (uint256 id) {
        id = _funded(amount);
        vm.prank(evaluator);
        escrow.approveAdvance(id, EVAL);
    }

    function _disputed(uint256 id) internal {
        vm.prank(client);
        escrow.raiseDispute(id);
    }

    function _lpValue(address lp) internal view returns (uint256) {
        return vault.convertToAssets(vault.balanceOf(lp));
    }

    /// @dev The structural invariants that must hold between any two transactions.
    function _assertConsistent() internal view {
        assertGe(
            rlusd.balanceOf(address(escrow)),
            escrow.totalEscrow() + escrow.totalClaimable(),
            "escrow solvent: balance >= escrowed + credited"
        );
        assertEq(
            vault.totalAssets(), rlusd.balanceOf(address(vault)) + vault.outstandingPrincipal()
        );
        assertEq(rlusd.allowance(address(escrow), address(vault)), 0, "no standing allowance");
        assertLe(vault.maxRedeem(lp1), vault.balanceOf(lp1));
    }

    // ================================================================== 1. authorization matrix

    uint256 internal constant ADMIN = 1 << 0;
    uint256 internal constant OPERATOR = 1 << 1;
    uint256 internal constant PAUSER = 1 << 2;
    uint256 internal constant EVALUATOR = 1 << 3;
    uint256 internal constant LP = 1 << 4;
    uint256 internal constant CLIENT = 1 << 5;
    uint256 internal constant FREELANCER = 1 << 6;
    uint256 internal constant STRANGER = 1 << 7;
    uint256 internal constant ESCROW = 1 << 8;

    function _actors() internal view returns (address[9] memory a) {
        a = [admin, operator, pauser, evaluator, lp1, client, freelancer, stranger, address(escrow)];
    }

    /// @dev Calls `data` on `target` as every actor; success must be exactly the allowed set.
    function _matrix(string memory name, address target, bytes memory data, uint256 allowed)
        internal
    {
        address[9] memory actors = _actors();
        for (uint256 i; i < actors.length; i++) {
            uint256 snap = vm.snapshotState();
            vm.prank(actors[i]);
            (bool ok,) = target.call(data);
            bool shouldSucceed = (allowed >> i) & 1 == 1;
            assertEq(
                ok,
                shouldSucceed,
                string.concat(
                    name,
                    shouldSucceed ? ": allowed actor failed" : ": unauthorized actor succeeded"
                )
            );
            vm.revertToState(snap);
        }
    }

    function test_authorizationMatrix() public {
        uint256 inv1 = _funded(1000 * E18); // Funded
        uint256 inv2 = _create(client, freelancer, 500 * E18); // Created
        uint256 inv3 = _advanced(1000 * E18); // Advanced, then Disputed
        _disputed(inv3);
        // The escrow must hold an allowance for a direct recordRepayment as the escrow actor.
        vm.prank(address(escrow));
        rlusd.approve(address(vault), type(uint256).max);
        bytes32 operatorRole = vault.OPERATOR_ROLE();
        bytes32 evaluatorRole = escrow.EVALUATOR_ROLE();

        // --- escrow
        _matrix(
            "approveAdvance",
            address(escrow),
            abi.encodeCall(escrow.approveAdvance, (inv1, EVAL)),
            EVALUATOR
        );
        _matrix(
            "approveCompletion",
            address(escrow),
            abi.encodeCall(escrow.approveCompletion, (inv1)),
            CLIENT
        );
        _matrix(
            "raiseDispute", address(escrow), abi.encodeCall(escrow.raiseDispute, (inv1)), CLIENT
        );
        _matrix(
            "resolveDispute(true)",
            address(escrow),
            abi.encodeCall(escrow.resolveDispute, (inv3, true)),
            OPERATOR
        );
        _matrix(
            "resolveDispute(false)",
            address(escrow),
            abi.encodeCall(escrow.resolveDispute, (inv3, false)),
            OPERATOR
        );
        _matrix("fundInvoice", address(escrow), abi.encodeCall(escrow.fundInvoice, (inv2)), CLIENT);
        _matrix(
            "cancelInvoice", address(escrow), abi.encodeCall(escrow.cancelInvoice, (inv2)), CLIENT
        );

        // --- vault: escrow-only accounting calls (the evaluator, operator and admin are NOT allowed)
        _matrix(
            "fundAdvance",
            address(vault),
            abi.encodeCall(vault.fundAdvance, (50, freelancer, 1000 * E18, 900 * E18, 100 * E18)),
            ESCROW
        );
        _matrix(
            "recordRepayment", address(vault), abi.encodeCall(vault.recordRepayment, (inv3)), ESCROW
        );
        _matrix("finalizeLoss", address(vault), abi.encodeCall(vault.finalizeLoss, (inv3)), ESCROW);
        _matrix(
            "setEscrow (already set)",
            address(vault),
            abi.encodeCall(vault.setEscrow, (address(escrow))),
            0
        );

        // --- pausing: easy for pauser/operator, nobody else
        _matrix("pause", address(vault), abi.encodeCall(vault.pause, ()), PAUSER | OPERATOR);
        _matrix(
            "pauseAdvances",
            address(vault),
            abi.encodeCall(vault.pauseAdvances, ()),
            PAUSER | OPERATOR
        );

        // --- role administration: admin only
        _matrix(
            "vault.grantRole",
            address(vault),
            abi.encodeCall(vault.grantRole, (operatorRole, stranger)),
            ADMIN
        );
        _matrix(
            "vault.revokeRole",
            address(vault),
            abi.encodeCall(vault.revokeRole, (operatorRole, operator)),
            ADMIN
        );
        _matrix(
            "escrow.grantRole",
            address(escrow),
            abi.encodeCall(escrow.grantRole, (evaluatorRole, stranger)),
            ADMIN
        );
        _matrix(
            "escrow.revokeRole",
            address(escrow),
            abi.encodeCall(escrow.revokeRole, (evaluatorRole, evaluator)),
            ADMIN
        );

        // --- unpausing: operator only, and only while paused
        vm.startPrank(operator);
        vault.pause();
        vault.pauseAdvances();
        vm.stopPrank();
        _matrix("unpause", address(vault), abi.encodeCall(vault.unpause, ()), OPERATOR);
        _matrix(
            "unpauseAdvances", address(vault), abi.encodeCall(vault.unpauseAdvances, ()), OPERATOR
        );
    }

    function test_setEscrow_isAdminOnly() public {
        DuelyVault v = new DuelyVault(IERC20(address(rlusd)), admin, operator, pauser);
        InvoiceAdvanceV2 e = new InvoiceAdvanceV2(
            IERC20(address(rlusd)), IDuelyVault(address(v)), admin, operator, evaluator
        );
        address[9] memory actors = _actors();
        for (uint256 i; i < actors.length; i++) {
            uint256 snap = vm.snapshotState();
            vm.prank(actors[i]);
            (bool ok,) = address(v).call(abi.encodeCall(v.setEscrow, (address(e))));
            assertEq(ok, actors[i] == admin, "only the admin can authorize the escrow");
            vm.revertToState(snap);
        }
    }

    function test_noRoleHolderCanMoveFundsDirectly() public {
        _advanced(1000 * E18);
        address[4] memory privileged = [admin, operator, pauser, evaluator];
        uint256 vaultCash = rlusd.balanceOf(address(vault));
        uint256 escrowCash = rlusd.balanceOf(address(escrow));
        for (uint256 i; i < privileged.length; i++) {
            vm.startPrank(privileged[i]);
            // No sweep / rescue / arbitrary-transfer function exists; the only fund-moving calls
            // are the escrow-only vault functions and the role-gated escrow ones.
            vm.expectRevert();
            vault.fundAdvance(60, privileged[i], 1000 * E18, 900 * E18, 100 * E18);
            vm.expectRevert();
            vault.recordRepayment(1);
            vm.expectRevert();
            vault.finalizeLoss(1);
            vm.stopPrank();
        }
        assertEq(rlusd.balanceOf(address(vault)), vaultCash);
        assertEq(rlusd.balanceOf(address(escrow)), escrowCash);
    }

    // ================================================================== 2. pause matrix

    function test_pauseMatrix_whatEachStateAllows() public {
        uint256 forAdvance = _funded(1000 * E18);
        uint256 advancedOk = _advanced(1000 * E18);
        uint256 plain = _funded(1000 * E18);
        uint256 dRefund = _advanced(1000 * E18);
        uint256 dRelease = _advanced(1000 * E18);
        _disputed(dRefund);
        _disputed(dRelease);
        rlusd.mint(lp1, 100 * E18); // wallet balance for the LP probes (deposit/mint)

        for (uint256 s; s < 4; s++) {
            bool full = s & 1 == 1;
            bool advOnly = s & 2 == 2;
            uint256 snap = vm.snapshotState();
            vm.startPrank(operator);
            if (full) vault.pause();
            if (advOnly) vault.pauseAdvances();
            vm.stopPrank();

            // LP flows: blocked only by the full pause.
            assertEq(
                _try(lp1, address(vault), abi.encodeCall(vault.deposit, (1 * E18, lp1))),
                !full,
                "deposit"
            );
            assertEq(
                _try(lp1, address(vault), abi.encodeCall(vault.mint, (1e6, lp1))), !full, "mint"
            );
            assertEq(
                _try(lp1, address(vault), abi.encodeCall(vault.withdraw, (1 * E18, lp1, lp1))),
                !full,
                "withdraw"
            );
            assertEq(
                _try(lp1, address(vault), abi.encodeCall(vault.redeem, (1e6, lp1, lp1))),
                !full,
                "redeem"
            );
            // New advances: blocked by either pause.
            assertEq(
                _try(
                    evaluator,
                    address(escrow),
                    abi.encodeCall(escrow.approveAdvance, (forAdvance, EVAL))
                ),
                !full && !advOnly,
                "approveAdvance"
            );
            // Settlement, release and refund: never blocked.
            assertTrue(
                _try(
                    client, address(escrow), abi.encodeCall(escrow.approveCompletion, (advancedOk))
                ),
                "approve advanced"
            );
            assertTrue(
                _try(client, address(escrow), abi.encodeCall(escrow.approveCompletion, (plain))),
                "approve plain"
            );
            assertTrue(
                _try(
                    operator,
                    address(escrow),
                    abi.encodeCall(escrow.resolveDispute, (dRelease, true))
                ),
                "release"
            );
            assertTrue(
                _try(
                    operator,
                    address(escrow),
                    abi.encodeCall(escrow.resolveDispute, (dRefund, false))
                ),
                "refund"
            );
            assertEq(
                vault.outstandingPrincipal(), (full || advOnly) ? 0 : 900 * E18, "principal after"
            );
            vm.revertToState(snap);
        }
    }

    function _try(address who, address target, bytes memory data) internal returns (bool ok) {
        uint256 snap = vm.snapshotState();
        vm.prank(who);
        (ok,) = target.call(data);
        // Keep state changes of the settlement calls (they are asserted afterwards) but undo LP probes.
        if (target == address(vault)) vm.revertToState(snap);
    }

    function test_pauseDuringDispute_blocksExitsNotResolution() public {
        uint256 id = _advanced(1000 * E18);
        _disputed(id);
        vm.prank(pauser);
        vault.pause();
        uint256 sharesLp1 = vault.balanceOf(lp1);
        vm.prank(lp1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.redeem(sharesLp1, lp1, lp1);

        vm.prank(operator);
        escrow.resolveDispute(id, false); // 900 loss recognized while paused
        assertEq(vault.totalAssets(), 12_000 * E18 - 900 * E18);
        vm.prank(operator);
        vault.unpause();
        assertApproxEqAbs(_lpValue(lp1), 3000 * E18 * 11_100 / 12_000, 3);
        _assertConsistent();
    }

    // ================================================================== 3. malicious / hostile token behavior

    function _blacklistSystem()
        internal
        returns (BlacklistToken t, DuelyVault v, InvoiceAdvanceV2 e)
    {
        t = new BlacklistToken();
        (v, e) = _deploy(IERC20(address(t)));
        t.mint(lp1, 4000 * E18);
        vm.startPrank(lp1);
        t.approve(address(v), type(uint256).max);
        v.deposit(4000 * E18, lp1);
        vm.stopPrank();
        t.mint(client, 10_000 * E18);
        vm.prank(client);
        t.approve(address(e), type(uint256).max);
    }

    function test_blacklistedFreelancer_cannotBeAdvanced_bothFailureStyles() public {
        for (uint256 mode; mode < 2; mode++) {
            (BlacklistToken t, DuelyVault v, InvoiceAdvanceV2 e) = _blacklistSystem();
            t.setReturnFalse(mode == 1);
            vm.prank(client);
            uint256 id = e.createInvoice(freelancer, 1000 * E18, META, 10_000);
            vm.prank(client);
            e.fundInvoice(id);
            t.setBlacklisted(freelancer, true);

            vm.prank(evaluator);
            vm.expectRevert();
            e.approveAdvance(id, EVAL);
            assertEq(uint8(e.getInvoice(id).status), uint8(IInvoiceAdvanceV2.InvoiceStatus.Funded));
            assertEq(v.outstandingPrincipal(), 0, "nothing half-recorded");
            assertEq(uint8(v.getAdvance(id).status), uint8(IDuelyVault.AdvanceStatus.None));
        }
    }

    /// @dev Pull payments (D4): a payee the issuer blacklists can no longer block settlement or force a
    /// loss on the LPs. The vault is repaid; only the payee's own claim waits.
    function test_blacklistedFreelancerAfterAdvance_settlementCompletes_claimWaits() public {
        for (uint256 mode; mode < 2; mode++) {
            (BlacklistToken t, DuelyVault v, InvoiceAdvanceV2 e) = _blacklistSystem();
            t.setReturnFalse(mode == 1);
            vm.prank(client);
            uint256 id = e.createInvoice(freelancer, 1000 * E18, META, 5_000);
            vm.prank(client);
            e.fundInvoice(id);
            vm.prank(evaluator);
            e.approveAdvance(id, EVAL);
            t.setBlacklisted(freelancer, true);

            vm.prank(client);
            e.approveCompletion(id); // no payee transfer happens: settlement cannot be blocked
            assertEq(uint8(v.getAdvance(id).status), uint8(IDuelyVault.AdvanceStatus.Repaid));
            assertEq(v.totalFeesEarned(), 100 * E18);
            assertEq(v.totalRealizedLosses(), 0, "no LP loss from the freelancer's blacklisting");
            assertEq(e.claimable(freelancer), 450 * E18);

            vm.expectRevert();
            e.claim(freelancer);
            assertEq(e.claimable(freelancer), 450 * E18, "a failed claim destroys nothing");
            assertEq(t.balanceOf(address(e)), 450 * E18, "still reserved");

            t.setBlacklisted(freelancer, false);
            e.claim(freelancer);
            assertEq(t.balanceOf(freelancer), 450 * E18 + 450 * E18);
        }
    }

    function test_blacklistedFreelancer_releaseRulingAlsoCompletes() public {
        (BlacklistToken t, DuelyVault v, InvoiceAdvanceV2 e) = _blacklistSystem();
        vm.prank(client);
        uint256 id = e.createInvoice(freelancer, 1000 * E18, META, 10_000);
        vm.prank(client);
        e.fundInvoice(id);
        vm.prank(evaluator);
        e.approveAdvance(id, EVAL);
        vm.prank(client);
        e.raiseDispute(id);
        t.setBlacklisted(freelancer, true);
        vm.prank(operator);
        e.resolveDispute(id, true);
        assertEq(v.totalFeesEarned(), 100 * E18);
        assertEq(e.claimable(freelancer), 0);
    }

    function test_blacklistedClient_refundRulingStillRecordsLoss_claimWaits() public {
        (BlacklistToken t, DuelyVault v, InvoiceAdvanceV2 e) = _blacklistSystem();
        vm.prank(client);
        uint256 id = e.createInvoice(freelancer, 1000 * E18, META, 10_000);
        vm.prank(client);
        e.fundInvoice(id);
        vm.prank(evaluator);
        e.approveAdvance(id, EVAL);
        vm.prank(client);
        e.raiseDispute(id);
        t.setBlacklisted(client, true);

        vm.prank(operator);
        e.resolveDispute(id, false); // the ruling no longer depends on the client's address
        assertEq(v.totalRealizedLosses(), 900 * E18);
        assertEq(uint8(e.getInvoice(id).status), uint8(IInvoiceAdvanceV2.InvoiceStatus.Cancelled));
        assertEq(e.claimable(client), 1000 * E18);

        vm.expectRevert();
        e.claim(client);
        assertEq(e.claimable(client), 1000 * E18, "refund still owed");
        t.setBlacklisted(client, false);
        e.claim(client);
        assertEq(t.balanceOf(client), 10_000 * E18);
    }

    // ------------------------------------------------------------------ issuer clawback

    function test_clawbackFromVault_navTracksRealBalance_lifecycleStillConsistent() public {
        uint256 id = _advanced(1000 * E18); // vault cash 11,100, P 900
        uint256 priceBefore = vault.convertToAssets(1e24);
        rlusd.clawback(address(vault), 500 * E18);
        assertEq(vault.totalAssets(), 11_500 * E18, "NAV fell with the real balance");
        assertLt(vault.convertToAssets(1e24), priceBefore);
        assertLe(vault.maxRedeem(lp1), vault.balanceOf(lp1));
        assertLe(vault.previewRedeem(vault.maxRedeem(lp3)), vault.availableLiquidity());

        vm.prank(client);
        escrow.approveCompletion(id);
        assertEq(vault.totalAssets(), 11_600 * E18);
        assertEq(vault.outstandingPrincipal(), 0);
        _assertConsistent();
    }

    function test_clawbackOfAllVaultCash_leavesOnlyReceivables_noRedemptionsNoCrash() public {
        _advanced(1000 * E18);
        rlusd.clawback(address(vault), rlusd.balanceOf(address(vault)));
        assertEq(vault.totalAssets(), 900 * E18, "only the receivable remains");
        assertEq(vault.maxRedeem(lp1), 0);
        assertEq(vault.maxAdvanceNow(), 0);
        vm.prank(lp1);
        vm.expectRevert();
        vault.redeem(1, lp1, lp1);

        // Settlement still repays and the vault recovers cash.
        vm.prank(client);
        escrow.approveCompletion(1);
        assertEq(vault.totalAssets(), 1000 * E18);
        assertEq(vault.availableLiquidity(), 1000 * E18);
        _assertConsistent();
    }

    function test_clawbackFromEscrow_makesEscrowInsolvent_claimsAndRepaymentsRevertUntilToppedUp()
        public
    {
        uint256 a = _advanced(1000 * E18);
        uint256 b = _advanced(1000 * E18);
        assertEq(rlusd.balanceOf(address(escrow)), 2000 * E18);
        rlusd.clawback(address(escrow), 1500 * E18); // escrow holds 500 against 2,000 of liabilities
        assertLt(rlusd.balanceOf(address(escrow)), escrow.totalEscrow() + escrow.totalClaimable());

        // Settlement needs to repay the vault 1,000: it cannot, and reverts with no partial effect.
        vm.prank(client);
        vm.expectRevert();
        escrow.approveCompletion(a);
        assertEq(uint8(vault.getAdvance(a).status), uint8(IDuelyVault.AdvanceStatus.Open));
        assertEq(escrow.totalClaimable(), 0);

        // The refund ruling needs no tokens: the loss and the client's credit are recorded...
        _disputed(b);
        vm.prank(operator);
        escrow.resolveDispute(b, false);
        assertEq(vault.totalRealizedLosses(), 900 * E18);
        assertEq(escrow.claimable(client), 1000 * E18);
        // ...but the client's claim cannot be paid out of 500, and is intact.
        vm.expectRevert();
        escrow.claim(client);
        assertEq(escrow.claimable(client), 1000 * E18);

        // Topping the escrow up (anyone, or the issuer) restores everything.
        rlusd.mint(address(escrow), 1500 * E18);
        escrow.claim(client);
        vm.prank(client);
        escrow.approveCompletion(a); // 100% slider: nothing left for the freelancer to claim
        assertEq(rlusd.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalEscrow(), 0);
        assertEq(escrow.totalClaimable(), 0);
    }

    function test_issuerPause_freezesTokenMovesWithoutCorruptingState() public {
        uint256 id = _advanced(1000 * E18);
        bytes32 before_ = keccak256(
            abi.encode(
                vault.totalAssets(),
                vault.outstandingPrincipal(),
                escrow.totalEscrow(),
                vault.totalSupply()
            )
        );
        rlusd.pause();
        vm.prank(lp1);
        vm.expectRevert();
        vault.redeem(1e6, lp1, lp1);
        vm.prank(lp1);
        vm.expectRevert();
        vault.deposit(1 * E18, lp1);
        vm.prank(client);
        vm.expectRevert(); // repaying the vault needs a token transfer
        escrow.approveCompletion(id);
        assertEq(
            before_,
            keccak256(
                abi.encode(
                    vault.totalAssets(),
                    vault.outstandingPrincipal(),
                    escrow.totalEscrow(),
                    vault.totalSupply()
                )
            ),
            "reverted calls changed nothing"
        );

        // A refund ruling needs no token movement, so it still lands; the claim waits.
        _disputed(id);
        vm.prank(operator);
        escrow.resolveDispute(id, false);
        assertEq(vault.totalRealizedLosses(), 900 * E18);
        vm.expectRevert();
        escrow.claim(client);
        rlusd.unpause();
        escrow.claim(client);
        _assertConsistent();
    }

    function test_donationDoesNotLetAnAttackerProfit_andVictimDepositStaysFair() public {
        address attacker = makeAddr("attacker");
        rlusd.mint(attacker, 3_000_000 * E18);
        vm.startPrank(attacker);
        rlusd.approve(address(vault), type(uint256).max);
        uint256 start = rlusd.balanceOf(attacker);
        uint256 shares = vault.deposit(1_000_000 * E18, attacker);
        rlusd.transfer(address(vault), 500_000 * E18); // donation to inflate the price
        vm.stopPrank();

        _lp(stranger, 1_000_000 * E18); // victim deposits after the donation
        assertApproxEqRel(_lpValue(stranger), 1_000_000 * E18, 1e9, "victim gets fair value");

        vm.prank(attacker);
        vault.redeem(shares, attacker, attacker);
        assertLt(rlusd.balanceOf(attacker), start, "the donation is a net loss for the attacker");
    }

    function testFuzz_manyTinyCyclesNeverProfit(uint256 seed) public {
        address attacker = makeAddr("attacker");
        rlusd.mint(attacker, 1e24);
        vm.startPrank(attacker);
        rlusd.approve(address(vault), type(uint256).max);
        uint256 start = rlusd.balanceOf(attacker);
        for (uint256 i; i < 25; i++) {
            uint256 a = bound(uint256(keccak256(abi.encode(seed, i))), 1, 1e15);
            uint256 shares = vault.deposit(a, attacker);
            if (i % 3 == 0) rlusd.transfer(address(vault), a % 1000); // dust donation mid-cycle
            vault.redeem(shares, attacker, attacker);
        }
        vm.stopPrank();
        assertLe(rlusd.balanceOf(attacker), start, "rounding never favors the attacker");
    }

    function testFuzz_withdrawNeverUnderchargesShares(uint96 assets) public view {
        uint256 a = bound(uint256(assets), 1, 1000 * E18);
        assertGe(
            vault.previewWithdraw(a), vault.convertToShares(a), "withdraw rounds against the user"
        );
        assertLe(vault.previewRedeem(vault.previewWithdraw(a)), vault.totalAssets());
    }

    function test_afterTotalLoss_attackerCannotCaptureViaTinyDeposit() public {
        // Wipe the vault: one advance per tranche of cap, each lost.
        for (uint256 i; i < 8; i++) {
            uint256 id = _advanced(vault.maxAdvanceNow() * 10 / 9); // the largest the caps allow
            _disputed(id);
            vm.prank(operator);
            escrow.resolveDispute(id, false);
        }
        uint256 navAfter = vault.totalAssets();
        assertLt(navAfter, 12_000 * E18);

        address attacker = makeAddr("attacker");
        rlusd.mint(attacker, 10 * E18);
        vm.startPrank(attacker);
        rlusd.approve(address(vault), type(uint256).max);
        vault.deposit(1, attacker); // 1 wei into a damaged vault
        vm.stopPrank();
        _lp(stranger, 1000 * E18); // an honest depositor right after
        assertApproxEqRel(_lpValue(stranger), 1000 * E18, 1e9);
        assertLe(_lpValue(attacker), 1, "the 1-wei position stays 1 wei");
    }

    // ================================================================== 5. settlement atomicity / solvency

    function test_multiInvoiceSequence_stayConsistentAtEveryStep() public {
        uint256[5] memory ids;
        for (uint256 i; i < 5; i++) {
            ids[i] = i % 2 == 0 ? _advanced((300 + i * 100) * E18) : _funded((300 + i * 100) * E18);
            _assertConsistent();
        }
        vm.prank(client);
        escrow.approveCompletion(ids[0]);
        _assertConsistent();
        _disputed(ids[2]);
        vm.prank(operator);
        escrow.resolveDispute(ids[2], false); // loss
        _assertConsistent();
        _disputed(ids[4]);
        vm.prank(operator);
        escrow.resolveDispute(ids[4], true); // release
        _assertConsistent();
        vm.prank(client);
        escrow.approveCompletion(ids[1]); // no advance
        _disputed(ids[3]);
        vm.prank(operator);
        escrow.resolveDispute(ids[3], false); // no advance, refund
        _assertConsistent();

        assertEq(escrow.totalEscrow(), 0);
        assertEq(rlusd.balanceOf(address(escrow)), escrow.totalClaimable(), "only credits remain");
        escrow.claim(freelancer);
        escrow.claim(client);
        assertEq(rlusd.balanceOf(address(escrow)), 0);
        assertEq(vault.outstandingPrincipal(), 0);
        // fees: ids[0] (300) and ids[4] (700) advanced and repaid; loss: ids[2] (500 -> 450).
        assertEq(vault.totalFeesEarned(), 30 * E18 + 70 * E18);
        assertEq(vault.totalRealizedLosses(), 450 * E18);
        assertEq(vault.totalAssets(), 12_000 * E18 + 100 * E18 - 450 * E18);
    }

    // ================================================================== 6. documented weaknesses (current behavior)

    /// KNOWN (Medium): a depositor who joins just before a repayment captures almost the entire fee
    /// and can leave in the same block, with no exposure to any invoice.
    function test_KNOWN_jitDepositCapturesTheFee() public {
        uint256 id = _advanced(1000 * E18);
        uint256 honestBefore = _lpValue(lp1) + _lpValue(lp2) + _lpValue(lp3);

        address sniper = makeAddr("sniper");
        rlusd.mint(sniper, 10_000_000 * E18);
        vm.startPrank(sniper);
        rlusd.approve(address(vault), type(uint256).max);
        uint256 start = rlusd.balanceOf(sniper);
        uint256 shares = vault.deposit(10_000_000 * E18, sniper);
        vm.stopPrank();

        vm.prank(client);
        escrow.approveCompletion(id); // +30 RLUSD fee realized

        vm.prank(sniper);
        vault.redeem(shares, sniper, sniper);
        uint256 profit = rlusd.balanceOf(sniper) - start;
        uint256 honestAfter = _lpValue(lp1) + _lpValue(lp2) + _lpValue(lp3);
        assertGt(profit, 29 * E18, "sniper took ~all of the 30 fee");
        assertLt(
            honestAfter - honestBefore, 1 * E18, "the LPs who funded the advance got almost nothing"
        );
    }

    /// KNOWN (Medium): while a disputed advance is still carried at par, an informed LP can redeem at par
    /// and leave the whole loss to the LPs who stay.
    function test_KNOWN_informedLpExitsBeforeDisputedLossIsRecognized() public {
        // Make the vault small enough that cash can cover lp1's full exit.
        uint256 lp3Max = vault.maxRedeem(lp3);
        vm.prank(lp3);
        vault.redeem(lp3Max, lp3, lp3); // lp3 leaves with the cash
        uint256 id = _advanced(1000 * E18);
        uint256 lp2Fair = _lpValue(lp2);
        _disputed(id);

        // After the dispute is public, lp1 exits at the unimpaired price.
        uint256 out = vault.maxRedeem(lp1);
        vm.prank(lp1);
        uint256 got = vault.redeem(out, lp1, lp1);
        // D3 caps the exit at cash - P/4 = 3100 - 225 = 2875 of lp1's 3000, but the price is still par.
        assertApproxEqRel(got, 2875 * E18, 1e9, "lp1 exits at par, up to the utilization cap");

        vm.prank(operator);
        escrow.resolveDispute(id, false); // 900 loss
        assertLt(
            _lpValue(lp2), lp2Fair - 100 * E18, "the remaining LP absorbs a disproportionate loss"
        );
    }

    /// NOT a guarantee. The operational mitigation that exists today, in the favorable case only: the pauser freezes LP exits as soon as a dispute
    /// appears, so the loss is shared pro rata. (It cannot beat a transaction already in the same block.)
    function test_pauserCanFreezeExitsOnDispute_soLossIsSharedProRata() public {
        uint256 id = _advanced(1000 * E18);
        _disputed(id);
        vm.prank(pauser);
        vault.pause();
        vm.prank(lp1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.redeem(1e6, lp1, lp1);
        vm.prank(operator);
        escrow.resolveDispute(id, false);
        vm.prank(operator);
        vault.unpause();
        uint256 nav = vault.totalAssets();
        assertApproxEqRel(_lpValue(lp1), nav * 3000 / 12_000, 1e9);
        assertApproxEqRel(_lpValue(lp2), nav * 1000 / 12_000, 1e9);
    }

    /// D3 GUARANTEE: LPs can no longer withdraw past the 80% utilization cap. This says nothing about
    /// per-invoice concentration (see the KNOWN test below).
    function test_withdrawalsCannotPushUtilizationPastTheCap() public {
        _advanced(1000 * E18);
        _advanced(1000 * E18); // P = 1,800
        address[3] memory lps = [lp1, lp2, lp3];
        for (uint256 round; round < 2; round++) {
            for (uint256 i; i < lps.length; i++) {
                uint256 m = vault.maxRedeem(lps[i]);
                if (m > 0) {
                    vm.prank(lps[i]);
                    vault.redeem(m, lps[i], lps[i]);
                }
                assertLe(
                    vault.outstandingPrincipal() * 10_000,
                    8000 * vault.totalAssets(),
                    "<= 80% after every exit"
                );
            }
        }
        assertGt(vault.utilizationBps(), 7990, "LPs withdrew up to the cap, not beyond");
        assertLe(vault.utilizationBps(), 8000);
        assertEq(vault.maxAdvanceNow(), 0);
        // (The per-invoice concentration this does NOT bound is pinned separately in
        // test_KNOWN_perInvoiceConcentrationCanExceed25PercentAfterExits.)
    }

    /// KNOWN (High, trust): the admin can grant itself any role, so admin == every other role.
    function test_KNOWN_adminCanSelfGrantEveryRole() public {
        bytes32 evaluatorRole = escrow.EVALUATOR_ROLE();
        bytes32 operatorRole = escrow.OPERATOR_ROLE();
        bytes32 vOperator = vault.OPERATOR_ROLE();
        vm.startPrank(admin);
        escrow.grantRole(evaluatorRole, admin);
        escrow.grantRole(operatorRole, admin);
        vault.grantRole(vOperator, admin);
        vm.stopPrank();
        uint256 id = _funded(1000 * E18);
        vm.prank(admin);
        escrow.approveAdvance(id, EVAL); // the admin can now advance
        vm.prank(admin);
        vault.pause(); // and pause/unpause
        vm.prank(admin);
        vault.unpause();
        // Mitigation is operational: admin must be a multisig/timelock, distinct from every other role.
    }

    function test_KNOWN_stuckInvoice_hasNoTimeout() public {
        uint256 id = _advanced(1000 * E18);
        vm.warp(block.timestamp + 5 * 365 days);
        bytes32 operatorRole = escrow.OPERATOR_ROLE();

        // Nobody but the client can approve (NotInvoiceClient is the reason, not some unrelated revert).
        address[4] memory others = [operator, evaluator, admin, freelancer];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvanceV2.NotInvoiceClient.selector, id));
            escrow.approveCompletion(id);
        }
        // The operator is the only one who may rule, but only on a DISPUTED invoice: it cannot force one.
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IInvoiceAdvanceV2.InvalidStatus.selector,
                id,
                IInvoiceAdvanceV2.InvoiceStatus.Advanced
            )
        );
        escrow.resolveDispute(id, false);
        // Everyone else is simply not authorized to rule at all.
        address[3] memory nonOperators = [evaluator, admin, freelancer];
        for (uint256 i; i < nonOperators.length; i++) {
            vm.prank(nonOperators[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector,
                    nonOperators[i],
                    operatorRole
                )
            );
            escrow.resolveDispute(id, false);
        }
        assertEq(vault.outstandingPrincipal(), 900 * E18, "principal still locked after five years");
        assertEq(uint8(vault.getAdvance(id).status), uint8(IDuelyVault.AdvanceStatus.Open));
    }

    /// CONDITIONAL, not a guarantee: assumes an honest operator. Economics of a self-dealing client+freelancer pair that fools the evaluator: without the operator's
    /// help it cannot profit (best case -30, abandoning costs -100), but abandoning locks vault capital.
    function test_selfDealingPair_cannotProfitWithoutTheOperator() public {
        address sc = makeAddr("selfClient");
        address sf = makeAddr("selfFreelancer");
        rlusd.mint(sc, 1000 * E18);
        vm.prank(sc);
        rlusd.approve(address(escrow), type(uint256).max);
        uint256 start = rlusd.balanceOf(sc) + rlusd.balanceOf(sf);

        uint256 id = _create(sc, sf, 1000 * E18);
        vm.prank(sc);
        escrow.fundInvoice(id);
        vm.prank(evaluator);
        escrow.approveAdvance(id, EVAL); // evaluator fooled / compromised

        // Abandon: the pair holds 900 against 1,000 locked.
        assertEq(rlusd.balanceOf(sc) + rlusd.balanceOf(sf), start - 100 * E18);
        assertEq(vault.outstandingPrincipal(), 900 * E18, "...and the vault's 900 is locked");

        // Best case if they finish: they pay the 100 fee.
        vm.prank(sc);
        escrow.approveCompletion(id);
        assertEq(rlusd.balanceOf(sc) + rlusd.balanceOf(sf), start - 100 * E18);
        assertEq(vault.totalFeesEarned(), 100 * E18);
    }

    function test_noStandingAllowanceOrEscrowResidueAfterAnyOutcome() public {
        uint256 a = _advanced(1000 * E18);
        uint256 b = _advanced(777 * E18);
        uint256 c = _funded(250 * E18);
        vm.prank(client);
        escrow.approveCompletion(a);
        _assertConsistent();
        _disputed(b);
        vm.prank(operator);
        escrow.resolveDispute(b, true);
        _assertConsistent();
        vm.prank(client);
        escrow.approveCompletion(c);
        _assertConsistent();
        escrow.claim(freelancer);
        assertEq(rlusd.balanceOf(address(escrow)), 0);
        _assertConsistent();
    }

    // ================================================================== A6: further documented limitations
    // Each test below asserts that the RISK EXISTS. If a future change removes the risk, the test fails
    // and must be rewritten as a guarantee on purpose; passing here is never a security property.

    /// KNOWN (S-03 residual): the 80% cap bounds total utilization, not concentration. After LPs exit up
    /// to the cap, a single open 900 advance is far above the 25% per-invoice cap that applied at funding.
    function test_KNOWN_perInvoiceConcentrationCanExceed25PercentAfterExits() public {
        _advanced(1000 * E18);
        _advanced(1000 * E18);
        address[3] memory lps = [lp1, lp2, lp3];
        for (uint256 round; round < 2; round++) {
            for (uint256 i; i < lps.length; i++) {
                uint256 m = vault.maxRedeem(lps[i]);
                if (m > 0) {
                    vm.prank(lps[i]);
                    vault.redeem(m, lps[i], lps[i]);
                }
            }
        }
        uint256 share = 900 * E18 * 10_000 / vault.totalAssets();
        assertGt(share, 2500, "one open advance is now above 25% of NAV");
    }

    /// KNOWN (S-07 residual): repaying the vault needs a working token, so an issuer pause (or a blacklisted
    /// vault) blocks settlement of ADVANCED invoices for as long as it lasts. Only invoices that move no
    /// tokens (no advance) and the refund ruling are unaffected.
    function test_KNOWN_issuerPauseBlocksSettlementOfAdvancedInvoices() public {
        uint256 advanced = _advanced(1000 * E18);
        uint256 plain = _funded(1000 * E18);
        rlusd.pause();
        vm.prank(client);
        vm.expectRevert(); // the vault's pull from the escrow reverts inside the token
        escrow.approveCompletion(advanced);
        vm.prank(client);
        escrow.approveCompletion(plain); // moves no tokens: succeeds
        assertEq(uint8(vault.getAdvance(advanced).status), uint8(IDuelyVault.AdvanceStatus.Open));
        rlusd.unpause();
    }

    /// KNOWN (S-08): after an issuer clawback from the escrow a credit can be left unpayable. The contracts
    /// keep every record intact (nothing is lost), but only a top-up can make the claim succeed.
    function test_KNOWN_clawbackFromEscrowCanLeaveACreditUnpayable() public {
        uint256 id = _funded(1000 * E18);
        vm.prank(client);
        escrow.approveCompletion(id); // credits the freelancer 1000
        rlusd.clawback(address(escrow), 400 * E18);
        assertLt(
            rlusd.balanceOf(address(escrow)),
            escrow.totalClaimable(),
            "insolvent against its credits"
        );
        vm.expectRevert();
        escrow.claim(freelancer);
        assertEq(
            escrow.claimable(freelancer), 1000 * E18, "the record survives, the money does not"
        );
    }

    /// KNOWN (S-02, mirror image): a depositor who joins while an advance is disputed buys shares at the
    /// unimpaired price and then absorbs part of a loss that was already likely.
    function test_KNOWN_depositorDuringADisputeInheritsPartOfTheLoss() public {
        uint256 id = _advanced(1000 * E18);
        _disputed(id);
        address late = makeAddr("lateDepositor");
        rlusd.mint(late, 12_000 * E18);
        vm.startPrank(late);
        rlusd.approve(address(vault), type(uint256).max);
        vault.deposit(12_000 * E18, late);
        vm.stopPrank();
        vm.prank(operator);
        escrow.resolveDispute(id, false); // 900 loss
        // The late depositor owns half the vault and so bears half of the 900, though it joined after the dispute.
        assertLt(_lpValue(late), 12_000 * E18 - 400 * E18);
    }

    /// KNOWN (S-12): a pause can freeze LP exits indefinitely; only the operator can lift it, and nothing in
    /// the contracts limits how long it lasts.
    function test_KNOWN_pauseCanFreezeExitsIndefinitely() public {
        vm.prank(pauser);
        vault.pause();
        vm.warp(block.timestamp + 5 * 365 days);
        assertEq(vault.maxRedeem(lp1), 0);
        vm.prank(lp1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.redeem(1e6, lp1, lp1);
        vm.prank(pauser);
        vm.expectRevert(); // the pauser cannot undo it
        vault.unpause();
    }

    /// KNOWN (S-06): the operator's ruling is unconstrained on-chain. For the same kind of disputed advance it
    /// can award the escrow either way, and a refund ruling books the loss on the LPs.
    function test_KNOWN_operatorRulingIsUnconstrainedOnChain() public {
        uint256 a = _advanced(1000 * E18);
        uint256 b = _advanced(1000 * E18);
        _disputed(a);
        _disputed(b);
        vm.prank(operator);
        escrow.resolveDispute(a, true);
        vm.prank(operator);
        escrow.resolveDispute(b, false);
        assertEq(vault.totalFeesEarned(), 100 * E18);
        assertEq(vault.totalRealizedLosses(), 900 * E18);
    }
}
