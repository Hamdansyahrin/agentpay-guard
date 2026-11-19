// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GuardBadge} from "./GuardBadge.sol";

/// @notice Minimal view of the SPACE ID Agent ID contract (ERC-721).
interface IAgentID {
    function balanceOf(address owner) external view returns (uint256);
}

/// @notice Minimal ERC-20 surface used by the vault.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title AgentPay Guard — Agent ID-gated registry, spending policy and vault
/// @notice An Agent ID holder registers an agent identity, sets an on-chain
///         spending policy (per-transaction cap, daily cap, optional recipient
///         allowlist, human-confirm threshold) and funds a vault. The registered
///         agent can pay out of the vault only within that policy; payments
///         above the confirm threshold additionally require a single-use,
///         exact-amount approval recorded on-chain by the owner beforehand.
///
///         This contract is a policy-enforcement vault for the owner's own
///         funds. It is NOT an investment product and promises no returns.
///
/// @dev OWNER-PERMISSION SURFACE (complete):
///      - There is NO contract admin: no global owner, no pause, no upgrade
///        path, no fee, no sweep. Nobody — including the deployer — can move,
///        freeze, or redirect another registrant's funds.
///      - A registrant ("owner") CAN, for their own registration only:
///        set/replace their policy, manage their allowlist, deposit funds,
///        withdraw their own funds at any time (policy binds the agent,
///        never the owner's own withdrawals), record/revoke single-use
///        payment approvals, change their agent address, deactivate or
///        reactivate their registration.
///      - A registrant CANNOT: touch another registration in any way; make the
///        agent path pay above their own caps (registering yourself as your
///        own agent does not bypass policy — only `withdraw`, to yourself,
///        moves money outside policy); mint badges outside registration;
///        change the Agent ID contract address.
///      - The registered agent CAN only call `executePayment`, and only
///        within the owner's policy. It cannot withdraw, change policy, or
///        approve its own above-threshold payments.
contract AgentPayGuard {
    /// @notice SPACE ID Agent ID contract on BSC mainnet:
    ///         0x60b9262456de011f7d15a54cdd8c48baaa8b022f (passed to constructor).
    IAgentID public immutable agentID;

    /// @notice The soulbound Guarded Agent badge, deployed by this constructor.
    GuardBadge public immutable badge;

    struct Policy {
        uint256 perTxCap; // max amount of a single payment
        uint256 dailyCap; // max total paid per UTC day window
        uint256 confirmThreshold; // amounts strictly above need owner approval; 0 = all need approval
        bool enforceAllowlist; // if true, recipients must be allowlisted
    }

    struct Registration {
        address agent; // address allowed to call executePayment
        bool active;
        uint256 registeredAt;
        uint256 agentIdBalance; // Agent ID balanceOf recorded at registration
        Policy policy;
        uint256 dayIndex; // block.timestamp / 86400 of the current spend window
        uint256 spentToday; // total paid in the current window
        bool badgeMinted;
    }

    mapping(address => Registration) private _registrations; // owner => registration
    mapping(address => address) public ownerOfAgent; // agent => owner
    mapping(address => mapping(address => bool)) private _allowlist; // owner => recipient => allowed
    mapping(address => mapping(address => uint256)) private _balances; // owner => token (0 = BNB) => amount
    mapping(address => mapping(bytes32 => bool)) private _approvals; // owner => approval key => recorded

    event Registered(address indexed owner, address indexed agent, uint256 agentIdBalance);
    event PolicyUpdated(
        address indexed owner, uint256 perTxCap, uint256 dailyCap, uint256 confirmThreshold, bool enforceAllowlist
    );
    event AllowlistUpdated(address indexed owner, address indexed recipient, bool allowed);
    event Deposited(address indexed owner, address indexed token, uint256 amount);
    event PaymentApproved(address indexed owner, address indexed recipient, address indexed token, uint256 amount);
    event ApprovalRevoked(address indexed owner, address indexed recipient, address indexed token, uint256 amount);
    event PaymentExecuted(
        address indexed owner, address indexed agent, address indexed recipient, address token, uint256 amount
    );
    event Withdrawn(address indexed owner, address indexed token, uint256 amount);
    event AgentUpdated(address indexed owner, address indexed oldAgent, address indexed newAgent);
    event RegistrationDeactivated(address indexed owner);
    event RegistrationReactivated(address indexed owner);

    error NotAgentIDHolder();
    error AlreadyRegistered();
    error NotRegistered();
    error RegistrationInactive();
    error AgentAlreadyBound();
    error NotOwner();
    error NotAgent();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientVaultBalance();
    error ExceedsPerTxCap();
    error ExceedsDailyCap();
    error RecipientNotAllowlisted();
    error ApprovalRequired();
    error TransferFailed();

    constructor(address agentID_) {
        if (agentID_ == address(0)) revert ZeroAddress();
        agentID = IAgentID(agentID_);
        badge = new GuardBadge(address(this));
    }

    // ------------------------------------------------------------------
    // Registration
    // ------------------------------------------------------------------

    /// @notice Register your agent identity. Requires holding an Agent ID
    ///         (balanceOf(msg.sender) > 0 on the Agent ID contract).
    ///         Mints the soulbound Guarded Agent badge. Fail-closed default
    ///         policy: all caps 0 and confirm threshold 0, so no payment can
    ///         execute until the owner sets a real policy.
    /// @param agent The address the agent will call `executePayment` from.
    ///              May equal the owner (policy still applies to it).
    function register(address agent) external {
        if (agent == address(0)) revert ZeroAddress();
        uint256 bal = agentID.balanceOf(msg.sender);
        if (bal == 0) revert NotAgentIDHolder();
        Registration storage r = _registrations[msg.sender];
        if (r.registeredAt != 0) revert AlreadyRegistered();
        if (ownerOfAgent[agent] != address(0)) revert AgentAlreadyBound();

        r.agent = agent;
        r.active = true;
        r.registeredAt = block.timestamp;
        r.agentIdBalance = bal;
        r.dayIndex = block.timestamp / 86400;
        ownerOfAgent[agent] = msg.sender;

        r.badgeMinted = true;
        badge.mint(msg.sender);

        emit Registered(msg.sender, agent, bal);
    }

    /// @notice Rebind the agent address for your registration.
    function updateAgent(address newAgent) external onlyRegistered {
        if (newAgent == address(0)) revert ZeroAddress();
        Registration storage r = _registrations[msg.sender];
        address bound = ownerOfAgent[newAgent];
        if (bound != address(0) && bound != msg.sender) revert AgentAlreadyBound();
        address old = r.agent;
        if (old != newAgent) {
            ownerOfAgent[old] = address(0);
            ownerOfAgent[newAgent] = msg.sender;
            r.agent = newAgent;
        }
        emit AgentUpdated(msg.sender, old, newAgent);
    }

    /// @notice Suspend your registration: the agent cannot pay while inactive.
    function deactivate() external onlyRegistered {
        _registrations[msg.sender].active = false;
        emit RegistrationDeactivated(msg.sender);
    }

    /// @notice Resume a suspended registration.
    function reactivate() external onlyRegistered {
        _registrations[msg.sender].active = true;
        emit RegistrationReactivated(msg.sender);
    }

    // ------------------------------------------------------------------
    // Policy
    // ------------------------------------------------------------------

    /// @notice Replace your spending policy.
    /// @param perTxCap Max amount of one payment (asset's smallest unit).
    /// @param dailyCap Max total paid per UTC day window.
    /// @param confirmThreshold Amounts strictly above this need a recorded
    ///        owner approval. 0 = every payment needs approval;
    ///        type(uint256).max effectively disables the confirm tier.
    /// @param enforceAllowlist If true, recipients must be allowlisted.
    function setPolicy(uint256 perTxCap, uint256 dailyCap, uint256 confirmThreshold, bool enforceAllowlist)
        external
        onlyRegistered
    {
        _registrations[msg.sender].policy = Policy(perTxCap, dailyCap, confirmThreshold, enforceAllowlist);
        emit PolicyUpdated(msg.sender, perTxCap, dailyCap, confirmThreshold, enforceAllowlist);
    }

    /// @notice Add or remove a payment recipient on your allowlist.
    function setAllowlist(address recipient, bool allowed) external onlyRegistered {
        if (recipient == address(0)) revert ZeroAddress();
        _allowlist[msg.sender][recipient] = allowed;
        emit AllowlistUpdated(msg.sender, recipient, allowed);
    }

    // ------------------------------------------------------------------
    // Vault funding
    // ------------------------------------------------------------------

    /// @notice Deposit BNB into your vault balance.
    function deposit() external payable onlyRegistered {
        if (msg.value == 0) revert ZeroAmount();
        _balances[msg.sender][address(0)] += msg.value;
        emit Deposited(msg.sender, address(0), msg.value);
    }

    /// @notice Deposit an ERC-20 into your vault balance (approve first).
    function depositToken(address token, uint256 amount) external onlyRegistered {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        _balances[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Withdraw your own funds from the vault, to yourself, at any
    ///         time. Policy never restricts the owner's own withdrawals.
    function withdraw(address token, uint256 amount) external onlyRegistered {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = _balances[msg.sender][token];
        if (bal < amount) revert InsufficientVaultBalance();
        _balances[msg.sender][token] = bal - amount;
        _send(msg.sender, token, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    // ------------------------------------------------------------------
    // Owner approvals (human-confirm tier)
    // ------------------------------------------------------------------

    /// @notice Record a single-use approval for ONE exact payment
    ///         (recipient + token + amount). Consumed by `executePayment`.
    ///         This is an explicit, user-confirmed transaction — there is no
    ///         standing or blanket approval.
    function approvePayment(address recipient, address token, uint256 amount) external onlyRegistered {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _approvals[msg.sender][_approvalKey(recipient, token, amount)] = true;
        emit PaymentApproved(msg.sender, recipient, token, amount);
    }

    /// @notice Revoke a previously recorded approval before it is used.
    function revokeApproval(address recipient, address token, uint256 amount) external onlyRegistered {
        _approvals[msg.sender][_approvalKey(recipient, token, amount)] = false;
        emit ApprovalRevoked(msg.sender, recipient, token, amount);
    }

    // ------------------------------------------------------------------
    // Agent payment execution
    // ------------------------------------------------------------------

    /// @notice Pay from the owner's vault. Callable ONLY by the registered
    ///         agent address, and only if every policy rule passes:
    ///         per-transaction cap, daily cap, allowlist (if enforced), and —
    ///         for amounts above the confirm threshold — a recorded,
    ///         single-use owner approval, which this call consumes.
    /// @param recipient Payment destination.
    /// @param token address(0) for BNB, otherwise the ERC-20 contract.
    /// @param amount Amount in the asset's smallest unit.
    function executePayment(address recipient, address token, uint256 amount) external {
        address owner = ownerOfAgent[msg.sender];
        if (owner == address(0)) revert NotAgent();
        Registration storage r = _registrations[owner];
        if (!r.active) revert RegistrationInactive();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 bal = _balances[owner][token];
        if (bal < amount) revert InsufficientVaultBalance();

        Policy storage p = r.policy;
        if (amount > p.perTxCap) revert ExceedsPerTxCap();

        uint256 today = block.timestamp / 86400;
        uint256 spent = today == r.dayIndex ? r.spentToday : 0;
        if (spent + amount > p.dailyCap) revert ExceedsDailyCap();

        if (p.enforceAllowlist && !_allowlist[owner][recipient]) revert RecipientNotAllowlisted();

        if (amount > p.confirmThreshold) {
            bytes32 key = _approvalKey(recipient, token, amount);
            if (!_approvals[owner][key]) revert ApprovalRequired();
            _approvals[owner][key] = false; // consume: single-use
        }

        r.dayIndex = today;
        r.spentToday = spent + amount;
        _balances[owner][token] = bal - amount;
        _send(recipient, token, amount);
        emit PaymentExecuted(owner, msg.sender, recipient, token, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice True if `account` currently holds at least one Agent ID.
    function isAgentIDHolder(address account) external view returns (bool) {
        return agentID.balanceOf(account) > 0;
    }

    function getRegistration(address owner)
        external
        view
        returns (address agent, bool active, uint256 registeredAt, uint256 agentIdBalance, bool badgeMinted)
    {
        Registration storage r = _registrations[owner];
        return (r.agent, r.active, r.registeredAt, r.agentIdBalance, r.badgeMinted);
    }

    function getPolicy(address owner)
        external
        view
        returns (uint256 perTxCap, uint256 dailyCap, uint256 confirmThreshold, bool enforceAllowlist)
    {
        Policy storage p = _registrations[owner].policy;
        return (p.perTxCap, p.dailyCap, p.confirmThreshold, p.enforceAllowlist);
    }

    /// @notice Vault balance of `owner` for `token` (address(0) = BNB).
    function vaultBalance(address owner, address token) external view returns (uint256) {
        return _balances[owner][token];
    }

    function isAllowlisted(address owner, address recipient) external view returns (bool) {
        return _allowlist[owner][recipient];
    }

    /// @notice True if an unconsumed owner approval exists for this exact payment.
    function hasApproval(address owner, address recipient, address token, uint256 amount)
        external
        view
        returns (bool)
    {
        return _approvals[owner][_approvalKey(recipient, token, amount)];
    }

    /// @notice Amount the agent has paid in the current UTC day window.
    function spentToday(address owner) external view returns (uint256) {
        Registration storage r = _registrations[owner];
        return block.timestamp / 86400 == r.dayIndex ? r.spentToday : 0;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    modifier onlyRegistered() {
        if (_registrations[msg.sender].registeredAt == 0) revert NotRegistered();
        _;
    }

    function _approvalKey(address recipient, address token, uint256 amount) internal pure returns (bytes32) {
        return keccak256(abi.encode(recipient, token, amount));
    }

    function _send(address to, address token, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
        }
    }

    /// @notice BNB can also arrive via plain transfer from the owner only if
    ///         they are registered; prefer `deposit()`. Plain sends from
    ///         anyone else are rejected so funds are never stranded without
    ///         a ledger entry.
    receive() external payable {
        if (_registrations[msg.sender].registeredAt == 0) revert NotRegistered();
        if (msg.value == 0) revert ZeroAmount();
        _balances[msg.sender][address(0)] += msg.value;
        emit Deposited(msg.sender, address(0), msg.value);
    }
}
