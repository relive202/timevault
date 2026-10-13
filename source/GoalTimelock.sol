// SPDX-License-Identifier: MIT
// Based on OpenZeppelin Contracts v4.9.6 (token/ERC20/utils/TokenTimelock.sol).
// The ONLY changes from OpenZeppelin's audited TokenTimelock are marked "CHANGE".

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @dev A token holder contract that will allow a beneficiary to extract the
 * tokens once a savings goal is reached, or after a backup release time,
 * whichever comes first.
 */
contract GoalTimelock {
    using SafeERC20 for IERC20;

    // ERC20 basic token contract being held
    IERC20 private immutable _token;

    // beneficiary of tokens after they are released
    address private immutable _beneficiary;

    // timestamp when token release is enabled (backup date)
    uint256 private immutable _releaseTime;

    // CHANGE: savings goal, in the token's smallest units. Release is enabled once the balance reaches it.
    uint256 private immutable _goal;

    /**
     * @dev Deploys a lock that holds `token_` and only releases it to `beneficiary_` when {release} is
     * invoked after `releaseTime_` or once the balance is at least `goal_`.
     */
    constructor(IERC20 token_, address beneficiary_, uint256 releaseTime_, uint256 goal_) {
        require(releaseTime_ > block.timestamp, "TokenTimelock: release time is before current time");
        require(goal_ > 0, "GoalTimelock: goal is zero"); // CHANGE
        _token = token_;
        _beneficiary = beneficiary_;
        _releaseTime = releaseTime_;
        _goal = goal_; // CHANGE
    }

    /**
     * @dev Returns the token being held.
     */
    function token() public view virtual returns (IERC20) {
        return _token;
    }

    /**
     * @dev Returns the beneficiary that will receive the tokens.
     */
    function beneficiary() public view virtual returns (address) {
        return _beneficiary;
    }

    /**
     * @dev Returns the backup release time in seconds since Unix epoch (i.e. Unix timestamp).
     */
    function releaseTime() public view virtual returns (uint256) {
        return _releaseTime;
    }

    /**
     * @dev CHANGE: Returns the savings goal.
     */
    function goal() public view virtual returns (uint256) {
        return _goal;
    }

    /**
     * @dev Transfers tokens held by the lock to the beneficiary. Will only succeed if the goal is reached
     * or the backup release time has passed.
     */
    function release() public virtual {
        uint256 amount = token().balanceOf(address(this));
        require(amount > 0, "TokenTimelock: no tokens to release");

        // CHANGE: was `require(block.timestamp >= releaseTime(), ...)`
        require(
            amount >= goal() || block.timestamp >= releaseTime(),
            "GoalTimelock: goal not reached and before release time"
        );

        token().safeTransfer(beneficiary(), amount);
    }
}
