// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DuelyVault} from "../src/DuelyVault.sol";
import {IDuelyVault} from "../src/IDuelyVault.sol";
import {InvoiceAdvanceV2} from "../src/InvoiceAdvanceV2.sol";
import {IInvoiceAdvanceV2} from "../src/IInvoiceAdvanceV2.sol";
import {RLUSDLikeToken} from "./mocks/RLUSDLikeToken.sol";

/// A5.5 / D4: pull payments. Freelancer remainders and client refunds are credited, reserved in the
/// escrow, and paid only to the designated recipient by the permissionless `claim`.
contract InvoiceAdvanceV2ClaimsTest is Test {
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
    address internal lp = makeAddr("lp");
    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        rlusd = new RLUSDLikeToken();
        vault = new DuelyVault(IERC20(address(rlusd)), admin, operator, pauser);
        escrow = new InvoiceAdvanceV2(
            IERC20(address(rlusd)), IDuelyVault(address(vault)), admin, operator, evaluator
        );
        vm.prank(admin);
        vault.setEscrow(address(escrow));
        rlusd.mint(lp, 8000 * E18);
        vm.startPrank(lp);
        rlusd.approve(address(vault), type(uint256).max);
        vault.deposit(8000 * E18, lp);
        vm.stopPrank();
        _fundWallet(client, 100_000 * E18);
    }

    // ------------------------------------------------------------------ helpers

    function _fundWallet(address who, uint256 amount) internal {
        rlusd.mint(who, amount);
        vm.prank(who);
        rlusd.approve(address(escrow), type(uint256).max);
    }

    function _funded(address who, address to, uint256 amount) internal returns (uint256 id) {
        vm.prank(who);
        id = escrow.createInvoice(to, amount, META);
        vm.prank(who);
        escrow.fundInvoice(id);
    }

    function _advance(uint256 id) internal {
        vm.prank(evaluator);
        escrow.approveAdvance(id, EVAL);
    }

    function _approve(address who, uint256 id) internal {
        vm.prank(who);
        escrow.approveCompletion(id);
    }

    function _refund(address who, uint256 id) internal {
        vm.prank(who);
        escrow.raiseDispute(id);
        vm.prank(operator);
        escrow.resolveDispute(id, false);
    }

    /// @dev The escrow reserves exactly what it owes: unsettled escrow + unclaimed credits.
    function _assertReserved() internal view {
        assertEq(
            rlusd.balanceOf(address(escrow)),
            escrow.totalEscrow() + escrow.totalClaimable(),
            "balance == escrowed + credited"
        );
        assertEq(rlusd.allowance(address(escrow), address(vault)), 0, "no standing allowance");
    }

    // ------------------------------------------------------------------ crediting

    function test_settlement_creditsInsteadOfPaying_andReservesTheTokens() public {
        uint256 id = _funded(client, freelancer, 1000 * E18);
        _advance(id);
        _assertReserved();
        _approve(client, id);

        assertEq(rlusd.balanceOf(freelancer), 900 * E18, "only the advance was paid");
        assertEq(escrow.claimable(freelancer), 70 * E18);
        assertEq(escrow.totalClaimable(), 70 * E18);
        assertEq(escrow.totalEscrow(), 0);
        assertEq(rlusd.balanceOf(address(escrow)), 70 * E18, "reserved in the escrow");
        _assertReserved();
    }

    function test_refund_creditsTheClient_andDoesNotTouchTheFreelancersAdvance() public {
        uint256 id = _funded(client, freelancer, 1000 * E18);
        _advance(id);
        vm.prank(client);
        escrow.raiseDispute(id);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IInvoiceAdvanceV2.ProceedsCredited(id, client, 1000 * E18);
        vm.prank(operator);
        escrow.resolveDispute(id, false);

        assertEq(escrow.claimable(client), 1000 * E18);
        assertEq(escrow.claimable(freelancer), 0);
        assertEq(rlusd.balanceOf(freelancer), 900 * E18, "advance not clawed back");
        _assertReserved();
    }

    function test_noAdvance_fullAmountIsCreditedToTheFreelancer() public {
        uint256 id = _funded(client, freelancer, 1000 * E18);
        _approve(client, id);
        assertEq(escrow.claimable(freelancer), 1000 * E18);
        assertEq(rlusd.balanceOf(freelancer), 0);
        _assertReserved();
    }

    function test_creditsAccumulateAcrossInvoices_oneClaimPaysAll() public {
        uint256 a = _funded(client, freelancer, 1000 * E18);
        uint256 b = _funded(client, freelancer, 500 * E18);
        uint256 c = _funded(client, freelancer, 300 * E18);
        _advance(a);
        _advance(b);
        _approve(client, a); // 70
        _approve(client, b); // 35
        _approve(client, c); // 300, no advance
        assertEq(escrow.claimable(freelancer), 405 * E18);

        uint256 before = rlusd.balanceOf(freelancer);
        uint256 paid = escrow.claim(freelancer);
        assertEq(paid, 405 * E18);
        assertEq(rlusd.balanceOf(freelancer) - before, 405 * E18);
        assertEq(escrow.totalClaimable(), 0);
        _assertReserved();
    }

    function test_oneAddressHoldingBothRoles_isPaidTheSumOnce() public {
        address both = makeAddr("both");
        _fundWallet(both, 5000 * E18);
        uint256 asFreelancer = _funded(client, both, 1000 * E18); // both is the freelancer
        _approve(client, asFreelancer); // credit 1000 to `both`
        uint256 asClient = _funded(both, freelancer, 600 * E18); // both is the client
        _refund(both, asClient); // credit 600 to `both`
        assertEq(escrow.claimable(both), 1600 * E18);

        uint256 before = rlusd.balanceOf(both);
        escrow.claim(both);
        assertEq(rlusd.balanceOf(both) - before, 1600 * E18);
        _assertReserved();
    }

    // ------------------------------------------------------------------ claiming

    function test_claim_isPermissionless_butAlwaysPaysTheRecipient() public {
        uint256 id = _funded(client, freelancer, 1000 * E18);
        _approve(client, id);
        uint256 strangerBefore = rlusd.balanceOf(stranger);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IInvoiceAdvanceV2.ProceedsClaimed(freelancer, stranger, 1000 * E18);
        vm.prank(stranger);
        uint256 paid = escrow.claim(freelancer);

        assertEq(paid, 1000 * E18);
        assertEq(rlusd.balanceOf(freelancer), 1000 * E18, "paid to the recipient");
        assertEq(rlusd.balanceOf(stranger), strangerBefore, "the caller gains nothing");
    }

    function test_claim_cannotBeUsedToTakeSomeoneElsesCredit() public {
        uint256 id = _funded(client, freelancer, 1000 * E18);
        _approve(client, id);
        // The only argument is the recipient; the stranger has no credit of their own to claim.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvanceV2.NothingToClaim.selector, stranger));
        escrow.claim(stranger);
        assertEq(escrow.claimable(freelancer), 1000 * E18, "the freelancer's credit is intact");
    }

    function test_claim_twiceReverts_andNothingToClaimReverts() public {
        uint256 id = _funded(client, freelancer, 1000 * E18);
        _approve(client, id);
        escrow.claim(freelancer);
        vm.expectRevert(
            abi.encodeWithSelector(IInvoiceAdvanceV2.NothingToClaim.selector, freelancer)
        );
        escrow.claim(freelancer);
        vm.expectRevert(abi.encodeWithSelector(IInvoiceAdvanceV2.NothingToClaim.selector, client));
        escrow.claim(client);
        vm.expectRevert(
            abi.encodeWithSelector(IInvoiceAdvanceV2.NothingToClaim.selector, address(0))
        );
        escrow.claim(address(0));
        assertEq(rlusd.balanceOf(freelancer), 1000 * E18, "paid exactly once");
    }

    function test_failedClaim_keepsTheCredit_issuerPause() public {
        uint256 id = _funded(client, freelancer, 1000 * E18);
        _approve(client, id);
        rlusd.pause();
        vm.expectRevert();
        escrow.claim(freelancer);
        assertEq(escrow.claimable(freelancer), 1000 * E18, "credit intact after a failed transfer");
        assertEq(escrow.totalClaimable(), 1000 * E18);
        _assertReserved();
        rlusd.unpause();
        escrow.claim(freelancer);
        assertEq(rlusd.balanceOf(freelancer), 1000 * E18);
    }

    function test_settlementAndRulingSucceedWhileTheIssuerPauseBlocksClaims_exceptTheVaultRepayment()
        public
    {
        uint256 plain = _funded(client, freelancer, 1000 * E18); // no advance: no token movement at all
        uint256 disputed = _funded(client, freelancer, 1000 * E18);
        rlusd.pause();
        _approve(client, plain); // succeeds: nothing to transfer
        _refund(client, disputed); // succeeds: credit only
        assertEq(escrow.claimable(freelancer), 1000 * E18);
        assertEq(escrow.claimable(client), 1000 * E18);
        vm.expectRevert();
        escrow.claim(freelancer);
        vm.expectRevert();
        escrow.claim(client);
        rlusd.unpause();
        escrow.claim(freelancer);
        escrow.claim(client);
        _assertReserved();
    }

    function test_claim_isIndependentOfTheVault() public {
        uint256 id = _funded(client, freelancer, 1000 * E18);
        _advance(id);
        _approve(client, id);
        vm.startPrank(operator);
        vault.pause();
        vault.pauseAdvances();
        vm.stopPrank();
        bytes32 vaultState = keccak256(
            abi.encode(vault.totalAssets(), vault.outstandingPrincipal(), vault.totalSupply())
        );
        escrow.claim(freelancer);
        assertEq(
            vaultState,
            keccak256(
                abi.encode(vault.totalAssets(), vault.outstandingPrincipal(), vault.totalSupply())
            )
        );
        assertEq(rlusd.balanceOf(freelancer), 970 * E18);
    }

    // ------------------------------------------------------------------ solvency / invariants

    function test_reservedBalanceHoldsAtEveryStepOfAMixedSequence() public {
        uint256[4] memory ids;
        ids[0] = _funded(client, freelancer, 1000 * E18);
        _assertReserved();
        ids[1] = _funded(client, freelancer, 700 * E18);
        _advance(ids[0]);
        _advance(ids[1]);
        _assertReserved();
        _approve(client, ids[0]);
        _assertReserved();
        _refund(client, ids[1]);
        _assertReserved();
        ids[2] = _funded(client, freelancer, 250 * E18);
        _assertReserved();
        _approve(client, ids[2]);
        _assertReserved();
        escrow.claim(client);
        _assertReserved();
        escrow.claim(freelancer);
        _assertReserved();
        assertEq(rlusd.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalClaimable(), 0);
    }

    function test_donationsToTheEscrowAreNeverClaimable() public {
        uint256 id = _funded(client, freelancer, 1000 * E18);
        _approve(client, id);
        rlusd.mint(address(escrow), 123 * E18); // stray transfer
        assertEq(escrow.claim(freelancer), 1000 * E18, "pays the credit, not the balance");
        assertEq(rlusd.balanceOf(address(escrow)), 123 * E18, "stray tokens stay (no sweep)");
        vm.expectRevert();
        escrow.claim(stranger);
    }

    function testFuzz_claimsPayExactlyWhatWasCredited(
        uint96 a1,
        uint96 a2,
        uint96 a3,
        uint8 outcomes
    ) public {
        uint256[3] memory amounts = [
            bound(uint256(a1), 1, 1000 * E18),
            bound(uint256(a2), 1, 1000 * E18),
            bound(uint256(a3), 1, 1000 * E18)
        ];
        uint256 supply = rlusd.totalSupply();
        uint256 expectFreelancer;
        uint256 expectClient;
        for (uint256 i; i < 3; i++) {
            uint256 id = _funded(client, freelancer, amounts[i]);
            (uint256 adv, uint256 fee,,) = escrow.quoteAdvance(amounts[i]);
            bool advanced = (outcomes >> (i * 2)) & 1 == 1 && adv > 0;
            if (advanced) _advance(id);
            bool refund = (outcomes >> (i * 2 + 1)) & 1 == 1;
            if (refund) {
                _refund(client, id);
                expectClient += amounts[i];
            } else {
                _approve(client, id);
                expectFreelancer += amounts[i] - (advanced ? adv + fee : 0);
            }
            _assertReserved();
        }
        assertEq(escrow.claimable(freelancer), expectFreelancer);
        assertEq(escrow.claimable(client), expectClient);
        assertEq(escrow.totalClaimable(), expectFreelancer + expectClient);
        if (expectFreelancer > 0) escrow.claim(freelancer);
        if (expectClient > 0) escrow.claim(client);
        assertEq(escrow.totalClaimable(), 0);
        assertEq(rlusd.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalEscrow(), 0);
        assertEq(rlusd.totalSupply(), supply);
    }
}
