// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockUSDC
/// @notice Six-decimal DEMO token for the Duely testnet MVP. Not real USDC, not RLUSD, no value.
contract MockUSDC is ERC20, Ownable {
    constructor(address initialOwner) ERC20("Duely Demo USD", "dUSD") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Owner-only mint for seeding demo client/operator balances.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
