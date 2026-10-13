// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Test-only mocks that mimic Aave v3's scaled-balance accounting.

contract MockERC20 {
    string public name; uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public usdtStyle; // no return values + approve must reset to 0 first

    constructor(string memory n, bool usdtStyle_) { name = n; usdtStyle = usdtStyle_; }

    function mint(address to, uint256 a) external { balanceOf[to] += a; }

    function _ret(bool v) private view {
        if (usdtStyle) assembly { return(0, 0) }
        assembly { mstore(0, v) return(0, 32) }
    }
    function approve(address s, uint256 a) external returns (bool) {
        if (usdtStyle) require(a == 0 || allowance[msg.sender][s] == 0, "USDT: reset first");
        allowance[msg.sender][s] = a; _ret(true); return true;
    }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a; balanceOf[to] += a; _ret(true); return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(balanceOf[f] >= a, "bal");
        require(allowance[f][msg.sender] >= a, "allow");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; _ret(true); return true;
    }
}
