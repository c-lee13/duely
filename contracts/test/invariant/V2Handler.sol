// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DuelyVault} from "../../src/DuelyVault.sol";
import {IDuelyVault} from "../../src/IDuelyVault.sol";
import {InvoiceAdvanceV2} from "../../src/InvoiceAdvanceV2.sol";
import {ChaosToken} from "../mocks/ChaosToken.sol";

/// @dev A6: drives randomized sequences over the whole V2 lifecycle (LPs, invoices, advances, approvals,
/// both dispute outcomes, claims, pauses, donations, issuer pause/blacklist/clawback, hostile callers)
/// while keeping an independent ghost model.
///
/// Every action computes what SHOULD happen from the ghost model and the token state, performs the call
/// with a low-level `call`, and records a violation (never reverts) when the outcome differs. The handler
/// therefore runs under `fail_on_revert = true`: a revert inside it would be a bug in the handler itself.
contract V2Handler is Test {
    uint256 internal constant E18 = 1e18;
    uint256 internal constant OFFSET = 1e6; // ERC-4626 virtual shares (decimals offset 6)

    // ---- system under test
    ChaosToken public token;
    DuelyVault public vault;
    InvoiceAdvanceV2 public escrow;
    bool public immutable allowEscrowClawback;

    address public admin;
    address public operator;
    address public pauser;
    address public evaluator;
    address public stranger;
    address[] public lps;
    address[] public clients;
    address[] public freelancers;

    // ---- ghost invoice model (mirrors the escrow status enum)
    enum S {
        Created,
        Funded,
        Advanced,
        Settled,
        Disputed,
        Cancelled
    }

    struct GI {
        address client;
        address freelancer;
        uint256 amount;
        uint256 principal; // 0 if never advanced
        uint256 fee;
        S state;
    }

    /// @dev Pre-call snapshot for LP actions (a struct keeps the handler functions off the stack limit).
    struct Pre {
        uint256 nav;
        uint256 supply;
        uint256 lpBal;
        uint256 expect;
        bool exp;
    }

    uint256[] public ids;
    mapping(uint256 => GI) public gi;
    mapping(address => uint256) public gClaimable;

    // ---- ghost accounting
    uint256 public ghostMinted;
    uint256 public ghostClawed;
    uint256 public ghostCredited;
    uint256 public ghostClaimed;
    uint256 public ghostFees;
    uint256 public ghostLosses;
    uint256 public nAdvanced; // advances ever funded
    uint256 public nRepaid;
    uint256 public nLost;
    bool public gPaused;
    bool public gAdvancesPaused;
    bool public clawedVault;
    bool public clawedEscrow;
    string public violation;

    mapping(bytes32 => uint256) public okCount;
    mapping(bytes32 => uint256) public rejectedCount;

    constructor(bool allowEscrowClawback_) {
        allowEscrowClawback = allowEscrowClawback_;
        admin = makeAddr("admin");
        operator = makeAddr("operator");
        pauser = makeAddr("pauser");
        evaluator = makeAddr("evaluator");
        stranger = makeAddr("stranger");
        for (uint256 i; i < 3; i++) {
            lps.push(makeAddr(string.concat("lp", vm.toString(i))));
            clients.push(makeAddr(string.concat("client", vm.toString(i))));
            freelancers.push(makeAddr(string.concat("freelancer", vm.toString(i))));
        }

        token = new ChaosToken(); // this handler is the issuer
        vault = new DuelyVault(IERC20(address(token)), admin, operator, pauser);
        escrow = new InvoiceAdvanceV2(
            IERC20(address(token)), IDuelyVault(address(vault)), admin, operator, evaluator
        );
        vm.prank(admin);
        vault.setEscrow(address(escrow));

        // Standing approvals (the test token only blocks approvals while paused, and we start unpaused).
        for (uint256 i; i < 3; i++) {
            vm.prank(lps[i]);
            token.approve(address(vault), type(uint256).max);
            vm.prank(clients[i]);
            token.approve(address(escrow), type(uint256).max);
        }
        vm.prank(stranger);
        token.approve(address(vault), type(uint256).max);

        // Seed liquidity so advances are reachable from the first call.
        // Deliberately small (NAV 2,000: 25% cap = 500, 80% cap = 1,600) so the risk limits are reached
        // by a handful of advances instead of being unreachable.
        _ensureBalance(lps[0], 1500 * E18);
        vm.prank(lps[0]);
        vault.deposit(1500 * E18, lps[0]);
        _ensureBalance(lps[1], 500 * E18);
        vm.prank(lps[1]);
        vault.deposit(500 * E18, lps[1]);
    }

    // =====================================================================
    // helpers
    // =====================================================================

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function holders() external view returns (address[] memory h) {
        h = new address[](3 + 3 + 3 + 3);
        for (uint256 i; i < 3; i++) {
            h[i] = lps[i];
            h[3 + i] = clients[i];
            h[6 + i] = freelancers[i];
        }
        h[9] = stranger;
        // vault and escrow are appended by the caller.
    }

    function _fail(string memory what) internal {
        if (bytes(violation).length == 0) violation = what;
    }

    function _count(string memory name, bool ok) internal {
        bytes32 k = keccak256(bytes(name));
        if (ok) okCount[k]++;
        else rejectedCount[k]++;
    }

    function _expect(string memory name, bool ok, bool expected) internal {
        _count(name, ok);
        if (ok != expected) {
            _fail(
                string.concat(
                    name, ok ? ": succeeded but should revert" : ": reverted but should succeed"
                )
            );
        }
    }

    function _call(address who, address target, bytes memory data)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.prank(who);
        (ok, ret) = target.call(data);
    }

    function _amt(uint256 seed, uint256 maxAmt) internal pure returns (uint256) {
        uint256 v = uint256(keccak256(abi.encode(seed)));
        uint256 k = seed % 5;
        if (k == 0) return 1 + v % 100; // dust
        if (k == 1) return 1 + v % 1e12;
        return 1 + v % maxAmt;
    }

    function _ensureBalance(address who, uint256 need) internal {
        uint256 b = token.balanceOf(who);
        if (b < need) {
            token.mint(who, need - b);
            ghostMinted += need - b;
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        uint256 k = seed % 10;
        if (k < 3) return lps[k];
        if (k < 6) return clients[k - 3];
        if (k < 9) return freelancers[k - 6];
        return stranger;
    }

    function _find(uint256 seed, S a, S b) internal view returns (bool found, uint256 id) {
        uint256 n = ids.length;
        if (n == 0) return (false, 0);
        uint256 start = seed % n;
        for (uint256 i; i < n; i++) {
            uint256 x = ids[(start + i) % n];
            S st = gi[x].state;
            if (st == a || st == b) return (true, x);
        }
    }

    function _snap() internal view returns (uint256 nav, uint256 supply) {
        nav = vault.totalAssets();
        supply = vault.totalSupply();
    }

    /// @dev Share price (NAV+1)/(supply+1e6) must not fall. Compared by cross-multiplication, exactly.
    function _priceNotDown(string memory name, uint256 nav0, uint256 s0) internal {
        uint256 nav1 = vault.totalAssets();
        uint256 s1 = vault.totalSupply();
        (uint256 h1, uint256 l1) = Math.mul512(nav1 + 1, s0 + OFFSET); // exact 512-bit compare
        (uint256 h2, uint256 l2) = Math.mul512(nav0 + 1, s1 + OFFSET);
        if (h1 < h2 || (h1 == h2 && l1 < l2)) {
            _fail(string.concat(name, ": share price fell"));
        }
    }

    function _withinCap() internal view returns (bool) {
        return vault.outstandingPrincipal() * 10_000 <= 8000 * vault.totalAssets();
    }

    // =====================================================================
    // LP actions
    // =====================================================================

    function lpDeposit(uint256 lpSeed, uint256 amtSeed) external {
        address lp = lps[lpSeed % 3];
        uint256 amt = _amt(amtSeed, 1500 * E18);
        _ensureBalance(lp, amt);
        bool exp = !vault.paused() && !token.paused() && !token.blacklisted(lp);
        uint256 expectShares = vault.previewDeposit(amt);
        (uint256 nav0, uint256 s0) = _snap();
        uint256 cash0 = token.balanceOf(address(vault));

        (bool ok, bytes memory ret) =
            _call(lp, address(vault), abi.encodeCall(vault.deposit, (amt, lp)));
        _expect("lpDeposit", ok, exp);
        if (ok) {
            if (abi.decode(ret, (uint256)) != expectShares) {
                _fail("lpDeposit: shares != previewDeposit");
            }
            if (token.balanceOf(address(vault)) - cash0 != amt) {
                _fail("lpDeposit: cash delta != assets");
            }
            if (vault.totalSupply() - s0 != expectShares) {
                _fail("lpDeposit: supply delta != shares");
            }
            _priceNotDown("lpDeposit", nav0, s0);
        }
    }

    function lpRedeem(uint256 lpSeed, uint256 seed) external {
        address lp = lps[lpSeed % 3];
        uint256 bal = vault.balanceOf(lp);
        if (bal == 0) return;
        uint256 max = vault.maxRedeem(lp);
        uint256 shares;
        uint256 k = seed % 4;
        if (k == 0 && max > 0) shares = 1 + (seed / 4) % max;
        else if (k == 1 && max > 0) shares = max;
        else if (k == 2) shares = max < bal ? max + 1 : bal; // one past the cap when possible
        else shares = bal;
        if (shares == 0) return;

        Pre memory p;
        p.exp = shares <= max && !token.paused() && !token.blacklisted(lp);
        p.expect = vault.previewRedeem(shares);
        (p.nav, p.supply) = _snap();
        p.lpBal = token.balanceOf(lp);

        (bool ok,) = _call(lp, address(vault), abi.encodeCall(vault.redeem, (shares, lp, lp)));
        _expect("lpRedeem", ok, p.exp);
        if (ok) {
            if (token.balanceOf(lp) - p.lpBal != p.expect) {
                _fail("lpRedeem: paid != previewRedeem");
            }
            if (!_withinCap()) _fail("lpRedeem: utilization above 80% after withdrawal");
            _priceNotDown("lpRedeem", p.nav, p.supply);
        }
    }

    function lpWithdraw(uint256 lpSeed, uint256 seed) external {
        address lp = lps[lpSeed % 3];
        uint256 maxW = vault.maxWithdraw(lp);
        uint256 assets;
        uint256 k = seed % 3;
        if (k == 0 && maxW > 0) assets = 1 + (seed / 4) % maxW;
        else if (k == 1 && maxW > 0) assets = maxW;
        else assets = maxW + 1; // always above the limit

        Pre memory p;
        p.exp = assets <= maxW && !token.paused() && !token.blacklisted(lp);
        p.expect = vault.previewWithdraw(assets);
        (p.nav, p.supply) = _snap();
        p.lpBal = token.balanceOf(lp);

        (bool ok,) = _call(lp, address(vault), abi.encodeCall(vault.withdraw, (assets, lp, lp)));
        _expect("lpWithdraw", ok, p.exp);
        if (ok) {
            if (token.balanceOf(lp) - p.lpBal != assets) _fail("lpWithdraw: paid != requested");
            if (p.supply - vault.totalSupply() != p.expect) {
                _fail("lpWithdraw: burned != previewWithdraw");
            }
            if (!_withinCap()) _fail("lpWithdraw: utilization above 80% after withdrawal");
            _priceNotDown("lpWithdraw", p.nav, p.supply);
        }
    }

    function lpTransfer(uint256 fromSeed, uint256 toSeed, uint256 amtSeed) external {
        address from = lps[fromSeed % 3];
        uint256 bal = vault.balanceOf(from);
        if (bal == 0) return;
        address to = toSeed % 4 == 3 ? stranger : lps[toSeed % 3];
        uint256 amt = 1 + amtSeed % bal;
        (uint256 nav0, uint256 s0) = _snap();
        (bool ok,) = _call(from, address(vault), abi.encodeCall(vault.transfer, (to, amt)));
        _expect("lpTransfer", ok, true);
        _priceNotDown("lpTransfer", nav0, s0);
    }

    /// @dev deposit then immediately redeem the same shares: rounding must never favor the depositor.
    function lpRoundTrip(uint256 lpSeed, uint256 amtSeed) external {
        address lp = lps[lpSeed % 3];
        if (vault.paused() || token.paused() || token.blacklisted(lp)) return;
        uint256 amt = _amt(amtSeed, 1500 * E18);
        _ensureBalance(lp, amt);
        (uint256 nav0, uint256 s0) = _snap();
        uint256 bal0 = token.balanceOf(lp);
        (bool ok, bytes memory ret) =
            _call(lp, address(vault), abi.encodeCall(vault.deposit, (amt, lp)));
        _expect("lpRoundTrip.deposit", ok, true);
        if (!ok) return;
        uint256 shares = abi.decode(ret, (uint256));
        if (shares == 0 || shares > vault.maxRedeem(lp)) {
            _priceNotDown("lpRoundTrip", nav0, s0);
            return;
        }
        (ok,) = _call(lp, address(vault), abi.encodeCall(vault.redeem, (shares, lp, lp)));
        _expect("lpRoundTrip.redeem", ok, true);
        if (ok && token.balanceOf(lp) > bal0) {
            _fail("lpRoundTrip: depositor profited from rounding");
        }
        _priceNotDown("lpRoundTrip", nav0, s0);
    }

    // =====================================================================
    // invoice lifecycle
    // =====================================================================

    function createInvoice(uint256 cSeed, uint256 fSeed, uint256 amtSeed) external {
        _create(clients[cSeed % 3], freelancers[fSeed % 3], _amt(amtSeed, 800 * E18));
    }

    function _create(address c, address f, uint256 amount) internal returns (uint256 id) {
        id = escrow.nextInvoiceId();
        (bool ok,) = _call(
            c,
            address(escrow),
            abi.encodeCall(escrow.createInvoice, (f, amount, keccak256(abi.encode(id)), 10_000))
        );
        _expect("createInvoice", ok, true);
        if (ok) {
            ids.push(id);
            gi[id] = GI(c, f, amount, 0, 0, S.Created);
        }
    }

    function cancelInvoice(uint256 seed) external {
        (bool found, uint256 id) = _find(seed, S.Created, S.Created);
        if (!found) return;
        GI storage g = gi[id];
        (bool ok,) = _call(g.client, address(escrow), abi.encodeCall(escrow.cancelInvoice, (id)));
        _expect("cancelInvoice", ok, true);
        if (ok) g.state = S.Cancelled;
    }

    function fundInvoice(uint256 seed) external {
        (bool found, uint256 id) = _find(seed, S.Created, S.Created);
        if (!found) return;
        _fund(id);
    }

    function _fund(uint256 id) internal {
        GI storage g = gi[id];
        _ensureBalance(g.client, g.amount);
        bool exp = !token.paused() && !token.blacklisted(g.client);
        (uint256 nav0, uint256 s0) = _snap();
        (bool ok,) = _call(g.client, address(escrow), abi.encodeCall(escrow.fundInvoice, (id)));
        _expect("fundInvoice", ok, exp);
        if (ok) g.state = S.Funded;
        _priceNotDown("fundInvoice", nav0, s0);
    }

    /// @dev Creates, funds and tries to advance an invoice whose advance lands within a couple of wei of
    /// the vault's CURRENT limit (`maxAdvanceNow`), so the exact boundary of liquidity, the 25% per-invoice
    /// cap and the 80% utilization cap is probed constantly, including when the utilization headroom is the
    /// binding one. The outcome is checked by `_tryAdvance` exactly like a random advance.
    function boundaryAdvance(uint256 cSeed, uint256 fSeed, uint256 offSeed) external {
        uint256 m = vault.maxAdvanceNow();
        uint256 target = m == 0 ? 1 + offSeed % 3 : m - 1 + offSeed % 4; // within [m-1, m+2]
        uint256 amount = (target * 10 + 8) / 9; // smallest amount whose 90% reaches `target`
        if (amount == 0) amount = 1;
        uint256 id = _create(clients[cSeed % 3], freelancers[fSeed % 3], amount);
        if (gi[id].amount != amount) return; // creation failed (already flagged)
        _fund(id);
        if (gi[id].state == S.Funded) _tryAdvance(id);
    }

    function approveAdvance(uint256 seed) external {
        (bool found, uint256 id) = _find(seed, S.Funded, S.Funded);
        if (!found) return;
        _tryAdvance(id);
    }

    function _tryAdvance(uint256 id) internal {
        GI storage g = gi[id];
        (uint256 adv, uint256 fee,,) = escrow.quoteAdvance(g.amount, 10_000);
        // The vault's own view of what it will accept; the end-state checks below do not trust it.
        bool exp = adv > 0 && vault.maxAdvanceNow() >= adv && !token.paused()
            && !token.blacklisted(g.freelancer);
        (uint256 nav0, uint256 s0) = _snap();
        uint256 p0 = vault.outstandingPrincipal();
        uint256 cash0 = token.balanceOf(address(vault));

        (bool ok,) = _call(
            evaluator,
            address(escrow),
            abi.encodeCall(escrow.approveAdvance, (id, keccak256(abi.encode("eval", id))))
        );
        _expect("approveAdvance", ok, exp);
        if (ok) {
            g.state = S.Advanced;
            g.principal = adv;
            g.fee = fee;
            nAdvanced++;
            if (vault.totalAssets() != nav0) _fail("approveAdvance: NAV changed");
            if (vault.outstandingPrincipal() != p0 + adv) {
                _fail("approveAdvance: principal delta wrong");
            }
            if (cash0 - token.balanceOf(address(vault)) != adv) {
                _fail("approveAdvance: cash delta wrong");
            }
            if (!_withinCap()) _fail("approveAdvance: utilization above 80%");
            IDuelyVault.Advance memory a = vault.getAdvance(id);
            if (
                a.principal != adv || a.fee != fee || a.freelancer != g.freelancer
                    || a.invoiceAmount != g.amount
            ) {
                _fail("approveAdvance: stored advance terms wrong");
            }
        }
        _priceNotDown("approveAdvance", nav0, s0);
    }

    function approveCompletion(uint256 seed) external {
        (bool found, uint256 id) = _find(seed, S.Funded, S.Advanced);
        if (!found) return;
        GI storage g = gi[id];
        bool adv = g.state == S.Advanced;
        (uint256 nav0, uint256 s0) = _snap();
        (bool ok,) =
            _call(g.client, address(escrow), abi.encodeCall(escrow.approveCompletion, (id)));
        if (clawedEscrow) _count("approveCompletion", ok);
        else _expect("approveCompletion", ok, adv ? !token.paused() : true);
        if (ok) _creditSettlement(id, g, adv, nav0);
        _priceNotDown("approveCompletion", nav0, s0);
    }

    function raiseDispute(uint256 seed) external {
        (bool found, uint256 id) = _find(seed, S.Funded, S.Advanced);
        if (!found) return;
        GI storage g = gi[id];
        (bool ok,) = _call(g.client, address(escrow), abi.encodeCall(escrow.raiseDispute, (id)));
        _expect("raiseDispute", ok, true);
        if (ok) g.state = S.Disputed;
    }

    function resolveDispute(uint256 seed, bool release) external {
        (bool found, uint256 id) = _find(seed, S.Disputed, S.Disputed);
        if (!found) return;
        GI storage g = gi[id];
        bool adv = g.principal > 0;
        (uint256 nav0, uint256 s0) = _snap();
        (bool ok,) =
            _call(operator, address(escrow), abi.encodeCall(escrow.resolveDispute, (id, release)));
        if (release) {
            if (clawedEscrow) _count("resolveRelease", ok);
            else _expect("resolveRelease", ok, adv ? !token.paused() : true);
            if (ok) _creditSettlement(id, g, adv, nav0);
            _priceNotDown("resolveRelease", nav0, s0);
        } else {
            _expect("resolveRefund", ok, true);
            if (ok) {
                gClaimable[g.client] += g.amount;
                ghostCredited += g.amount;
                g.state = S.Cancelled;
                if (adv) {
                    ghostLosses += g.principal;
                    nLost++;
                    if (vault.totalAssets() != nav0 - g.principal) {
                        _fail("resolveRefund: NAV did not fall by principal");
                    }
                } else {
                    _priceNotDown("resolveRefund", nav0, s0);
                }
            }
        }
    }

    /// @dev Shared effects of approval and a release ruling.
    function _creditSettlement(uint256 id, GI storage g, bool adv, uint256 nav0) internal {
        uint256 toVault = adv ? g.principal + g.fee : 0;
        uint256 rem = g.amount - toVault;
        gClaimable[g.freelancer] += rem;
        ghostCredited += rem;
        if (adv) {
            ghostFees += g.fee;
            nRepaid++;
        }
        g.state = S.Settled;
        if (vault.totalAssets() != nav0 + (adv ? g.fee : 0)) {
            _fail("settlement: NAV did not rise by exactly the fee");
        }
        id;
    }

    function claim(uint256 whoSeed, uint256 callerSeed) external {
        address who = whoSeed % 2 == 0 ? clients[(whoSeed / 2) % 3] : freelancers[(whoSeed / 2) % 3];
        address caller = _actor(callerSeed);
        uint256 amt = gClaimable[who];
        bool exp = amt > 0 && !token.paused() && !token.blacklisted(who);
        uint256 whoBal = token.balanceOf(who);
        uint256 callerBal = token.balanceOf(caller);
        (bool ok, bytes memory ret) =
            _call(caller, address(escrow), abi.encodeCall(escrow.claim, (who)));
        if (clawedEscrow) _count("claim", ok);
        else _expect("claim", ok, exp);
        if (ok) {
            if (amt == 0) {
                _fail("claim: succeeded with nothing credited");
                return;
            }
            if (abi.decode(ret, (uint256)) != amt) _fail("claim: returned amount != credited");
            if (token.balanceOf(who) - whoBal != amt) {
                _fail("claim: recipient not paid exactly the credit");
            }
            if (caller != who && token.balanceOf(caller) != callerBal) {
                _fail("claim: caller balance changed");
            }
            ghostClaimed += amt;
            gClaimable[who] = 0;
        } else if (escrow.claimable(who) != amt) {
            _fail("claim: failed claim changed the credit");
        }
    }

    // =====================================================================
    // environment / issuer / pauses
    // =====================================================================

    function donate(uint256 donorSeed, uint256 amtSeed, bool toVault) external {
        address donor = _actor(donorSeed);
        uint256 amt = _amt(amtSeed, 300 * E18);
        _ensureBalance(donor, amt);
        bool exp = !token.paused() && !token.blacklisted(donor);
        (uint256 nav0, uint256 s0) = _snap();
        address to = toVault ? address(vault) : address(escrow);
        (bool ok,) = _call(donor, address(token), abi.encodeCall(token.transfer, (to, amt)));
        _expect("donate", ok, exp);
        _priceNotDown("donate", nav0, s0);
    }

    function clawback(uint256 targetSeed, uint256 amtSeed) external {
        uint256 k = targetSeed % (allowEscrowClawback ? 6 : 5);
        address target = k == 0
            ? address(vault)
            : k == 1
                ? lps[targetSeed / 6 % 3]
                : k == 2
                    ? clients[targetSeed / 6 % 3]
                    : k == 3 ? freelancers[targetSeed / 6 % 3] : k == 4 ? stranger : address(escrow);
        uint256 bal = token.balanceOf(target);
        if (bal == 0) return;
        uint256 amt = 1 + uint256(keccak256(abi.encode(amtSeed))) % bal;
        token.clawback(target, amt);
        ghostClawed += amt;
        if (target == address(vault)) clawedVault = true;
        if (target == address(escrow)) clawedEscrow = true;
        _count("clawback", true);
    }

    /// @dev Issuer pauses are rare (1 in 4 calls) and always lifted by the next call, so the lifecycle
    /// actions mostly run against a working token and the pause paths are still exercised.
    function toggleTokenPause(uint256 seed) external {
        if (token.paused()) {
            token.setPaused(false);
            _count("toggleTokenPause", true);
        } else if (seed % 4 == 0) {
            token.setPaused(true);
            _count("toggleTokenPause", true);
        }
    }

    /// @dev Blacklisting is rare and self-healing for the same reason.
    function toggleBlacklist(uint256 seed) external {
        address a = _actor(seed / 4);
        if (token.blacklisted(a)) {
            token.setBlacklisted(a, false);
            _count("toggleBlacklist", true);
        } else if (seed % 4 == 0) {
            token.setBlacklisted(a, true);
            _count("toggleBlacklist", true);
        }
    }

    function pauseOps(uint256 opSeed, uint256 actorSeed) external {
        address[7] memory pool = [pauser, operator, admin, evaluator, stranger, lps[0], clients[0]];
        uint256 op = opSeed % 4;
        // Half the time use the actor who is actually authorized, so the success paths are well covered;
        // the other half uses anyone, so the rejection paths are too.
        address a =
            actorSeed % 2 == 0 ? (op == 0 || op == 2 ? pauser : operator) : pool[actorSeed / 2 % 7];
        bool canPause = a == pauser || a == operator;
        bool ok;
        if (op == 0) {
            (ok,) = _call(a, address(vault), abi.encodeCall(vault.pause, ()));
            _expect("pause", ok, canPause && !gPaused);
            if (ok) gPaused = true;
        } else if (op == 1) {
            (ok,) = _call(a, address(vault), abi.encodeCall(vault.unpause, ()));
            _expect("unpause", ok, a == operator && gPaused);
            if (ok) gPaused = false;
        } else if (op == 2) {
            (ok,) = _call(a, address(vault), abi.encodeCall(vault.pauseAdvances, ()));
            _expect("pauseAdvances", ok, canPause);
            if (ok) gAdvancesPaused = true;
        } else {
            (ok,) = _call(a, address(vault), abi.encodeCall(vault.unpauseAdvances, ()));
            _expect("unpauseAdvances", ok, a == operator);
            if (ok) gAdvancesPaused = false;
        }
    }

    // =====================================================================
    // hostile callers and duplicates (must ALWAYS fail)
    // =====================================================================

    function unauthorized(uint256 fnSeed, uint256 actorSeed, uint256 idSeed) external {
        address[13] memory pool = [
            admin,
            operator,
            pauser,
            evaluator,
            stranger,
            lps[0],
            lps[1],
            lps[2],
            clients[0],
            clients[1],
            freelancers[0],
            freelancers[1],
            address(escrow) // the escrow is allowed on the vault-only calls, so it is filtered below
        ];
        uint256 fn = fnSeed % 11;
        uint256 id = ids.length == 0 ? 1 : ids[idSeed % ids.length];
        // A call that WOULD succeed if it were unguarded: aim at an open advance when one exists.
        if (fn == 1 || fn == 2) id = _openAdvanceId(idSeed, id);
        address a;
        bool found;
        for (uint256 i; i < pool.length; i++) {
            address c = pool[(actorSeed % pool.length + i) % pool.length];
            if (!_hasPrivilege(fn, c, id)) {
                a = c;
                found = true;
                break;
            }
        }
        if (!found) return;

        address target;
        bytes memory data;
        if (fn == 0) {
            // Tiny, otherwise-valid terms (amount 2, principal 1, fee 0): inside every limit, so the
            // caller's missing authorization is the only thing that can stop it.
            target = address(vault);
            data = abi.encodeCall(
                vault.fundAdvance, (type(uint128).max - (idSeed % 1e9), freelancers[0], 2, 1, 0)
            );
        } else if (fn == 1) {
            target = address(vault);
            data = abi.encodeCall(vault.recordRepayment, (id));
        } else if (fn == 2) {
            target = address(vault);
            data = abi.encodeCall(vault.finalizeLoss, (id));
        } else if (fn == 3) {
            target = address(vault);
            data = abi.encodeCall(vault.setEscrow, (address(escrow)));
        } else if (fn == 4) {
            target = address(escrow);
            data = abi.encodeCall(escrow.approveAdvance, (id, keccak256("x")));
        } else if (fn == 5) {
            target = address(escrow);
            data = abi.encodeCall(escrow.resolveDispute, (id, idSeed % 2 == 0));
        } else if (fn == 6) {
            target = address(vault);
            data = abi.encodeCall(vault.pause, ());
        } else if (fn == 7) {
            target = address(vault);
            data = abi.encodeCall(vault.unpause, ());
        } else if (fn == 8) {
            target = idSeed % 2 == 0 ? address(vault) : address(escrow);
            data = abi.encodeCall(vault.grantRole, (vault.OPERATOR_ROLE(), a));
        } else if (fn == 9) {
            target = address(escrow);
            data = abi.encodeCall(escrow.approveCompletion, (id));
        } else {
            target = address(escrow);
            data = idSeed % 3 == 0
                ? abi.encodeCall(escrow.raiseDispute, (id))
                : idSeed % 3 == 1
                    ? abi.encodeCall(escrow.fundInvoice, (id))
                    : abi.encodeCall(escrow.cancelInvoice, (id));
        }
        uint256 supply0 = vault.totalSupply();
        uint256 nav0 = vault.totalAssets();
        (bool ok,) = _call(a, target, data);
        _expect("unauthorized", ok, false);
        if (vault.totalSupply() != supply0 || vault.totalAssets() != nav0) {
            _fail("unauthorized: state changed");
        }
    }

    /// @dev An id whose advance is Open if one exists (else `fallbackId`).
    function _openAdvanceId(uint256 seed, uint256 fallbackId) internal view returns (uint256) {
        uint256 n = ids.length;
        for (uint256 i; i < n; i++) {
            uint256 x = ids[(seed % n + i) % n];
            if (gi[x].principal > 0 && (gi[x].state == S.Advanced || gi[x].state == S.Disputed)) {
                return x;
            }
        }
        return fallbackId;
    }

    /// @dev Whether `who` legitimately holds the privilege needed for `fn` (so we must not test it).
    function _hasPrivilege(uint256 fn, address who, uint256 id) internal view returns (bool) {
        if (fn <= 2) return who == address(escrow);
        if (fn == 3) return false; // nobody: the escrow is already set
        if (fn == 4) return who == evaluator;
        if (fn == 5) return who == operator;
        if (fn == 6) return who == pauser || who == operator;
        if (fn == 7) return who == operator;
        if (fn == 8) return who == admin;
        // 9 and 10: client-only calls
        return gi[id].client == who;
    }

    function duplicates(uint256 idSeed, uint256 kindSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        GI storage g = gi[id];
        IDuelyVault.AdvanceStatus vs = vault.getAdvance(id).status;
        uint256 kind = kindSeed % 7;
        bool ok;
        if (kind == 0 && g.state != S.Funded) {
            (ok,) = _call(
                evaluator,
                address(escrow),
                abi.encodeCall(escrow.approveAdvance, (id, keccak256("dup")))
            );
            _expect("dup.approveAdvance", ok, false);
        } else if (kind == 1 && g.state != S.Funded && g.state != S.Advanced) {
            (ok,) = _call(g.client, address(escrow), abi.encodeCall(escrow.approveCompletion, (id)));
            _expect("dup.approveCompletion", ok, false);
        } else if (kind == 2 && g.state != S.Disputed) {
            (ok,) = _call(
                operator,
                address(escrow),
                abi.encodeCall(escrow.resolveDispute, (id, kindSeed % 2 == 0))
            );
            _expect("dup.resolveDispute", ok, false);
        } else if (kind == 3 && vs != IDuelyVault.AdvanceStatus.Open) {
            // Give the escrow the money and an allowance, so only the advance's status can stop the pull.
            // (Skipped while the issuer pause blocks approvals: the probe would then fail for the wrong reason.)
            if (token.paused()) return;
            _ensureBalance(address(escrow), 10_000 * E18);
            vm.prank(address(escrow));
            token.approve(address(vault), type(uint256).max);
            (ok,) =
                _call(address(escrow), address(vault), abi.encodeCall(vault.recordRepayment, (id)));
            vm.prank(address(escrow));
            token.approve(address(vault), 0);
            _expect("dup.recordRepayment", ok, false);
        } else if (kind == 4 && vs != IDuelyVault.AdvanceStatus.Open) {
            (ok,) = _call(address(escrow), address(vault), abi.encodeCall(vault.finalizeLoss, (id)));
            _expect("dup.finalizeLoss", ok, false);
        } else if (kind == 5 && vs != IDuelyVault.AdvanceStatus.None) {
            (ok,) = _call(
                address(escrow),
                address(vault),
                abi.encodeCall(vault.fundAdvance, (id, freelancers[0], 2, 1, 0))
            );
            _expect("dup.fundAdvance", ok, false);
        } else if (kind == 6 && g.state != S.Created) {
            (ok,) = _call(g.client, address(escrow), abi.encodeCall(escrow.fundInvoice, (id)));
            _expect("dup.fundInvoice", ok, false);
        }
    }
}
