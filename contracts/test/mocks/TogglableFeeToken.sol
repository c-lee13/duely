// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev TEST ONLY. 18-decimal token that behaves normally until `taxOn` is set, after which every
/// transfer burns 1 wei so recipients receive less than sent (a fee-on-transfer switch that can be
/// flipped after deposits succeed).
contract TogglableFeeToken is ERC20 {
    bool public taxOn;

    constructor() ERC20("Toggle", "TGL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTax(bool on) external {
        taxOn = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (taxOn && from != address(0) && to != address(0) && value > 0) {
            super._update(from, address(0), 1);
            value -= 1;
        }
        super._update(from, to, value);
    }
}
