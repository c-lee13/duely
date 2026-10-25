// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceAdvance} from "../src/InvoiceAdvance.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @notice Deploys InvoiceAdvance with one of two payment tokens:
///
///  - MockUSDC path (default): deploys the 6-decimal demo token. The broadcaster (CLI key/account)
///    becomes its owner.
///  - External token path: set PAYMENT_TOKEN_ADDRESS to an existing ERC-20 (for example RLUSD) and
///    state what you expect it to be with PAYMENT_TOKEN_DECIMALS and PAYMENT_TOKEN_SYMBOL. Nothing is
///    minted, no owner or mint right is needed, and no token is deployed. A wrong address, decimals
///    or symbol reverts before anything is broadcast.
///
/// The broadcaster holds no InvoiceAdvance role unless it is also passed as a role address. Only XRPL
/// EVM testnet (1449000) and local anvil (31337) are allowed; mainnet is refused.
contract Deploy is Script {
    uint256 internal constant XRPL_EVM_TESTNET = 1449000;
    uint256 internal constant XRPL_EVM_MAINNET = 1440000;
    uint256 internal constant LOCAL_ANVIL = 31337;
    uint8 internal constant MOCK_DECIMALS = 6;

    function run() external returns (address token, InvoiceAdvance ia) {
        require(block.chainid != XRPL_EVM_MAINNET, "mainnet deployment is out of scope");
        require(
            block.chainid == XRPL_EVM_TESTNET || block.chainid == LOCAL_ANVIL,
            "unsupported chain: expected XRPL EVM testnet (1449000) or local (31337)"
        );
        require(block.chainid == vm.envUint("CHAIN_ID"), "CHAIN_ID env does not match RPC chain");

        address admin = vm.envAddress("ADMIN_ADDRESS");
        address operator = vm.envAddress("OPERATOR_ADDRESS");
        address evaluator = vm.envAddress("EVALUATOR_ADDRESS");
        require(admin != address(0), "ADMIN_ADDRESS is zero");
        require(operator != address(0), "OPERATOR_ADDRESS is zero");
        require(evaluator != address(0), "EVALUATOR_ADDRESS is zero");
        require(evaluator != operator, "evaluator and operator must be distinct");
        require(evaluator != admin, "evaluator and admin must be distinct");

        address existing = vm.envOr("PAYMENT_TOKEN_ADDRESS", address(0));
        bool useExisting = existing != address(0);
        uint8 expectedDecimals = MOCK_DECIMALS;
        if (useExisting) {
            // Validated BEFORE anything is broadcast, so a mistake costs nothing.
            expectedDecimals = _validateExistingToken(existing, admin, operator, evaluator);
        }

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        require(deployer == vm.envAddress("DEPLOYER_ADDRESS"), "broadcaster != DEPLOYER_ADDRESS");

        token = useExisting ? existing : address(new MockUSDC(deployer));
        ia = new InvoiceAdvance(IERC20(token), admin, operator, evaluator);
        vm.stopBroadcast();

        // Post-deploy validation (reads against the simulated/live deployment).
        require(_decimalsOf(token) == expectedDecimals, "token decimals mismatch");
        if (!useExisting) {
            require(MockUSDC(token).owner() == deployer, "token owner mismatch");
        }
        require(address(ia.paymentToken()) == token, "paymentToken mismatch");
        require(ia.hasRole(ia.DEFAULT_ADMIN_ROLE(), admin), "admin role missing");
        require(ia.hasRole(ia.OPERATOR_ROLE(), operator), "operator role missing");
        require(ia.hasRole(ia.EVALUATOR_ROLE(), evaluator), "evaluator role missing");
        require(!ia.hasRole(ia.EVALUATOR_ROLE(), operator), "operator holds evaluator role");
        require(ia.nextInvoiceId() == 1, "unexpected initial nextInvoiceId");

        console.log("chainId        ", block.chainid);
        console.log("deployer       ", deployer);
        console.log(useExisting ? "payment token (existing)" : "MockUSDC (deployed)", token);
        console.log("token decimals ", expectedDecimals);
        console.log("InvoiceAdvance ", address(ia));
        console.log("admin          ", admin);
        console.log("operator       ", operator);
        console.log("evaluator      ", evaluator);
    }

    /// @dev Requires an existing contract that reports the decimals and symbol the operator
    /// declared. Returns the declared decimals.
    function _validateExistingToken(
        address token,
        address admin,
        address operator,
        address evaluator
    ) internal view returns (uint8) {
        require(token.code.length > 0, "PAYMENT_TOKEN_ADDRESS has no contract code");
        require(
            token != admin && token != operator && token != evaluator,
            "PAYMENT_TOKEN_ADDRESS must not be a role address"
        );

        // The operator must state what they expect, so a mistyped address cannot go unnoticed.
        uint256 declaredDecimals = vm.envUint("PAYMENT_TOKEN_DECIMALS");
        require(
            declaredDecimals > 0 && declaredDecimals <= 36, "PAYMENT_TOKEN_DECIMALS out of range"
        );
        string memory declaredSymbol = vm.envString("PAYMENT_TOKEN_SYMBOL");
        require(bytes(declaredSymbol).length > 0, "PAYMENT_TOKEN_SYMBOL is empty");

        require(
            _decimalsOf(token) == declaredDecimals,
            "token reports different decimals than PAYMENT_TOKEN_DECIMALS"
        );
        require(
            keccak256(bytes(_symbolOf(token))) == keccak256(bytes(declaredSymbol)),
            "token reports a different symbol than PAYMENT_TOKEN_SYMBOL"
        );
        // Must at least behave like an ERC-20 for balances.
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (admin)));
        require(ok && ret.length == 32, "token does not implement balanceOf");
        return uint8(declaredDecimals);
    }

    function _decimalsOf(address token) internal view returns (uint8) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok && ret.length == 32, "token has no decimals()");
        uint256 value = abi.decode(ret, (uint256));
        require(value <= type(uint8).max, "token decimals() out of range");
        return uint8(value);
    }

    function _symbolOf(address token) internal view returns (string memory) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("symbol()"));
        require(ok && ret.length >= 64, "token has no symbol()");
        return abi.decode(ret, (string));
    }
}
