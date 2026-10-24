// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceAdvance} from "../src/InvoiceAdvance.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @notice Deploys the demo token and InvoiceAdvance. The broadcaster (CLI key/account) becomes
/// the MockUSDC owner and holds no InvoiceAdvance role unless it is also passed as a role address.
/// Only XRPL EVM testnet (1449000) and local anvil (31337) are allowed; mainnet is refused.
contract Deploy is Script {
    uint256 internal constant XRPL_EVM_TESTNET = 1449000;
    uint256 internal constant XRPL_EVM_MAINNET = 1440000;
    uint256 internal constant LOCAL_ANVIL = 31337;

    function run() external returns (MockUSDC token, InvoiceAdvance ia) {
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

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        require(deployer == vm.envAddress("DEPLOYER_ADDRESS"), "broadcaster != DEPLOYER_ADDRESS");

        token = new MockUSDC(deployer);
        ia = new InvoiceAdvance(IERC20(address(token)), admin, operator, evaluator);
        vm.stopBroadcast();

        // Post-deploy validation (reads against the simulated/live deployment).
        require(token.decimals() == 6, "token decimals != 6");
        require(token.owner() == deployer, "token owner mismatch");
        require(address(ia.paymentToken()) == address(token), "paymentToken mismatch");
        require(ia.hasRole(ia.DEFAULT_ADMIN_ROLE(), admin), "admin role missing");
        require(ia.hasRole(ia.OPERATOR_ROLE(), operator), "operator role missing");
        require(ia.hasRole(ia.EVALUATOR_ROLE(), evaluator), "evaluator role missing");
        require(!ia.hasRole(ia.EVALUATOR_ROLE(), operator), "operator holds evaluator role");
        require(ia.nextInvoiceId() == 1, "unexpected initial nextInvoiceId");

        console.log("chainId        ", block.chainid);
        console.log("deployer       ", deployer);
        console.log("MockUSDC       ", address(token));
        console.log("InvoiceAdvance ", address(ia));
        console.log("admin          ", admin);
        console.log("operator       ", operator);
        console.log("evaluator      ", evaluator);
    }
}
