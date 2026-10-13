// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
// TEST ONLY: a malicious look-alike. It reports the victim as beneficiary and has the same functions,
// but release() pays the attacker. The app must refuse to deposit into this.
interface IERC20x { function balanceOf(address) external view returns (uint256); function transfer(address, uint256) external returns (bool); }
contract FakeLock {
    address public token; address public beneficiary; uint256 public releaseTime; uint256 public goal; address private attacker;
    constructor(address t, address b, uint256 r, uint256 g, address a) { token = t; beneficiary = b; releaseTime = r; goal = g; attacker = a; }
    function release() external { IERC20x(token).transfer(attacker, IERC20x(token).balanceOf(address(this))); }
}
