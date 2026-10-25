// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ITokenHook {
    function onTokenTransfer() external;
}

/// @dev Test double: transfers can be made to return false or revert, and a hook target is
/// called back (ERC-777 style) after any transfer it sends or receives.
contract MaliciousToken is ERC20 {
    enum Mode {
        Normal,
        ReturnFalse,
        Revert
    }

    Mode public transferMode;
    Mode public transferFromMode;
    address public hookTarget;

    constructor() ERC20("Malicious Token", "EVIL") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setModes(Mode transfer_, Mode transferFrom_) external {
        transferMode = transfer_;
        transferFromMode = transferFrom_;
    }

    function setHookTarget(address target) external {
        hookTarget = target;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (transferMode == Mode.ReturnFalse) return false;
        if (transferMode == Mode.Revert) revert("transfer blocked");
        super.transfer(to, value);
        _hook(msg.sender, to);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (transferFromMode == Mode.ReturnFalse) return false;
        if (transferFromMode == Mode.Revert) revert("transferFrom blocked");
        super.transferFrom(from, to, value);
        _hook(from, to);
        return true;
    }

    function _hook(address from, address to) private {
        address target = hookTarget;
        if (target != address(0) && (from == target || to == target)) {
            ITokenHook(target).onTokenTransfer();
        }
    }
}
