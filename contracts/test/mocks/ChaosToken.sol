// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev TEST ONLY. 18-decimal RLUSD-shaped token with every issuer control the invariant suite needs:
/// transfers and approvals block while paused, a per-address blacklist (reverting), and `clawback`.
/// Minting and burning bypass pause/blacklist so the test harness can always fund and the issuer can
/// always claw back. The deployer is the issuer.
contract ChaosToken is ERC20 {
    address public immutable issuer;
    bool public paused;
    mapping(address => bool) public blacklisted;

    error NotIssuer();
    error TokenPaused();
    error Blacklisted(address who);

    constructor() ERC20("Chaos RLUSD", "cRLUSD") {
        issuer = msg.sender;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool on) external onlyIssuer {
        paused = on;
    }

    function setBlacklisted(address who, bool on) external onlyIssuer {
        blacklisted[who] = on;
    }

    function clawback(address from, uint256 amount) external onlyIssuer {
        _burn(from, amount);
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        if (paused) revert TokenPaused();
        return super.approve(spender, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            if (paused) revert TokenPaused();
            if (blacklisted[from]) revert Blacklisted(from);
            if (blacklisted[to]) revert Blacklisted(to);
        }
        super._update(from, to, value);
    }
}
