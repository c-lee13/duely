// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDuelyVault} from "../../src/IDuelyVault.sol";
import {ITokenHook} from "./HookToken.sol";

/// @dev TEST ONLY. Acts as an LP / client / freelancer. When HookToken calls its hook it fires one
/// armed call and records whether it succeeded, the revert data, and the vault's NAV and share
/// price as seen from inside the transfer (to check for transient inconsistent state).
contract HookAttacker is ITokenHook {
    IDuelyVault public immutable vault;

    address public target;
    bytes public payload;
    bool public onSend; // true: fire from tokensToSend, false: from tokensReceived
    bool public fired;
    bool public ok;
    bytes public ret;
    uint256 public seenTotalAssets;
    uint256 public seenPrice;

    constructor(IDuelyVault vault_) {
        vault = vault_;
    }

    function arm(address target_, bytes calldata payload_, bool onSend_) external {
        target = target_;
        payload = payload_;
        onSend = onSend_;
        fired = false;
        ok = false;
        delete ret;
    }

    function exec(address t, bytes calldata data) external returns (bytes memory out) {
        bool success;
        (success, out) = t.call(data);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(out, 32), mload(out))
            }
        }
    }

    function approve(IERC20 token, address spender) external {
        token.approve(spender, type(uint256).max);
    }

    function tokensToSend(address, address, uint256) external {
        if (onSend) _attack();
    }

    function tokensReceived(address, address, uint256) external {
        if (!onSend) _attack();
    }

    function _attack() private {
        if (fired || target == address(0)) return;
        fired = true;
        seenTotalAssets = vault.totalAssets();
        seenPrice = vault.convertToAssets(1e24);
        (ok, ret) = target.call(payload);
    }

    function retSelector() external view returns (bytes4 s) {
        bytes memory r = ret;
        if (r.length >= 4) {
            assembly ("memory-safe") {
                s := mload(add(r, 32))
            }
        }
    }
}
