// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ITokenHook {
    function tokensToSend(address from, address to, uint256 amount) external;
    function tokensReceived(address from, address to, uint256 amount) external;
}

/// @dev TEST ONLY. 18-decimal ERC-20 with ERC-777-style callbacks: the sender's `tokensToSend` runs
/// before balances move and the recipient's `tokensReceived` after. Contracts that do not implement the
/// hooks are skipped (the call is wrapped in try/catch), so the vault/escrow are not affected.
contract HookToken is ERC20 {
    constructor() ERC20("Hook", "HOOK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && from.code.length > 0) {
            try ITokenHook(from).tokensToSend(from, to, value) {} catch {}
        }
        super._update(from, to, value);
        if (to != address(0) && to.code.length > 0) {
            try ITokenHook(to).tokensReceived(from, to, value) {} catch {}
        }
    }
}
