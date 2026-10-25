// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";

/// @notice Test double shaped like the issuer controls of RLUSD: 18 decimals, pausable (transfers
/// and approvals both blocked while paused) and an issuer `clawback` that burns tokens from any
/// holder. Behavioural model only; the real token is a UUPS proxy we do not control.
contract RLUSDLikeToken is ERC20Pausable {
    address public immutable issuer;

    error NotIssuer();

    constructor() ERC20("RLUSD", "RLUSD") {
        issuer = msg.sender;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function pause() external onlyIssuer {
        _pause();
    }

    function unpause() external onlyIssuer {
        _unpause();
    }

    function clawback(address from, uint256 amount) external onlyIssuer {
        _burn(from, amount);
    }

    /// @dev Real RLUSD also blocks approvals while paused.
    function approve(address spender, uint256 value) public override whenNotPaused returns (bool) {
        return super.approve(spender, value);
    }
}
