// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev TEST ONLY. 18-decimal token with an issuer-style blacklist. A transfer from or to a blacklisted
/// address either reverts (`returnFalse == false`) or returns `false` (`returnFalse == true`),
/// the two failure styles SafeERC20 must handle.
contract BlacklistToken is ERC20 {
    mapping(address => bool) public blacklisted;
    bool public returnFalse;

    constructor() ERC20("Blacklist", "BLK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlacklisted(address who, bool on) external {
        blacklisted[who] = on;
    }

    function setReturnFalse(bool on) external {
        returnFalse = on;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (blacklisted[msg.sender] || blacklisted[to]) return _blocked();
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (blacklisted[from] || blacklisted[to]) return _blocked();
        return super.transferFrom(from, to, value);
    }

    function _blocked() private view returns (bool) {
        if (!returnFalse) revert("blacklisted");
        return false;
    }
}
