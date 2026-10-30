// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Attack tests for TimeVault's two lock contracts.
// They try, with random amounts, times and callers, to get money out early or to anyone but the owner.

import "forge-std/Test.sol";
import {GoalTimelock} from "../../source/GoalTimelock.sol";
import {TokenTimelock} from "@openzeppelin/contracts/token/ERC20/utils/TokenTimelock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// USDC-like coin: 6 decimals, and the issuer can freeze (blacklist) addresses, like Circle can.
contract MockUSDC is ERC20 {
    mapping(address => bool) public blacklisted;
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { _mint(to, a); }
    function setBlacklist(address a, bool b) external { blacklisted[a] = b; }
    function _beforeTokenTransfer(address from, address to, uint256) internal view override {
        require(!blacklisted[from] && !blacklisted[to], "blacklisted");
    }
}

/// USDT-like coin: transfer() returns nothing, like Tether's original contract.
contract MockUSDT {
    mapping(address => uint256) public balanceOf;
    function decimals() external pure returns (uint8) { return 6; }
    function totalSupply() external pure returns (uint256) { return 0; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external { require(balanceOf[msg.sender] >= a, "balance"); balanceOf[msg.sender] -= a; balanceOf[to] += a; }
}

contract GoalLockTest is Test {
    MockUSDC usdc;
    address you = makeAddr("you");
    address stranger = makeAddr("stranger");

    function setUp() public { usdc = new MockUSDC(); vm.warp(1_800_000_000); }

    function _fund(address lock, uint256 a) internal { usdc.mint(stranger, a); vm.prank(stranger); usdc.transfer(lock, a); }

    function testFuzz_noReleaseBeforeGoalOrDate(uint256 goal, uint256 dep, uint256 days_, uint256 wait, address caller) public {
        assumeNotForgeAddress(caller);
        goal = bound(goal, 2, 1e15);
        dep = bound(dep, 1, goal - 1);
        days_ = bound(days_, 1, 3650);
        GoalTimelock lock = new GoalTimelock(IERC20(address(usdc)), you, block.timestamp + days_ * 1 days, goal);
        _fund(address(lock), dep);
        vm.warp(block.timestamp + bound(wait, 0, days_ * 1 days - 1));
        vm.prank(caller);
        vm.expectRevert(bytes("GoalTimelock: goal not reached and before release time"));
        lock.release();
        assertEq(usdc.balanceOf(address(lock)), dep, "money must stay in the lock");
    }

    function testFuzz_goalReachedPaysOnlyOwner(uint256 goal, uint256 extra, address caller) public {
        assumeNotForgeAddress(caller);
        goal = bound(goal, 1, 1e15);
        uint256 dep = goal + bound(extra, 0, 1e15);
        GoalTimelock lock = new GoalTimelock(IERC20(address(usdc)), you, block.timestamp + 365 days, goal);
        vm.assume(caller != you && caller != address(lock) && caller != address(usdc));
        _fund(address(lock), dep);
        uint256 callerBefore = usdc.balanceOf(caller);
        vm.prank(caller);
        lock.release();
        assertEq(usdc.balanceOf(you), dep, "owner gets everything");
        assertEq(usdc.balanceOf(address(lock)), 0, "lock is empty");
        assertEq(usdc.balanceOf(caller), callerBefore, "the caller gets nothing");
    }

    function testFuzz_backupDatePaysOnlyOwner(uint256 goal, uint256 dep, uint256 late, address caller) public {
        assumeNotForgeAddress(caller);
        vm.assume(caller != you);
        goal = bound(goal, 2, 1e15);
        dep = bound(dep, 1, goal - 1);
        uint256 rt = block.timestamp + 30 days;
        GoalTimelock lock = new GoalTimelock(IERC20(address(usdc)), you, rt, goal);
        _fund(address(lock), dep);
        vm.warp(rt + bound(late, 0, 3650 days));
        vm.prank(caller);
        lock.release();
        assertEq(usdc.balanceOf(you), dep);
        assertEq(usdc.balanceOf(address(lock)), 0);
    }

    function testFuzz_manySmallDepositsThenGoal(uint256 goal, uint8 n) public {
        goal = bound(goal, 1000, 1e12);
        n = uint8(bound(n, 2, 30));
        GoalTimelock lock = new GoalTimelock(IERC20(address(usdc)), you, block.timestamp + 365 days, goal);
        uint256 each = goal / n; uint256 total;
        for (uint256 i = 0; i < n - 1; i++) {
            _fund(address(lock), each); total += each;
            vm.expectRevert(bytes("GoalTimelock: goal not reached and before release time"));
            lock.release();
        }
        _fund(address(lock), goal - total);
        lock.release();
        assertEq(usdc.balanceOf(you), goal);
    }

    function test_settingsCannotBeBad() public {
        vm.expectRevert(bytes("TokenTimelock: release time is before current time"));
        new GoalTimelock(IERC20(address(usdc)), you, block.timestamp, 100);
        vm.expectRevert(bytes("GoalTimelock: goal is zero"));
        new GoalTimelock(IERC20(address(usdc)), you, block.timestamp + 1 days, 0);
    }

    function test_emptyLockCannotRelease() public {
        GoalTimelock lock = new GoalTimelock(IERC20(address(usdc)), you, block.timestamp + 1 days, 100);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(bytes("TokenTimelock: no tokens to release"));
        lock.release();
    }

    function test_settingsNeverChange() public {
        GoalTimelock lock = new GoalTimelock(IERC20(address(usdc)), you, block.timestamp + 10 days, 500);
        _fund(address(lock), 1000);
        lock.release();
        assertEq(lock.beneficiary(), you); assertEq(lock.goal(), 500); assertEq(address(lock.token()), address(usdc));
    }

    function test_usdtStyleCoinWorks() public {
        MockUSDT usdt = new MockUSDT();
        GoalTimelock lock = new GoalTimelock(IERC20(address(usdt)), you, block.timestamp + 10 days, 1000);
        usdt.mint(address(lock), 999);
        vm.expectRevert(bytes("GoalTimelock: goal not reached and before release time"));
        lock.release();
        usdt.mint(address(lock), 1);
        lock.release();
        assertEq(usdt.balanceOf(you), 1000);
        assertEq(usdt.balanceOf(address(lock)), 0);
    }

    /// Known outside risk: if the coin's issuer freezes your wallet, release fails.
    /// The money is not lost to anyone else: it stays in the lock and can be released once unfrozen.
    function test_frozenWalletKeepsMoneyInLock() public {
        GoalTimelock lock = new GoalTimelock(IERC20(address(usdc)), you, block.timestamp + 10 days, 100);
        _fund(address(lock), 100);
        usdc.setBlacklist(you, true);
        vm.expectRevert(bytes("blacklisted"));
        lock.release();
        assertEq(usdc.balanceOf(address(lock)), 100);
        usdc.setBlacklist(you, false);
        lock.release();
        assertEq(usdc.balanceOf(you), 100);
    }
}

contract DateLockTest is Test {
    MockUSDC usdc;
    address you = makeAddr("you");

    function setUp() public { usdc = new MockUSDC(); vm.warp(1_800_000_000); }

    function testFuzz_noReleaseBeforeDate(uint256 dep, uint256 days_, uint256 wait, address caller) public {
        assumeNotForgeAddress(caller);
        dep = bound(dep, 1, 1e18);
        days_ = bound(days_, 1, 3650);
        TokenTimelock lock = new TokenTimelock(IERC20(address(usdc)), you, block.timestamp + days_ * 1 days);
        usdc.mint(address(lock), dep);
        vm.warp(block.timestamp + bound(wait, 0, days_ * 1 days - 1));
        vm.prank(caller);
        vm.expectRevert(bytes("TokenTimelock: current time is before release time"));
        lock.release();
        assertEq(usdc.balanceOf(address(lock)), dep);
    }

    function testFuzz_afterDatePaysOnlyOwner(uint256 dep, uint256 late, address caller) public {
        assumeNotForgeAddress(caller);
        dep = bound(dep, 1, 1e18);
        uint256 rt = block.timestamp + 90 days;
        TokenTimelock lock = new TokenTimelock(IERC20(address(usdc)), you, rt);
        vm.assume(caller != you && caller != address(lock) && caller != address(usdc));
        usdc.mint(address(lock), dep);
        vm.warp(rt + bound(late, 0, 3650 days));
        uint256 cb = usdc.balanceOf(caller);
        vm.prank(caller);
        lock.release();
        assertEq(usdc.balanceOf(you), dep);
        assertEq(usdc.balanceOf(caller), cb);
    }
}

/// Random sequences of deposits, waiting and release attempts by anyone.
contract Handler is Test {
    MockUSDC public usdc; address public lock; address public owner; bool public isGoal;
    uint256 public deposited; uint256 public releases; bool public broken; string public why;
    address[] actors;

    constructor(MockUSDC u, address l, address o, bool g) {
        usdc = u; lock = l; owner = o; isGoal = g;
        actors.push(o); actors.push(makeAddr("a")); actors.push(makeAddr("b")); actors.push(address(this));
    }
    function deposit(uint256 amount, uint256 who) external {
        amount = bound(amount, 1, 1e13);
        address from = actors[who % actors.length];
        usdc.mint(from, amount); vm.prank(from); usdc.transfer(lock, amount); deposited += amount;
    }
    function wait(uint256 secs) external { vm.warp(block.timestamp + bound(secs, 0, 45 days)); }
    function release(uint256 who) external {
        uint256 bal = usdc.balanceOf(lock);
        uint256 rt = TokenTimelock(lock).releaseTime();
        bool allowed = bal > 0 && (block.timestamp >= rt || (isGoal && bal >= GoalTimelock(lock).goal()));
        uint256 before = usdc.balanceOf(owner);
        vm.prank(actors[who % actors.length]);
        try TokenTimelock(lock).release() {
            releases++;
            if (!allowed) { broken = true; why = "released when it should have stayed locked"; }
            if (usdc.balanceOf(owner) != before + bal) { broken = true; why = "owner did not get the whole balance"; }
            if (usdc.balanceOf(lock) != 0) { broken = true; why = "money left behind"; }
        } catch {
            if (allowed) { broken = true; why = "release was allowed but failed (money stuck)"; }
        }
    }
}

contract GoalLockInvariants is Test {
    MockUSDC usdc; Handler h; address you = makeAddr("you"); address lock;
    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        lock = address(new GoalTimelock(IERC20(address(usdc)), you, block.timestamp + 200 days, 5_000e6));
        h = new Handler(usdc, lock, you, true);
        targetContract(address(h));
    }
    function invariant_moneyOnlyEverInLockOrWithOwner() public view {
        assertEq(usdc.balanceOf(lock) + usdc.balanceOf(you), h.deposited());
    }
    function invariant_rulesNeverBroken() public view { assertFalse(h.broken(), h.why()); }
}

contract DateLockInvariants is Test {
    MockUSDC usdc; Handler h; address you = makeAddr("you"); address lock;
    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        lock = address(new TokenTimelock(IERC20(address(usdc)), you, block.timestamp + 120 days));
        h = new Handler(usdc, lock, you, false);
        targetContract(address(h));
    }
    function invariant_moneyOnlyEverInLockOrWithOwner() public view {
        assertEq(usdc.balanceOf(lock) + usdc.balanceOf(you), h.deposited());
    }
    function invariant_rulesNeverBroken() public view { assertFalse(h.broken(), h.why()); }
}
