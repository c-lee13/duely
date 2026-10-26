// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DuelyVault} from "../src/DuelyVault.sol";
import {IDuelyVault} from "../src/IDuelyVault.sol";
import {InvoiceAdvanceV2} from "../src/InvoiceAdvanceV2.sol";

/// @notice Manual, three-step deployment of Duely V2 on XRPL EVM testnet against the EXISTING RLUSD token.
///
///   1. DeployVaultV2   deploys `DuelyVault` only.
///   2. DeployEscrowV2  deploys `InvoiceAdvanceV2` pointing at `VAULT_ADDRESS`.
///   3. LinkEscrowV2    runs the one-time `DuelyVault.setEscrow(ESCROW_ADDRESS)`.
///
/// Each step is a separate `forge script ...:<Contract>` run. Every step first re-verifies the whole
/// configuration (and the on-chain state left by the previous step), refuses to continue on any mismatch,
/// and verifies the result again before it ends. Run without `--broadcast` it is a pure simulation: it
/// sends nothing.
///
/// Environment (reused from the repo `.env`; no new wallets): CHAIN_ID, DEPLOYER_ADDRESS, ADMIN_ADDRESS,
/// OPERATOR_ADDRESS, EVALUATOR_ADDRESS, TOKEN_ADDRESS (must be the registered testnet RLUSD) and, per step,
/// VAULT_ADDRESS / ESCROW_ADDRESS. Signing: DEPLOYER_PRIVATE_KEY if set (it must derive DEPLOYER_ADDRESS),
/// otherwise the account passed on the command line (`--account duely-deployer`), which must also be
/// DEPLOYER_ADDRESS. The RPC comes from the `xrpl_evm_testnet` alias (XRPL_EVM_RPC_URL) so it never appears
/// on a command line. Roles: the OPERATOR also holds the vault's PAUSER role.
///
/// This file never writes a manifest and never touches `Deploy.s.sol` or any V1 deployment/manifest;
/// forge's own record goes to `broadcast/DeployV2.s.sol/` (separate from V1's `broadcast/Deploy.s.sol/`).
abstract contract DeployV2Base is Script {
    uint256 internal constant XRPL_EVM_TESTNET = 1449000;
    uint256 internal constant XRPL_EVM_MAINNET = 1440000;

    // The registered testnet RLUSD (contracts/deployments/external-tokens.json).
    address internal constant RLUSD = 0x27b57a9D0b8d24EB97259c4E2279e45255e016f3;
    uint8 internal constant RLUSD_DECIMALS = 18;
    string internal constant RLUSD_SYMBOL = "RLUSD";

    // V1 deployments: addresses that must never be used as V2 inputs (and are never written to).
    address internal constant V1_INVOICE_ADVANCE_DUSD = 0x328fc0DbF3d1F704B065192f4bFC7583bfA550E0;
    address internal constant V1_INVOICE_ADVANCE_RLUSD = 0x1B972ec6B1B5E0b592010e7484beF0accC382792;
    address internal constant V1_MOCK_USDC = 0x5ff7b6ae08c37868303e7A815308Af476421506c;

    // Finalized financial parameters (docs/VAULT_IMPLEMENTATION_SPEC.md).
    uint256 internal constant FEE_BPS = 1_000;
    uint256 internal constant ADVANCE_BPS = 9000;
    uint256 internal constant MAX_UTILIZATION_BPS = 8000;
    uint256 internal constant MAX_EXPOSURE_BPS = 2500;
    uint8 internal constant VAULT_DECIMALS_OFFSET = 6;

    /// @dev Native gas the signer must hold (override with MIN_GAS_WEI). Real cost is a small fraction.
    uint256 internal constant DEFAULT_MIN_GAS_WEI = 0.05 ether;

    struct Cfg {
        address deployer;
        address admin;
        address operator;
        address pauser; // == operator
        address evaluator;
        address token;
    }

    // ------------------------------------------------------------------ configuration

    // Configuration comes from the process environment (the repo `.env`). These three readers are virtual
    // only so the local test can supply values from memory: tests run in parallel inside one process, so
    // mutating process-wide environment variables there would race with the V1 deploy-script test.
    function _cfgUint(string memory name, uint256 fallback_)
        internal
        view
        virtual
        returns (uint256)
    {
        return vm.envOr(name, fallback_);
    }

    function _cfgAddress(string memory name) internal view virtual returns (address) {
        return vm.envOr(name, address(0));
    }

    function _cfgString(string memory name) internal view virtual returns (string memory) {
        return vm.envOr(name, string(""));
    }

    function _loadConfig() internal view returns (Cfg memory c) {
        require(block.chainid != XRPL_EVM_MAINNET, "mainnet deployment is out of scope");
        require(
            block.chainid == XRPL_EVM_TESTNET, "unexpected chain: only XRPL EVM testnet (1449000)"
        );
        uint256 declared = _cfgUint("CHAIN_ID", 0);
        require(declared != 0, "CHAIN_ID is unset");
        require(block.chainid == declared, "CHAIN_ID env does not match RPC chain");

        c.deployer = _envAddress("DEPLOYER_ADDRESS");
        c.admin = _envAddress("ADMIN_ADDRESS");
        c.operator = _envAddress("OPERATOR_ADDRESS");
        c.pauser = c.operator;
        c.evaluator = _envAddress("EVALUATOR_ADDRESS");
        c.token = _envAddress("TOKEN_ADDRESS");

        require(c.evaluator != c.operator, "evaluator and operator must be distinct");
        require(c.evaluator != c.admin, "evaluator and admin must be distinct");
        require(c.token == RLUSD, "TOKEN_ADDRESS is not the registered testnet RLUSD");
        require(
            c.token != c.admin && c.token != c.operator && c.token != c.evaluator
                && c.token != c.deployer,
            "TOKEN_ADDRESS must not be a role or deployer address"
        );
        _checkToken(c.token, c.deployer);
        if (c.admin == c.operator) {
            console.log("WARNING: admin == operator (as in the existing testnet config)");
        }
    }

    function _envAddress(string memory name) internal view returns (address a) {
        a = _cfgAddress(name);
        require(
            a != address(0),
            string.concat(
                name,
                " is unset or zero (note: `$VAR` references in .env expand only via Foundry's dotenv; do not `source` .env first)"
            )
        );
    }

    /// @dev RLUSD must have code, report the declared decimals/symbol, answer `balanceOf`/`totalSupply`, and
    /// not be paused right now.
    function _checkToken(address token, address probe) internal view {
        require(token.code.length > 0, "RLUSD has no contract code at TOKEN_ADDRESS");
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        require(
            ok && ret.length == 32 && abi.decode(ret, (uint256)) == RLUSD_DECIMALS,
            "RLUSD decimals != 18"
        );
        (ok, ret) = token.staticcall(abi.encodeWithSignature("symbol()"));
        require(ok && ret.length >= 64, "RLUSD has no symbol()");
        require(
            keccak256(bytes(abi.decode(ret, (string)))) == keccak256(bytes(RLUSD_SYMBOL)),
            "token symbol != RLUSD"
        );
        (ok, ret) = token.staticcall(abi.encodeWithSignature("totalSupply()"));
        require(ok && ret.length == 32 && abi.decode(ret, (uint256)) > 0, "RLUSD has no supply");
        (ok, ret) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (probe)));
        require(ok && ret.length == 32, "token does not implement balanceOf");
        (ok, ret) = token.staticcall(abi.encodeWithSignature("paused()"));
        if (ok && ret.length == 32) require(!abi.decode(ret, (bool)), "RLUSD is paused right now");
    }

    // ------------------------------------------------------------------ signer

    /// @dev Starts broadcasting as `expected`. If DEPLOYER_PRIVATE_KEY is set it is used when it derives
    /// `expected`; with `keyMustMatch` a mismatching key is an error, otherwise the command-line account is
    /// used instead. Either way the final broadcaster must be `expected`.
    function _startBroadcastAs(address expected, string memory role, bool keyMustMatch) internal {
        string memory raw = _cfgString("DEPLOYER_PRIVATE_KEY");
        if (bytes(raw).length > 0) {
            uint256 pk = uint256(vm.parseBytes32(_with0x(raw)));
            if (vm.addr(pk) == expected) {
                vm.startBroadcast(pk);
                return;
            }
            require(!keyMustMatch, string.concat("DEPLOYER_PRIVATE_KEY does not derive ", role));
        }
        vm.startBroadcast();
        (, address caller,) = vm.readCallers();
        require(
            caller == expected,
            string.concat("broadcasting account != ", role, " (use --account / --sender)")
        );
    }

    function _with0x(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length >= 2 && b[0] == "0" && (b[1] == "x" || b[1] == "X")) return s;
        return string.concat("0x", s);
    }

    function _checkGas(address who) internal view {
        uint256 minWei = _cfgUint("MIN_GAS_WEI", DEFAULT_MIN_GAS_WEI);
        require(
            who.balance >= minWei, "signer has too little native gas (set MIN_GAS_WEI to override)"
        );
    }

    // ------------------------------------------------------------------ inputs from earlier steps

    function _notV1(address a, string memory what) internal pure {
        require(
            a != V1_INVOICE_ADVANCE_DUSD && a != V1_INVOICE_ADVANCE_RLUSD && a != V1_MOCK_USDC,
            string.concat(what, " is a V1 address; V2 never reuses or modifies V1")
        );
    }

    function _vaultFromEnv() internal view returns (DuelyVault v) {
        address a = _envAddress("VAULT_ADDRESS");
        _notV1(a, "VAULT_ADDRESS");
        require(a.code.length > 0, "VAULT_ADDRESS has no contract code");
        v = DuelyVault(a);
    }

    function _escrowFromEnv() internal view returns (InvoiceAdvanceV2 e) {
        address a = _envAddress("ESCROW_ADDRESS");
        _notV1(a, "ESCROW_ADDRESS");
        require(a.code.length > 0, "ESCROW_ADDRESS has no contract code");
        e = InvoiceAdvanceV2(a);
    }

    // ------------------------------------------------------------------ verification

    /// @dev Everything knowable about a vault, checked against the configuration. `escrow_` is the address
    /// `vault.escrow()` must currently report (address(0) before linking).
    function _verifyVault(DuelyVault v, Cfg memory c, address escrow_) internal view {
        require(v.asset() == c.token, "vault asset != RLUSD");
        require(
            v.decimals() == RLUSD_DECIMALS + VAULT_DECIMALS_OFFSET, "vault share decimals != 24"
        );
        require(
            keccak256(bytes(v.name())) == keccak256("Duely Vault Share")
                && keccak256(bytes(v.symbol())) == keccak256("dvRLUSD"),
            "vault name/symbol wrong"
        );
        require(v.hasRole(v.DEFAULT_ADMIN_ROLE(), c.admin), "vault: admin role missing");
        require(v.hasRole(v.OPERATOR_ROLE(), c.operator), "vault: operator role missing");
        require(v.hasRole(v.PAUSER_ROLE(), c.pauser), "vault: pauser role missing");
        require(
            !v.hasRole(v.DEFAULT_ADMIN_ROLE(), c.evaluator)
                && !v.hasRole(v.OPERATOR_ROLE(), c.evaluator)
                && !v.hasRole(v.PAUSER_ROLE(), c.evaluator),
            "vault: evaluator must hold no vault role"
        );
        if (c.deployer != c.admin) {
            require(!v.hasRole(v.DEFAULT_ADMIN_ROLE(), c.deployer), "vault: deployer kept admin");
        }
        if (c.deployer != c.operator) {
            require(
                !v.hasRole(v.OPERATOR_ROLE(), c.deployer)
                    && !v.hasRole(v.PAUSER_ROLE(), c.deployer),
                "vault: deployer holds operator/pauser"
            );
        }
        require(v.FEE_BPS() == FEE_BPS, "vault FEE_BPS != 1000");
        require(v.MAX_ADVANCE_BPS() == ADVANCE_BPS, "vault advance cap != 90%");
        require(v.MAX_UTILIZATION_BPS() == MAX_UTILIZATION_BPS, "vault utilization cap != 80%");
        require(v.MAX_INVOICE_EXPOSURE_BPS() == MAX_EXPOSURE_BPS, "vault exposure cap != 25%");
        require(!v.paused() && !v.advancesPaused(), "vault is paused");
        require(v.escrow() == escrow_, "vault escrow != expected");
        require(v.outstandingPrincipal() == 0, "vault has outstanding principal");
    }

    function _verifyEscrow(InvoiceAdvanceV2 e, Cfg memory c, address vault_) internal view {
        require(address(e.paymentToken()) == c.token, "escrow token != RLUSD");
        require(address(e.vault()) == vault_, "escrow vault != VAULT_ADDRESS");
        require(e.FEE_BPS() == FEE_BPS, "escrow FEE_BPS != 1000");
        require(e.ADVANCE_BPS() == ADVANCE_BPS, "escrow ADVANCE_BPS != 9000");
        require(e.hasRole(e.DEFAULT_ADMIN_ROLE(), c.admin), "escrow: admin role missing");
        require(e.hasRole(e.OPERATOR_ROLE(), c.operator), "escrow: operator role missing");
        require(e.hasRole(e.EVALUATOR_ROLE(), c.evaluator), "escrow: evaluator role missing");
        require(!e.hasRole(e.EVALUATOR_ROLE(), c.operator), "escrow: operator holds evaluator role");
        require(
            !e.hasRole(e.OPERATOR_ROLE(), c.evaluator)
                && !e.hasRole(e.DEFAULT_ADMIN_ROLE(), c.evaluator),
            "escrow: evaluator holds operator/admin role"
        );
        if (c.admin != c.operator) {
            require(!e.hasRole(e.OPERATOR_ROLE(), c.admin), "escrow: admin holds operator role");
        }
        require(!e.hasRole(e.EVALUATOR_ROLE(), c.admin), "escrow: admin holds evaluator role");
        if (c.deployer != c.admin) {
            require(!e.hasRole(e.DEFAULT_ADMIN_ROLE(), c.deployer), "escrow: deployer kept admin");
        }
        if (c.deployer != c.operator) {
            require(!e.hasRole(e.OPERATOR_ROLE(), c.deployer), "escrow: deployer holds operator");
        }
        require(!e.hasRole(e.EVALUATOR_ROLE(), c.deployer), "escrow: deployer holds evaluator");
        // vault <-> escrow compatibility
        DuelyVault v = DuelyVault(vault_);
        require(v.asset() == address(e.paymentToken()), "vault/escrow token mismatch");
        require(v.FEE_BPS() == e.FEE_BPS(), "vault/escrow fee mismatch");
        require(v.MAX_ADVANCE_BPS() >= e.ADVANCE_BPS(), "vault cap below escrow advance ratio");
    }

    function _logConfig(Cfg memory c) internal view {
        console.log("chainId        ", block.chainid);
        console.log("deployer       ", c.deployer);
        console.log("deployer gas   ", c.deployer.balance);
        console.log("RLUSD          ", c.token);
        console.log("admin          ", c.admin);
        console.log("operator+pauser", c.operator);
        console.log("evaluator      ", c.evaluator);
    }
}

