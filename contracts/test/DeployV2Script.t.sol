// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployVaultV2, DeployEscrowV2, LinkEscrowV2} from "../script/DeployV2.s.sol";
import {DuelyVault} from "../src/DuelyVault.sol";
import {IDuelyVault} from "../src/IDuelyVault.sol";
import {InvoiceAdvanceV2} from "../src/InvoiceAdvanceV2.sol";
import {RLUSDLikeToken} from "./mocks/RLUSDLikeToken.sol";

/// @dev Supplies the scripts' configuration from memory instead of process environment variables. Tests run
/// in parallel in one process, so setting real env vars here would race with DeployScriptTest (V1).
abstract contract MemStore is Test {
    mapping(bytes32 => string) internal store;

    function setConfig(string memory k, string memory v) external {
        store[keccak256(bytes(k))] = v;
    }

    function _memUint(string memory name, uint256 fallback_) internal view returns (uint256) {
        string memory v = store[keccak256(bytes(name))];
        return bytes(v).length == 0 ? fallback_ : vm.parseUint(v);
    }

    function _memAddress(string memory name) internal view returns (address) {
        string memory v = store[keccak256(bytes(name))];
        return bytes(v).length == 0 ? address(0) : vm.parseAddress(v);
    }

    function _memString(string memory name) internal view returns (string memory) {
        return store[keccak256(bytes(name))];
    }
}

contract TestDeployVaultV2 is DeployVaultV2, MemStore {
    function _cfgUint(string memory n, uint256 f) internal view override returns (uint256) {
        return _memUint(n, f);
    }

    function _cfgAddress(string memory n) internal view override returns (address) {
        return _memAddress(n);
    }

    function _cfgString(string memory n) internal view override returns (string memory) {
        return _memString(n);
    }
}

contract TestDeployEscrowV2 is DeployEscrowV2, MemStore {
    function _cfgUint(string memory n, uint256 f) internal view override returns (uint256) {
        return _memUint(n, f);
    }

    function _cfgAddress(string memory n) internal view override returns (address) {
        return _memAddress(n);
    }

    function _cfgString(string memory n) internal view override returns (string memory) {
        return _memString(n);
    }
}

contract TestLinkEscrowV2 is LinkEscrowV2, MemStore {
    function _cfgUint(string memory n, uint256 f) internal view override returns (uint256) {
        return _memUint(n, f);
    }

    function _cfgAddress(string memory n) internal view override returns (address) {
        return _memAddress(n);
    }

    function _cfgString(string memory n) internal view override returns (string memory) {
        return _memString(n);
    }
}

