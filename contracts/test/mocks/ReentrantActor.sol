// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test double: a contract wallet that, when armed, re-enters `target` with stored calldata
/// from a token-transfer callback and bubbles up any revert.
contract ReentrantActor {
    address public target;
    bytes public reentryData;
    bool public armed;

    function arm(address target_, bytes calldata data) external {
        target = target_;
        reentryData = data;
        armed = true;
    }

    function exec(address to, bytes calldata data) external returns (bytes memory) {
        return _call(to, data);
    }

    function onTokenTransfer() external {
        if (!armed) return;
        armed = false;
        _call(target, reentryData);
    }

    function _call(address to, bytes memory data) private returns (bytes memory ret) {
        bool ok;
        (ok, ret) = to.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
