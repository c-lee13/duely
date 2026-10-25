// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {InvoiceAdvance} from "../src/InvoiceAdvance.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {RLUSDLikeToken} from "./mocks/RLUSDLikeToken.sol";

/// @notice Deploy.s.sol: the MockUSDC path is unchanged, and an existing ERC-20 (RLUSD) can be used
/// without minting, owner rights, or deploying a token.
contract DeployScriptTest is Test {
    Deploy script;
    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address evaluator = makeAddr("evaluator");

    function setUp() public {
        script = new Deploy();
    }

    /// @dev Process environment variables are shared by every test in the run, and Foundry runs
    /// tests in parallel. Each scenario below sets the variables it needs, so they run in one test
    /// to keep them from racing each other.
    function test_deployScriptScenarios() public {
        _mockPathDeploysSixDecimalTokenOwnedByDeployer();
        _externalTokenIsUsedAsIsAndNothingIsDeployedForIt();
        _externalTokenWithWrongDecimalsReverts();
        _externalTokenWithWrongSymbolReverts();
        _externalAddressWithoutCodeReverts();
        _externalTokenThatIsNotAnErc20Reverts();
        _externalTokenMustDeclareDecimalsAndSymbol();
        _externalTokenCannotBeARoleAddress();
        _mainnetStillRefused();
        _evaluatorMustStayDistinctOnExternalPath();
    }

    function _resetEnv() internal {
        vm.chainId(31337);
        vm.setEnv("CHAIN_ID", "31337");
        vm.setEnv("ADMIN_ADDRESS", vm.toString(admin));
        vm.setEnv("OPERATOR_ADDRESS", vm.toString(operator));
        vm.setEnv("EVALUATOR_ADDRESS", vm.toString(evaluator));
        vm.setEnv("DEPLOYER_ADDRESS", vm.toString(DEFAULT_SENDER));
        vm.setEnv("PAYMENT_TOKEN_ADDRESS", "");
        vm.setEnv("PAYMENT_TOKEN_DECIMALS", "");
        vm.setEnv("PAYMENT_TOKEN_SYMBOL", "");
    }

    function _external(address token, string memory decimals, string memory symbol) internal {
        vm.setEnv("PAYMENT_TOKEN_ADDRESS", vm.toString(token));
        vm.setEnv("PAYMENT_TOKEN_DECIMALS", decimals);
        vm.setEnv("PAYMENT_TOKEN_SYMBOL", symbol);
    }

    // ---- MockUSDC path (default, unchanged) ----

    function _mockPathDeploysSixDecimalTokenOwnedByDeployer() internal {
        _resetEnv();
        (address token, InvoiceAdvance ia) = script.run();
        assertEq(MockUSDC(token).decimals(), 6);
        assertEq(MockUSDC(token).owner(), DEFAULT_SENDER);
        assertEq(address(ia.paymentToken()), token);
    }

    // ---- external token path ----

    function _externalTokenIsUsedAsIsAndNothingIsDeployedForIt() internal {
        _resetEnv();
        RLUSDLikeToken rlusd = new RLUSDLikeToken();
        _external(address(rlusd), "18", "RLUSD");
        (address token, InvoiceAdvance ia) = script.run();
        assertEq(token, address(rlusd));
        assertEq(address(ia.paymentToken()), address(rlusd));
        assertEq(rlusd.totalSupply(), 0, "nothing minted");
        assertTrue(ia.hasRole(ia.OPERATOR_ROLE(), operator));
        assertTrue(ia.hasRole(ia.EVALUATOR_ROLE(), evaluator));
    }

    function _externalTokenWithWrongDecimalsReverts() internal {
        _resetEnv();
        RLUSDLikeToken rlusd = new RLUSDLikeToken();
        _external(address(rlusd), "6", "RLUSD");
        vm.expectRevert("token reports different decimals than PAYMENT_TOKEN_DECIMALS");
        script.run();
    }

    function _externalTokenWithWrongSymbolReverts() internal {
        _resetEnv();
        RLUSDLikeToken rlusd = new RLUSDLikeToken();
        _external(address(rlusd), "18", "USDC");
        vm.expectRevert("token reports a different symbol than PAYMENT_TOKEN_SYMBOL");
        script.run();
    }

    function _externalAddressWithoutCodeReverts() internal {
        _resetEnv();
        _external(makeAddr("eoa"), "18", "RLUSD");
        vm.expectRevert("PAYMENT_TOKEN_ADDRESS has no contract code");
        script.run();
    }

    function _externalTokenThatIsNotAnErc20Reverts() internal {
        _resetEnv();
        // A contract with code but no decimals(): the deployer script itself.
        _external(address(script), "18", "RLUSD");
        vm.expectRevert("token has no decimals()");
        script.run();
    }

    function _externalTokenMustDeclareDecimalsAndSymbol() internal {
        _resetEnv();
        RLUSDLikeToken rlusd = new RLUSDLikeToken();
        vm.setEnv("PAYMENT_TOKEN_ADDRESS", vm.toString(address(rlusd)));
        vm.expectRevert(); // PAYMENT_TOKEN_DECIMALS is empty
        script.run();
    }

    function _externalTokenCannotBeARoleAddress() internal {
        _resetEnv();
        _external(operator, "18", "RLUSD");
        vm.etch(operator, address(new RLUSDLikeToken()).code);
        vm.expectRevert("PAYMENT_TOKEN_ADDRESS must not be a role address");
        script.run();
    }

    // ---- shared guards still apply ----

    function _mainnetStillRefused() internal {
        _resetEnv();
        vm.chainId(1440000);
        vm.expectRevert("mainnet deployment is out of scope");
        script.run();
    }

    function _evaluatorMustStayDistinctOnExternalPath() internal {
        _resetEnv();
        RLUSDLikeToken rlusd = new RLUSDLikeToken();
        _external(address(rlusd), "18", "RLUSD");
        vm.setEnv("EVALUATOR_ADDRESS", vm.toString(operator));
        vm.expectRevert("evaluator and operator must be distinct");
        script.run();
    }
}