/// @notice DeployV2.s.sol, rehearsed locally with an RLUSD stand-in placed at the real testnet RLUSD address
/// on chain id 1449000. Nothing here touches a network.
contract DeployV2ScriptTest is Test {
    address internal constant RLUSD = 0x27b57a9D0b8d24EB97259c4E2279e45255e016f3;
    uint256 internal constant DEPLOYER_PK =
        0xA11CE5EED0000000000000000000000000000000000000000000000000000001;
    uint256 internal constant OTHER_PK =
        0xB0B5EED00000000000000000000000000000000000000000000000000000002;

    address internal deployer;
    address internal admin;
    address internal operator;
    address internal evaluator = makeAddr("evaluator");

    TestDeployVaultV2 internal s1;
    TestDeployEscrowV2 internal s2;
    TestLinkEscrowV2 internal s3;

    function setUp() public {
        deployer = vm.addr(DEPLOYER_PK);
        s1 = new TestDeployVaultV2();
        s2 = new TestDeployEscrowV2();
        s3 = new TestLinkEscrowV2();
    }

    /// @dev Configuration is held in memory (`MemConfig`), not in process env vars, so this cannot race with other
    /// tests; the scenarios share one test only to keep the shared RLUSD stand-in storage in a known order.
    function test_deployV2Scenarios() public {
        _happyPath_asConfiguredOnTestnet();
        _separateAdminAndOperator_linkNeedsTheAdminSigner();
        _globalGuards();
        _tokenGuards();
        _step2Guards();
        _step3Guards();
    }

    // ------------------------------------------------------------------ fixture helpers

    /// @dev Replaces `vm.setEnv`: the same value goes to all three step scripts.
    function _set(string memory k, string memory v) internal {
        s1.setConfig(k, v);
        s2.setConfig(k, v);
        s3.setConfig(k, v);
    }

    function _rlusd() internal returns (RLUSDLikeToken t) {
        deployCodeTo("RLUSDLikeToken.sol:RLUSDLikeToken", RLUSD);
        t = RLUSDLikeToken(RLUSD);
        t.mint(makeAddr("holder"), 1_000_000e18); // non-zero supply, as on testnet
    }

    /// @dev The existing testnet shape: admin == operator == deployer, a separate evaluator.
    function _env() internal {
        _rlusd();
        _envWith(deployer, deployer, deployer, evaluator, RLUSD, true);
    }

    function _envWith(
        address deployer_,
        address admin_,
        address operator_,
        address evaluator_,
        address token_,
        bool useKey
    ) internal {
        vm.chainId(1449000);
        _set("CHAIN_ID", "1449000");
        _set("DEPLOYER_ADDRESS", vm.toString(deployer_));
        _set("ADMIN_ADDRESS", vm.toString(admin_));
        _set("OPERATOR_ADDRESS", vm.toString(operator_));
        _set("EVALUATOR_ADDRESS", vm.toString(evaluator_));
        _set("TOKEN_ADDRESS", vm.toString(token_));
        _set("DEPLOYER_PRIVATE_KEY", useKey ? vm.toString(bytes32(DEPLOYER_PK)) : "");
        _set("VAULT_ADDRESS", "");
        _set("ESCROW_ADDRESS", "");
        _set("MIN_GAS_WEI", "");
        vm.deal(deployer_, 10 ether);
        vm.deal(admin_, 10 ether);
    }

    function _vault() internal returns (DuelyVault v) {
        v = s1.run();
        _set("VAULT_ADDRESS", vm.toString(address(v)));
    }

    function _escrow() internal returns (InvoiceAdvanceV2 e) {
        e = s2.run();
        _set("ESCROW_ADDRESS", vm.toString(address(e)));
    }

    // ------------------------------------------------------------------ the three steps, end to end

    function _happyPath_asConfiguredOnTestnet() internal {
        _env();
        DuelyVault vault = _vault();
        assertEq(vault.asset(), RLUSD);
        assertEq(vault.escrow(), address(0), "step 1 leaves the vault unlinked");
        assertTrue(vault.hasRole(vault.PAUSER_ROLE(), deployer), "operator holds the pauser role");
        assertTrue(vault.hasRole(vault.OPERATOR_ROLE(), deployer));
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), deployer));
        assertEq(vault.decimals(), 24);

        InvoiceAdvanceV2 escrow = _escrow();
        assertEq(address(escrow.vault()), address(vault));
        assertEq(address(escrow.paymentToken()), RLUSD);
        assertEq(vault.escrow(), address(0), "step 2 does not link");
        assertTrue(escrow.hasRole(escrow.EVALUATOR_ROLE(), evaluator));
        assertFalse(escrow.hasRole(escrow.EVALUATOR_ROLE(), deployer));

        s3.run();
        assertEq(vault.escrow(), address(escrow), "step 3 links");

        // The one-time right is spent: running step 3 again is refused before anything is sent.
        vm.expectRevert("vault escrow != expected");
        s3.run();
        // So is deploying another escrow against the now-linked vault.
        vm.expectRevert("vault escrow != expected");
        s2.run();
        // The finished deployment really works: LP deposit, invoice, advance.
        _smoke(vault, escrow);
    }

    function _smoke(DuelyVault vault, InvoiceAdvanceV2 escrow) internal {
        RLUSDLikeToken t = RLUSDLikeToken(RLUSD);
        address lp = makeAddr("lp");
        address client = makeAddr("client");
        address freelancer = makeAddr("freelancer");
        t.mint(lp, 4000e18);
        vm.startPrank(lp);
        t.approve(address(vault), type(uint256).max);
        vault.deposit(4000e18, lp);
        vm.stopPrank();
        t.mint(client, 1000e18);
        vm.startPrank(client);
        t.approve(address(escrow), type(uint256).max);
        uint256 id = escrow.createInvoice(freelancer, 1000e18, keccak256("m"));
        escrow.fundInvoice(id);
        vm.stopPrank();
        vm.prank(evaluator);
        escrow.approveAdvance(id, keccak256("e"));
        assertEq(t.balanceOf(freelancer), 900e18, "the vault paid the advance");
    }

    /// @dev admin != deployer/operator: steps 1 and 2 use the deployer; step 3 must be signed by the admin.
    function _separateAdminAndOperator_linkNeedsTheAdminSigner() internal {
        admin = makeAddr("separateAdmin");
        operator = makeAddr("separateOperator");
        _rlusd();
        _envWith(deployer, admin, operator, evaluator, RLUSD, true);
        DuelyVault vault = _vault();
        assertFalse(
            vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), deployer), "deployer keeps no admin role"
        );
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(vault.hasRole(vault.PAUSER_ROLE(), operator));
        InvoiceAdvanceV2 escrow = _escrow();
        assertFalse(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), deployer));

        // The deployer's key is not the admin: with no admin account on the command line, step 3 refuses.
        vm.expectRevert(
            bytes(
                "broadcasting account != ADMIN_ADDRESS (the vault admin) (use --account / --sender)"
            )
        );
        s3.run();
        _endBroadcast();
        assertEq(vault.escrow(), address(0), "nothing was linked");
    }

    // ------------------------------------------------------------------ guards shared by every step

    function _globalGuards() internal {
        _env();
        vm.chainId(1440000);
        _set("CHAIN_ID", "1440000");
        vm.expectRevert("mainnet deployment is out of scope");
        s1.run();

        vm.chainId(1);
        _set("CHAIN_ID", "1");
        vm.expectRevert("unexpected chain: only XRPL EVM testnet (1449000)");
        s1.run();

        _env();
        _set("CHAIN_ID", "31337"); // env says one thing, RPC another
        vm.expectRevert("CHAIN_ID env does not match RPC chain");
        s1.run();

        _env();
        _set("ADMIN_ADDRESS", "0x0000000000000000000000000000000000000000");
        vm.expectRevert(bytes(_unset("ADMIN_ADDRESS")));
        s1.run();

        _envWith(deployer, deployer, deployer, deployer, RLUSD, true);
        vm.expectRevert("evaluator and operator must be distinct");
        s1.run();
        _envWith(deployer, deployer, makeAddr("op"), deployer, RLUSD, true);
        vm.expectRevert("evaluator and admin must be distinct");
        s1.run();

        // Deployer identity.
        _env();
        _set("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(OTHER_PK)));
        vm.expectRevert("DEPLOYER_PRIVATE_KEY does not derive DEPLOYER_ADDRESS");
        s1.run();
        // (The no-key branch, where the command-line account must be the deployer, is checked by a real
        // `forge script --sender <wrong address>` simulation: inside one test Foundry remembers the previous
        // broadcast signer, which a fresh script process never does.)
        _env();
        _set("DEPLOYER_PRIVATE_KEY", _no0x(vm.toString(bytes32(DEPLOYER_PK)))); // key without 0x is accepted
        s1.run();

        // Native gas.
        _env();
        vm.deal(deployer, 0);
        vm.expectRevert("signer has too little native gas (set MIN_GAS_WEI to override)");
        s1.run();
    }

    /// @dev A script that reverts after `startBroadcast` leaves the cheatcode's broadcast active inside one
    /// test (in a real run the revert aborts the whole script). Clear it between scenarios.
    function _endBroadcast() internal {
        try vm.stopBroadcast() {} catch {}
    }

    function _unset(string memory name) internal pure returns (string memory) {
        return string.concat(
            name,
            " is unset or zero (note: `$VAR` references in .env expand only via Foundry's dotenv; do not `source` .env first)"
        );
    }

    function _no0x(string memory s) internal pure returns (string memory out) {
        bytes memory b = bytes(s);
        bytes memory r = new bytes(b.length - 2);
        for (uint256 i; i < r.length; i++) {
            r[i] = b[i + 2];
        }
        out = string(r);
    }

    // ------------------------------------------------------------------ RLUSD checks

    function _tokenGuards() internal {
        // TOKEN_ADDRESS is not the registered RLUSD (for example the dUSD demo token).
        _env();
        _set("TOKEN_ADDRESS", vm.toString(0x5ff7b6ae08c37868303e7A815308Af476421506c));
        vm.expectRevert("TOKEN_ADDRESS is not the registered testnet RLUSD");
        s1.run();

        // No code at the RLUSD address.
        _env();
        vm.etch(RLUSD, "");
        vm.expectRevert("RLUSD has no contract code at TOKEN_ADDRESS");
        s1.run();

        // Wrong decimals (6) at the RLUSD address.
        _env();
        deployCodeTo("FeeOnTransferToken.sol:FeeOnTransferToken", RLUSD);
        vm.expectRevert("RLUSD decimals != 18");
        s1.run();

        // 18 decimals but the wrong symbol.
        _env();
        deployCodeTo("BlacklistToken.sol:BlacklistToken", RLUSD);
        vm.expectRevert("token symbol != RLUSD");
        s1.run();

        // Paused right now.
        _env();
        RLUSDLikeToken(RLUSD).pause();
        vm.expectRevert("RLUSD is paused right now");
        s1.run();

        // No supply. (deployCodeTo keeps the old storage, so lift the pause and zero ERC20 `_totalSupply`,
        // storage slot 2 in OpenZeppelin 5's ERC20, by hand.)
        RLUSDLikeToken(RLUSD).unpause(); // the previous scenario left it paused (and minting is blocked while paused)
        _env();
        vm.store(RLUSD, bytes32(uint256(2)), bytes32(0));
        assertEq(IERC20(RLUSD).totalSupply(), 0);
        vm.expectRevert("RLUSD has no supply");
        s1.run();
    }

    // ------------------------------------------------------------------ step 2

    function _step2Guards() internal {
        _env();
        vm.expectRevert(bytes(_unset("VAULT_ADDRESS")));
        s2.run();

        _set("VAULT_ADDRESS", vm.toString(0x1B972ec6B1B5E0b592010e7484beF0accC382792)); // V1 RLUSD InvoiceAdvance
        vm.expectRevert("VAULT_ADDRESS is a V1 address; V2 never reuses or modifies V1");
        s2.run();
        _set("VAULT_ADDRESS", vm.toString(0x328fc0DbF3d1F704B065192f4bFC7583bfA550E0)); // V1 dUSD InvoiceAdvance
        vm.expectRevert("VAULT_ADDRESS is a V1 address; V2 never reuses or modifies V1");
        s2.run();

        _set("VAULT_ADDRESS", vm.toString(makeAddr("eoa")));
        vm.expectRevert("VAULT_ADDRESS has no contract code");
        s2.run();

        // A vault for a different token.
        RLUSDLikeToken other = new RLUSDLikeToken();
        DuelyVault wrongToken = new DuelyVault(IERC20(address(other)), deployer, deployer, deployer);
        _set("VAULT_ADDRESS", vm.toString(address(wrongToken)));
        vm.expectRevert("vault asset != RLUSD");
        s2.run();

        // A vault whose roles differ from the configuration.
        DuelyVault wrongRoles = new DuelyVault(
            IERC20(RLUSD), deployer, makeAddr("someoneElse"), makeAddr("someoneElse")
        );
        _set("VAULT_ADDRESS", vm.toString(address(wrongRoles)));
        vm.expectRevert("vault: operator role missing");
        s2.run();

        // A paused vault.
        DuelyVault paused = new DuelyVault(IERC20(RLUSD), deployer, deployer, deployer);
        vm.prank(deployer);
        paused.pause();
        _set("VAULT_ADDRESS", vm.toString(address(paused)));
        vm.expectRevert("vault is paused");
        s2.run();
    }

    // ------------------------------------------------------------------ step 3

    function _step3Guards() internal {
        _env();
        DuelyVault vault = _vault();
        InvoiceAdvanceV2 escrow = _escrow();

        _set("ESCROW_ADDRESS", "");
        vm.expectRevert(bytes(_unset("ESCROW_ADDRESS")));
        s3.run();

        _set("ESCROW_ADDRESS", vm.toString(address(vault)));
        vm.expectRevert(); // a vault is not an escrow
        s3.run();

        // An escrow wired to a different vault.
        DuelyVault otherVault = new DuelyVault(IERC20(RLUSD), deployer, deployer, deployer);
        InvoiceAdvanceV2 foreign = new InvoiceAdvanceV2(
            IERC20(RLUSD), IDuelyVault(address(otherVault)), deployer, deployer, evaluator
        );
        _set("ESCROW_ADDRESS", vm.toString(address(foreign)));
        vm.expectRevert("escrow vault != VAULT_ADDRESS");
        s3.run();

        // An escrow with the wrong evaluator.
        InvoiceAdvanceV2 wrongEvaluator = new InvoiceAdvanceV2(
            IERC20(RLUSD),
            IDuelyVault(address(vault)),
            deployer,
            deployer,
            makeAddr("notTheEvaluator")
        );
        _set("ESCROW_ADDRESS", vm.toString(address(wrongEvaluator)));
        vm.expectRevert("escrow: evaluator role missing");
        s3.run();

        // An escrow where the operator also got the evaluator role.
        InvoiceAdvanceV2 sameKeys = new InvoiceAdvanceV2(
            IERC20(RLUSD), IDuelyVault(address(vault)), deployer, deployer, evaluator
        );
        bytes32 evaluatorRole = sameKeys.EVALUATOR_ROLE();
        vm.prank(deployer);
        sameKeys.grantRole(evaluatorRole, deployer);
        _set("ESCROW_ADDRESS", vm.toString(address(sameKeys)));
        vm.expectRevert("escrow: operator holds evaluator role");
        s3.run();

        // None of the refusals above linked anything.
        assertEq(vault.escrow(), address(0));
        _set("ESCROW_ADDRESS", vm.toString(address(escrow)));
        s3.run();
        assertEq(vault.escrow(), address(escrow));
    }
}
