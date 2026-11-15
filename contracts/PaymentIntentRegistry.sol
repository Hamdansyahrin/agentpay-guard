// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PaymentIntentRegistry
/// @notice The public audit trail for AgentPay Guard (DESIGN.md §3.2). Every
///         payment an agent considers becomes an intent here; the vault then
///         marks it Executed or Refused (with a machine-readable reason).
///         Recording refusals on-chain is the point: "the agent tried to pay
///         the wrong person and the chain stopped it" is provable, not a log
///         line anyone could have edited.
/// @dev Writers: the AgentVault (marks outcomes) and registered agent
///      recorders (propose intents). Anyone can read.
contract PaymentIntentRegistry {
    enum Status {
        Proposed,
        Executed,
        Refused,
        Expired
    }

    /// @dev Reason codes mirror DESIGN.md §3.2. `MandatePaused` is an addition
    ///      to the design list: §3.1 gives mandates a Paused status, and a
    ///      payment attempted against a paused mandate needs its own code
    ///      rather than being misreported as revoked or expired.
    enum RefusalReason {
        None,
        OverTxCap,
        OverDailyCap,
        PayeeNotAllowed,
        MandateExpired,
        MandatePaused,
        MandateRevoked,
        InsufficientBalance,
        OracleUnavailable
    }

    struct Intent {
        bytes32 intentHash; // hash of the payment request the agent received
        bytes32 rationaleHash; // hash of the agent's plain-language reason
        uint256 mandateId;
        address payee;
        address token; // address(0) = native QIE (v1)
        uint256 amount; // in the token's smallest unit (wei for native)
        Status status;
        RefusalReason refusalReason;
        address proposedBy;
        uint64 createdAt;
    }

    /// @notice A Proposed intent that was never executed expires after this.
    uint256 public constant INTENT_TTL = 1 hours;

    address public owner;
    address public vault;
    mapping(address => bool) public recorders;

    Intent[] private _intents; // intent ids are index + 1, so 0 means "none"

    event VaultSet(address indexed vault);
    event RecorderSet(address indexed recorder, bool allowed);
    event IntentProposed(
        uint256 indexed intentId,
        uint256 indexed mandateId,
        address indexed payee,
        address token,
        uint256 amount,
        address proposedBy
    );
    event IntentExecuted(uint256 indexed intentId);
    event IntentRefused(uint256 indexed intentId, RefusalReason reason, string reasonCode);
    event IntentExpired(uint256 indexed intentId);

    error NotOwner();
    error NotWriter();
    error NotVault();
    error UnknownIntent(uint256 intentId);
    error IntentNotProposed(uint256 intentId);
    error IntentNotExpired(uint256 intentId);
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyWriter() {
        if (msg.sender != vault && !recorders[msg.sender]) revert NotWriter();
        _;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ------------------------------------------------------------------ admin

    function setVault(address vault_) external onlyOwner {
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        emit VaultSet(vault_);
    }

    function setRecorder(address recorder, bool allowed) external onlyOwner {
        if (recorder == address(0)) revert ZeroAddress();
        recorders[recorder] = allowed;
        emit RecorderSet(recorder, allowed);
    }

    // ----------------------------------------------------------------- writes

    /// @notice Record a payment the agent is considering. Called by the agent
    ///         recorder before it asks the vault to execute.
    function proposeIntent(
        bytes32 intentHash,
        bytes32 rationaleHash,
        uint256 mandateId,
        address payee,
        address token,
        uint256 amount
    ) external onlyWriter returns (uint256 intentId) {
        if (payee == address(0)) revert ZeroAddress();
        _intents.push(
            Intent({
                intentHash: intentHash,
                rationaleHash: rationaleHash,
                mandateId: mandateId,
                payee: payee,
                token: token,
                amount: amount,
                status: Status.Proposed,
                refusalReason: RefusalReason.None,
                proposedBy: msg.sender,
                createdAt: uint64(block.timestamp)
            })
        );
        intentId = _intents.length; // ids start at 1
        emit IntentProposed(intentId, mandateId, payee, token, amount, msg.sender);
    }

    /// @notice Mark an intent as paid. Vault only, once, from Proposed.
    function markExecuted(uint256 intentId) external onlyVault {
        Intent storage intent = _proposedIntent(intentId);
        intent.status = Status.Executed;
        emit IntentExecuted(intentId);
    }

    /// @notice Mark an intent as refused, with the reason. Vault only.
    function markRefused(uint256 intentId, RefusalReason reason) external onlyVault {
        Intent storage intent = _proposedIntent(intentId);
        intent.status = Status.Refused;
        intent.refusalReason = reason;
        emit IntentRefused(intentId, reason, refusalReasonCode(reason));
    }

    /// @notice Close out a Proposed intent whose TTL has lapsed unexecuted.
    function expireIntent(uint256 intentId) external onlyWriter {
        Intent storage intent = _proposedIntent(intentId);
        if (block.timestamp <= uint256(intent.createdAt) + INTENT_TTL) {
            revert IntentNotExpired(intentId);
        }
        intent.status = Status.Expired;
        emit IntentExpired(intentId);
    }

    // ------------------------------------------------------------------ reads

    function intentCount() external view returns (uint256) {
        return _intents.length;
    }

    function getIntent(uint256 intentId) external view returns (Intent memory) {
        if (intentId == 0 || intentId > _intents.length) revert UnknownIntent(intentId);
        return _intents[intentId - 1];
    }

    /// @notice The DESIGN.md §3.2 reason code string for a refusal reason.
    function refusalReasonCode(RefusalReason reason) public pure returns (string memory) {
        if (reason == RefusalReason.OverTxCap) return "OVER_TX_CAP";
        if (reason == RefusalReason.OverDailyCap) return "OVER_DAILY_CAP";
        if (reason == RefusalReason.PayeeNotAllowed) return "PAYEE_NOT_ALLOWED";
        if (reason == RefusalReason.MandateExpired) return "MANDATE_EXPIRED";
        if (reason == RefusalReason.MandatePaused) return "MANDATE_PAUSED";
        if (reason == RefusalReason.MandateRevoked) return "MANDATE_REVOKED";
        if (reason == RefusalReason.InsufficientBalance) return "INSUFFICIENT_BALANCE";
        if (reason == RefusalReason.OracleUnavailable) return "ORACLE_UNAVAILABLE";
        return "NONE";
    }

    // --------------------------------------------------------------- internal

    function _proposedIntent(uint256 intentId) internal view returns (Intent storage intent) {
        if (intentId == 0 || intentId > _intents.length) revert UnknownIntent(intentId);
        intent = _intents[intentId - 1];
        if (intent.status != Status.Proposed) revert IntentNotProposed(intentId);
    }
}
