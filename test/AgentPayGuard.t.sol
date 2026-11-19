// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentPayGuard} from "../contracts/AgentPayGuard.sol";
import {GuardBadge} from "../contracts/GuardBadge.sol";
import {MockAgentID, MockERC20} from "./mocks.sol";

/// @dev Minimal cheatcode interface — avoids a forge-std dependency.
interface Vm {
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
}

/// @notice Local unit tests for AgentPayGuard + GuardBadge.
contract AgentPayGuardTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    AgentPayGuard guard;
    GuardBadge badge;
    MockAgentID agentID;
    MockERC20 token;

    address owner = address(0xA11CE);
    address agent = address(0xA6E77);
    address recipient = address(0xB0B);
    address stranger = address(0x57A6);

    function setUp() public {
        agentID = new MockAgentID();
        guard = new AgentPayGuard(address(agentID));
        badge = guard.badge();
        token = new MockERC20();
        vm.deal(owner, 100 ether);
        vm.deal(agent, 1 ether);
    }

    // ---------------- helpers ----------------

    function _register() internal {
        agentID.mint(owner);
        vm.prank(owner);
        guard.register(agent);
    }

    function _policyDefault() internal {
        // perTx 0.5, daily 0.8, confirm above 0.4, allowlist enforced
        vm.prank(owner);
        guard.setPolicy(0.5 ether, 0.8 ether, 0.4 ether, true);
        vm.prank(owner);
        guard.setAllowlist(recipient, true);
    }

    function _fundBnb(uint256 amount) internal {
        vm.prank(owner);
        guard.deposit{value: amount}();
    }

    function assertEq(uint256 a, uint256 b, string memory m) internal pure {
        if (a != b) revert(m);
    }

    function assertEq(address a, address b, string memory m) internal pure {
        if (a != b) revert(m);
    }

    function assertTrue(bool c, string memory m) internal pure {
        if (!c) revert(m);
    }

    // ---------------- tests ----------------

    function testNonHolderCannotRegister() public {
        vm.prank(stranger);
        vm.expectRevert(AgentPayGuard.NotAgentIDHolder.selector);
        guard.register(agent);
    }

    function testHolderRegistersAndGetsBadge() public {
        _register();
        (address a, bool active, uint256 at, uint256 bal, bool minted) = guard.getRegistration(owner);
        assertEq(a, agent, "agent bound");
        assertTrue(active, "active");
        assertTrue(at != 0, "registeredAt set");
        assertEq(bal, 1, "agentId balance recorded");
        assertTrue(minted, "badge flag");
        assertEq(badge.balanceOf(owner), 1, "badge held");
        assertTrue(badge.hasBadge(owner), "hasBadge");
        assertEq(guard.ownerOfAgent(agent), owner, "reverse binding");

        // second registration reverts
        vm.prank(owner);
        vm.expectRevert(AgentPayGuard.AlreadyRegistered.selector);
        guard.register(agent);
    }

    function testBadgeIsSoulbound() public {
        _register();
        vm.prank(owner);
        vm.expectRevert(GuardBadge.Soulbound.selector);
        badge.transferFrom(owner, stranger, 1);
    }

    function testSetPolicy() public {
        _register();
        _policyDefault();
        (uint256 perTx, uint256 daily, uint256 threshold, bool enforce) = guard.getPolicy(owner);
        assertEq(perTx, 0.5 ether, "perTx");
        assertEq(daily, 0.8 ether, "daily");
        assertEq(threshold, 0.4 ether, "threshold");
        assertTrue(enforce, "enforce");

        // unregistered account cannot set a policy
        vm.prank(stranger);
        vm.expectRevert(AgentPayGuard.NotRegistered.selector);
        guard.setPolicy(1, 1, 1, false);

        // the agent (not an owner) cannot set policy either
        vm.prank(agent);
        vm.expectRevert(AgentPayGuard.NotRegistered.selector);
        guard.setPolicy(1, 1, 1, false);
    }

    function testPaymentWithinPolicyExecutesBnb() public {
        _register();
        _policyDefault();
        _fundBnb(1 ether);
        uint256 before = recipient.balance;
        vm.prank(agent);
        guard.executePayment(recipient, address(0), 0.3 ether);
        assertEq(recipient.balance - before, 0.3 ether, "recipient paid");
        assertEq(guard.vaultBalance(owner, address(0)), 0.7 ether, "vault debited");
        assertEq(guard.spentToday(owner), 0.3 ether, "daily tracked");
    }

    function testPaymentWithinPolicyExecutesToken() public {
        _register();
        _policyDefault();
        token.mint(owner, 100 ether);
        vm.prank(owner);
        token.approve(address(guard), 100 ether);
        vm.prank(owner);
        guard.depositToken(address(token), 10 ether);
        vm.prank(agent);
        guard.executePayment(recipient, address(token), 0.2 ether);
        assertEq(token.balanceOf(recipient), 0.2 ether, "token paid");
        assertEq(guard.vaultBalance(owner, address(token)), 9.8 ether, "token vault debited");
    }

    function testPaymentAbovePerTxCapReverts() public {
        _register();
        _policyDefault();
        _fundBnb(1 ether);
        vm.prank(agent);
        vm.expectRevert(AgentPayGuard.ExceedsPerTxCap.selector);
        guard.executePayment(recipient, address(0), 0.6 ether);
    }

    function testPaymentAboveDailyCapReverts() public {
        _register();
        _policyDefault();
        _fundBnb(1 ether);
        vm.prank(agent);
        guard.executePayment(recipient, address(0), 0.4 ether);
        vm.prank(agent);
        guard.executePayment(recipient, address(0), 0.4 ether);
        // 0.8 spent = daily cap reached; next payment exceeds it
        vm.prank(agent);
        vm.expectRevert(AgentPayGuard.ExceedsDailyCap.selector);
        guard.executePayment(recipient, address(0), 0.1 ether);
    }

    function testPaymentToNonAllowlistedReverts() public {
        _register();
        _policyDefault();
        _fundBnb(1 ether);
        vm.prank(agent);
        vm.expectRevert(AgentPayGuard.RecipientNotAllowlisted.selector);
        guard.executePayment(stranger, address(0), 0.1 ether);
    }

    function testAboveThresholdRequiresApprovalAndApprovalIsSingleUse() public {
        _register();
        // perTx 1.0, daily 2.0, confirm above 0.4
        vm.prank(owner);
        guard.setPolicy(1 ether, 2 ether, 0.4 ether, true);
        vm.prank(owner);
        guard.setAllowlist(recipient, true);
        _fundBnb(2 ether);

        // 0.6 > threshold 0.4: no approval recorded -> revert
        vm.prank(agent);
        vm.expectRevert(AgentPayGuard.ApprovalRequired.selector);
        guard.executePayment(recipient, address(0), 0.6 ether);

        // owner records the exact approval -> payment executes
        vm.prank(owner);
        guard.approvePayment(recipient, address(0), 0.6 ether);
        assertTrue(guard.hasApproval(owner, recipient, address(0), 0.6 ether), "approval recorded");
        vm.prank(agent);
        guard.executePayment(recipient, address(0), 0.6 ether);
        assertTrue(!guard.hasApproval(owner, recipient, address(0), 0.6 ether), "approval consumed");

        // replaying the same payment without a fresh approval reverts
        vm.prank(agent);
        vm.expectRevert(AgentPayGuard.ApprovalRequired.selector);
        guard.executePayment(recipient, address(0), 0.6 ether);

        // an approval for a different amount does not cover this payment
        vm.prank(owner);
        guard.approvePayment(recipient, address(0), 0.7 ether);
        vm.prank(agent);
        vm.expectRevert(AgentPayGuard.ApprovalRequired.selector);
        guard.executePayment(recipient, address(0), 0.6 ether);
    }

    function testNonAgentCannotRequestPayment() public {
        _register();
        _policyDefault();
        _fundBnb(1 ether);
        vm.prank(stranger);
        vm.expectRevert(AgentPayGuard.NotAgent.selector);
        guard.executePayment(recipient, address(0), 0.1 ether);
        // even the owner cannot use the agent path
        vm.prank(owner);
        vm.expectRevert(AgentPayGuard.NotAgent.selector);
        guard.executePayment(recipient, address(0), 0.1 ether);
    }

    function testDeactivatedRegistrationCannotPay() public {
        _register();
        _policyDefault();
        _fundBnb(1 ether);
        vm.prank(owner);
        guard.deactivate();
        vm.prank(agent);
        vm.expectRevert(AgentPayGuard.RegistrationInactive.selector);
        guard.executePayment(recipient, address(0), 0.1 ether);
    }

    function testOwnerWithdraw() public {
        _register();
        _fundBnb(1 ether);
        uint256 before = owner.balance;
        vm.prank(owner);
        guard.withdraw(address(0), 0.4 ether);
        assertEq(owner.balance - before, 0.4 ether, "owner withdrew");
        assertEq(guard.vaultBalance(owner, address(0)), 0.6 ether, "vault reduced");

        // agent cannot withdraw
        vm.prank(agent);
        vm.expectRevert(AgentPayGuard.NotRegistered.selector);
        guard.withdraw(address(0), 0.1 ether);
    }

    function testDailyWindowResetsNextDay() public {
        _register();
        _policyDefault();
        _fundBnb(2 ether);
        vm.prank(agent);
        guard.executePayment(recipient, address(0), 0.4 ether);
        vm.warp(block.timestamp + 1 days);
        assertEq(guard.spentToday(owner), 0, "window reset");
        vm.prank(agent);
        guard.executePayment(recipient, address(0), 0.4 ether);
        assertEq(guard.spentToday(owner), 0.4 ether, "new window spend");
    }
}
