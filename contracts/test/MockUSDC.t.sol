// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC token;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        token = new MockUSDC(owner);
    }

    function test_metadata() public view {
        assertEq(token.decimals(), 6);
        assertEq(token.symbol(), "dUSD");
        assertEq(token.name(), "Duely Demo USD");
    }

    function test_ownerMints() public {
        vm.prank(owner);
        token.mint(alice, 1_000e6);
        assertEq(token.balanceOf(alice), 1_000e6);
        assertEq(token.totalSupply(), 1_000e6);
    }

    function test_nonOwnerCannotMint() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        token.mint(alice, 1);
    }

    function test_transfer() public {
        vm.prank(owner);
        token.mint(alice, 100e6);
        vm.prank(alice);
        token.transfer(bob, 40e6);
        assertEq(token.balanceOf(alice), 60e6);
        assertEq(token.balanceOf(bob), 40e6);
    }
}