/// @notice Step 1: deploy `DuelyVault(RLUSD, admin, operator, pauser)` only.
contract DeployVaultV2 is DeployV2Base {
    function run() external returns (DuelyVault vault) {
        Cfg memory c = _loadConfig();
        _checkGas(c.deployer);
        _logConfig(c);

        _startBroadcastAs(c.deployer, "DEPLOYER_ADDRESS", true);
        vault = new DuelyVault(IERC20(c.token), c.admin, c.operator, c.pauser);
        vm.stopBroadcast();

        _verifyVault(vault, c, address(0));
        require(vault.totalSupply() == 0 && vault.totalAssets() == 0, "fresh vault is not empty");
        console.log("DuelyVault     ", address(vault));
        console.log("next: export VAULT_ADDRESS=<the address above>, then run DeployEscrowV2");
    }
}

/// @notice Step 2: deploy `InvoiceAdvanceV2(RLUSD, VAULT_ADDRESS, admin, operator, evaluator)`.
contract DeployEscrowV2 is DeployV2Base {
    function run() external returns (InvoiceAdvanceV2 escrow) {
        Cfg memory c = _loadConfig();
        _checkGas(c.deployer);
        DuelyVault vault = _vaultFromEnv();
        _verifyVault(vault, c, address(0)); // an existing, unlinked, correctly configured vault
        _logConfig(c);
        console.log("DuelyVault     ", address(vault));

        _startBroadcastAs(c.deployer, "DEPLOYER_ADDRESS", true);
        escrow = new InvoiceAdvanceV2(
            IERC20(c.token), IDuelyVault(address(vault)), c.admin, c.operator, c.evaluator
        );
        vm.stopBroadcast();

        _verifyEscrow(escrow, c, address(vault));
        require(escrow.nextInvoiceId() == 1, "fresh escrow has invoices");
        require(
            escrow.totalEscrow() == 0 && escrow.totalClaimable() == 0, "fresh escrow is not empty"
        );
        console.log("InvoiceAdvanceV2", address(escrow));
        console.log(
            "next: export ESCROW_ADDRESS=<the address above>, then run LinkEscrowV2 (as ADMIN)"
        );
    }
}

/// @notice Step 3: the one-time `DuelyVault.setEscrow(ESCROW_ADDRESS)`, sent by the vault's admin. The
/// right can be used exactly once and cannot be undone: every precondition is verified first.
contract LinkEscrowV2 is DeployV2Base {
    function run() external {
        Cfg memory c = _loadConfig();
        _checkGas(c.admin);
        DuelyVault vault = _vaultFromEnv();
        InvoiceAdvanceV2 escrow = _escrowFromEnv();
        require(address(vault) != address(escrow), "VAULT_ADDRESS == ESCROW_ADDRESS");

        _verifyVault(vault, c, address(0)); // still unlinked
        _verifyEscrow(escrow, c, address(vault));
        _logConfig(c);
        console.log("DuelyVault     ", address(vault));
        console.log("InvoiceAdvanceV2", address(escrow));

        _startBroadcastAs(c.admin, "ADMIN_ADDRESS (the vault admin)", false);
        vault.setEscrow(address(escrow));
        vm.stopBroadcast();

        _verifyVault(vault, c, address(escrow)); // linked, nothing else changed
        _verifyEscrow(escrow, c, address(vault));
        console.log("LINKED: vault.escrow() ==", vault.escrow());
    }
}
