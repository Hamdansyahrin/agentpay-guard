// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IOracleCapAdapter.sol";
import "./PaymentIntentRegistry.sol";

/// @title AgentVault
/// @notice User-funded escrow holding AgentPay Guard spending mandates
///         (DESIGN.md §3.1). The owner decides in advance who the agent may
///         pay, how much, and until when; this contract enforces it. Payments
///         inside the mandate execute autonomously; anything outside it is
///         refused and the refusal is recorded in PaymentIntentRegistry.
/// @dev Boring on purpose: checks-effects-interactions, a reentrancy guard on
///      the payment/withdrawal paths, no delegatecall, no upgradeability.
contract AgentVault {
    enum MandateStatus {
        Active,
        Paused,
        Revoked
    }

    struct Spend {
        uint64 timestamp;
        uint256 usdValue; // 18-decimal USD, as converted at execution time
    }

    struct Mandate {
        address owner;
        address agent;
        uint256 perTxCapUsd; // 18-decimal USD
        uint256 dailyCapUsd; // 18-decimal USD, rolling 24h window
        uint64 expiresAt;
        MandateStatus status;
        uint256 balance; // native QIE, wei
        address[] payeeList;
        mapping(address => bool) isPayee;
        mapping(address => string) payeeNames; // optional .qie name, for display
        Spend[] spends;
        uint256 spendHead; // index of the oldest spend still in the window
    }

    uint256 public constant DAILY_WINDOW = 24 hours;

    PaymentIntentRegistry public registry;
    IOracleCapAdapter public oracleAdapter;
    /// @notice Deployer. May swap the oracle adapter (Stage 3 wires the real
    ///         QIE Oracle adapter in place of the mock) — nothing else.
    address public admin;

    mapping(uint256 => Mandate) private _mandates;
    uint256 public mandateCount; // mandate ids are 1..mandateCount

    bool private _locked;

    event MandateCreated(
        uint256 indexed mandateId,
        address indexed owner,
        address indexed agent,
        uint256 perTxCapUsd,
        uint256 dailyCapUsd,
        uint64 expiresAt
    );
    event PayeeAdded(uint256 indexed mandateId, address indexed payee, string qieName);
    event PayeeRemoved(uint256 indexed mandateId, address indexed payee);
    event MandateFunded(uint256 indexed mandateId, address indexed funder, uint256 amount);
    event PaymentExecuted(
        uint256 indexed mandateId,
        uint256 indexed intentId,
        address indexed payee,
        uint256 amountWei,
        uint256 usdValue
    );
    event PaymentRefused(
        uint256 indexed mandateId,
        uint256 indexed intentId,
        address indexed payee,
        uint256 amountWei,
        string reasonCode
    );
    event MandatePaused(uint256 indexed mandateId);
    event MandateResumed(uint256 indexed mandateId);
    event MandateRevoked(uint256 indexed mandateId);
    event Withdrawn(uint256 indexed mandateId, address indexed owner, uint256 amountWei);
    event OracleAdapterUpdated(address indexed newAdapter);

    error NotAdmin();
    error NotOwner(uint256 mandateId);
    error NotAgent(uint256 mandateId);
    error UnknownMandate(uint256 mandateId);
    error IntentMismatch(uint256 intentId);
    error TransferFailed();
    error BadAmount();
    error BadMandateParams();
    error ReentrantCall();

    modifier nonReentrant() {
        if (_locked) revert ReentrantCall();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(address registry_, address oracleAdapter_) {
        if (registry_ == address(0) || oracleAdapter_ == address(0)) {
            revert BadMandateParams();
        }
        registry = PaymentIntentRegistry(registry_);
        oracleAdapter = IOracleCapAdapter(oracleAdapter_);
        admin = msg.sender;
    }

    // ------------------------------------------------------------------ admin

    function setOracleAdapter(address newAdapter) external {
        if (msg.sender != admin) revert NotAdmin();
        if (newAdapter == address(0)) revert BadMandateParams();
        oracleAdapter = IOracleCapAdapter(newAdapter);
        emit OracleAdapterUpdated(newAdapter);
    }

    // -------------------------------------------------------------- lifecycle

    /// @notice Create a mandate. The caller becomes its owner.
    /// @param agent Dedicated agent address allowed to call executePayment.
    /// @param perTxCapUsd Max USD value of one payment (18 decimals).
    /// @param dailyCapUsd Max USD value per rolling 24h window (18 decimals).
    /// @param expiresAt Timestamp at/after which the mandate no longer pays.
    function createMandate(
        address agent,
        uint256 perTxCapUsd,
        uint256 dailyCapUsd,
        uint64 expiresAt
    ) external returns (uint256 mandateId) {
        if (agent == address(0) || perTxCapUsd == 0 || dailyCapUsd == 0) {
            revert BadMandateParams();
        }
        if (expiresAt <= block.timestamp) revert BadMandateParams();

        mandateId = ++mandateCount;
        Mandate storage m = _mandates[mandateId];
        m.owner = msg.sender;
        m.agent = agent;
        m.perTxCapUsd = perTxCapUsd;
        m.dailyCapUsd = dailyCapUsd;
        m.expiresAt = expiresAt;
        m.status = MandateStatus.Active;

        emit MandateCreated(mandateId, msg.sender, agent, perTxCapUsd, dailyCapUsd, expiresAt);
    }

    /// @notice Add a payee to the allowlist (owner only). `qieName` is the
    ///         optional .qie name the address was resolved from, stored for
    ///         display; pass "" for a raw-address payee.
    function addPayee(uint256 mandateId, address payee, string calldata qieName) external {
        Mandate storage m = _mandateOwned(mandateId);
        if (payee == address(0)) revert BadMandateParams();
        if (!m.isPayee[payee]) {
            m.isPayee[payee] = true;
            m.payeeList.push(payee);
        }
        m.payeeNames[payee] = qieName;
        emit PayeeAdded(mandateId, payee, qieName);
    }

    /// @notice Remove a payee from the allowlist (owner only).
    function removePayee(uint256 mandateId, address payee) external {
        Mandate storage m = _mandateOwned(mandateId);
        if (m.isPayee[payee]) {
            m.isPayee[payee] = false;
            m.payeeNames[payee] = "";
            uint256 n = m.payeeList.length;
            for (uint256 i = 0; i < n; i++) {
                if (m.payeeList[i] == payee) {
                    m.payeeList[i] = m.payeeList[n - 1];
                    m.payeeList.pop();
                    break;
                }
            }
        }
        emit PayeeRemoved(mandateId, payee);
    }

    /// @notice Fund a mandate with native QIE. Anyone may fund (the traction
    ///         metrics in DESIGN.md §6 count distinct funding wallets), but
    ///         only the owner can ever withdraw.
    function fund(uint256 mandateId) external payable {
        Mandate storage m = _mandate(mandateId);
        if (msg.value == 0) revert BadAmount();
        m.balance += msg.value;
        emit MandateFunded(mandateId, msg.sender, msg.value);
    }

    // -------------------------------------------------------------- execution

    /// @notice Execute a payment for a previously proposed intent. Agent only.
    /// @dev DESIGN.md §3.1 says a failed check "reverts after the registry
    ///      records the refusal" — but a revert would roll back the registry
    ///      write as well, erasing the very record the audit trail exists to
    ///      keep. Resolution: for mandate-rule failures (status, allowlist,
    ///      caps, balance, oracle) this function records the refusal in the
    ///      registry and returns `false` WITHOUT paying and WITHOUT
    ///      reverting. It reverts only for caller errors — a non-agent
    ///      caller, an unknown mandate, or an intent that does not match
    ///      this exact payment — where no payment was ever legitimately
    ///      proposed. A failed native transfer also reverts (execution
    ///      failure, not a rule refusal), unwinding the Executed mark.
    /// @return executed True if the payee was paid.
    function executePayment(
        uint256 mandateId,
        address payee,
        uint256 amountWei,
        uint256 intentId
    ) external nonReentrant returns (bool executed) {
        Mandate storage m = _mandate(mandateId);
        if (msg.sender != m.agent) revert NotAgent(mandateId);
        if (amountWei == 0) revert BadAmount();

        // The intent must be the agent's own live proposal for exactly this
        // payment (native token, same mandate, payee and amount).
        PaymentIntentRegistry.Intent memory intent = registry.getIntent(intentId);
        if (
            intent.status != PaymentIntentRegistry.Status.Proposed ||
            intent.mandateId != mandateId ||
            intent.payee != payee ||
            intent.amount != amountWei ||
            intent.token != address(0)
        ) {
            revert IntentMismatch(intentId);
        }

        (PaymentIntentRegistry.RefusalReason reason, uint256 usdValue) = _evaluate(
            m,
            payee,
            amountWei
        );

        if (reason != PaymentIntentRegistry.RefusalReason.None) {
            registry.markRefused(intentId, reason);
            emit PaymentRefused(
                mandateId,
                intentId,
                payee,
                amountWei,
                registry.refusalReasonCode(reason)
            );
            return false;
        }

        // Effects first, then the registry mark, then the transfer.
        m.balance -= amountWei;
        m.spends.push(Spend({timestamp: uint64(block.timestamp), usdValue: usdValue}));
        registry.markExecuted(intentId);
        emit PaymentExecuted(mandateId, intentId, payee, amountWei, usdValue);

        (bool ok, ) = payee.call{value: amountWei}("");
        if (!ok) revert TransferFailed();
        return true;
    }

    // ------------------------------------------------------------ owner tools

    function pauseMandate(uint256 mandateId) external {
        Mandate storage m = _mandateOwned(mandateId);
        m.status = MandateStatus.Paused;
        emit MandatePaused(mandateId);
    }

    /// @notice Undo a pause. (Small addition to §3.1's list: a pause with no
    ///         resume would make Paused a slower Revoked.)
    function resumeMandate(uint256 mandateId) external {
        Mandate storage m = _mandateOwned(mandateId);
        if (m.status == MandateStatus.Paused) {
            m.status = MandateStatus.Active;
            emit MandateResumed(mandateId);
        }
    }

    /// @notice Revoke a mandate: instant and permanent (DESIGN.md §2).
    function revokeMandate(uint256 mandateId) external {
        Mandate storage m = _mandateOwned(mandateId);
        m.status = MandateStatus.Revoked;
        emit MandateRevoked(mandateId);
    }

    /// @notice Withdraw unspent funds. Owner only, and funds only ever go to
    ///         the owner — the agent can never withdraw (DESIGN.md §2).
    function withdrawUnspent(uint256 mandateId, uint256 amountWei) external nonReentrant {
        Mandate storage m = _mandateOwned(mandateId);
        if (amountWei == 0 || amountWei > m.balance) revert BadAmount();
        m.balance -= amountWei;
        emit Withdrawn(mandateId, m.owner, amountWei);
        (bool ok, ) = m.owner.call{value: amountWei}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------------ reads

    function getMandate(
        uint256 mandateId
    )
        external
        view
        returns (
            address owner,
            address agent,
            uint256 perTxCapUsd,
            uint256 dailyCapUsd,
            uint64 expiresAt,
            MandateStatus status,
            uint256 balance
        )
    {
        Mandate storage m = _mandate(mandateId);
        return (m.owner, m.agent, m.perTxCapUsd, m.dailyCapUsd, m.expiresAt, m.status, m.balance);
    }

    function isPayee(uint256 mandateId, address payee) external view returns (bool) {
        return _mandate(mandateId).isPayee[payee];
    }

    function payeeName(uint256 mandateId, address payee) external view returns (string memory) {
        return _mandate(mandateId).payeeNames[payee];
    }

    function getPayees(uint256 mandateId) external view returns (address[] memory) {
        return _mandate(mandateId).payeeList;
    }

    /// @notice USD value spent in the current rolling 24h window.
    function spentInWindow(uint256 mandateId) external view returns (uint256 total) {
        Mandate storage m = _mandate(mandateId);
        uint256 cutoff = block.timestamp > DAILY_WINDOW ? block.timestamp - DAILY_WINDOW : 0;
        for (uint256 i = m.spendHead; i < m.spends.length; i++) {
            if (m.spends[i].timestamp > cutoff) total += m.spends[i].usdValue;
        }
    }

    // --------------------------------------------------------------- internal

    function _mandate(uint256 mandateId) internal view returns (Mandate storage m) {
        if (mandateId == 0 || mandateId > mandateCount) revert UnknownMandate(mandateId);
        m = _mandates[mandateId];
    }

    function _mandateOwned(uint256 mandateId) internal view returns (Mandate storage m) {
        m = _mandate(mandateId);
        if (msg.sender != m.owner) revert NotOwner(mandateId);
    }

    /// @dev The mandate-rule checks, in DESIGN.md §3.1's order: mandate active
    ///      and unexpired → payee allowed → oracle USD value → per-tx cap →
    ///      daily cap → balance. Returns the first failing reason (or None)
    ///      and the converted USD value when conversion happened.
    function _evaluate(
        Mandate storage m,
        address payee,
        uint256 amountWei
    ) internal returns (PaymentIntentRegistry.RefusalReason reason, uint256 usdValue) {
        if (m.status == MandateStatus.Revoked) {
            return (PaymentIntentRegistry.RefusalReason.MandateRevoked, 0);
        }
        if (m.status == MandateStatus.Paused) {
            return (PaymentIntentRegistry.RefusalReason.MandatePaused, 0);
        }
        if (block.timestamp >= m.expiresAt) {
            return (PaymentIntentRegistry.RefusalReason.MandateExpired, 0);
        }
        if (!m.isPayee[payee]) {
            return (PaymentIntentRegistry.RefusalReason.PayeeNotAllowed, 0);
        }

        bool oracleOk;
        try oracleAdapter.isAvailable() returns (bool available) {
            oracleOk = available;
        } catch {
            oracleOk = false;
        }
        if (!oracleOk) {
            return (PaymentIntentRegistry.RefusalReason.OracleUnavailable, 0);
        }
        try oracleAdapter.usdValueOf(amountWei) returns (uint256 value) {
            usdValue = value;
        } catch {
            return (PaymentIntentRegistry.RefusalReason.OracleUnavailable, 0);
        }

        if (usdValue > m.perTxCapUsd) {
            return (PaymentIntentRegistry.RefusalReason.OverTxCap, usdValue);
        }
        if (_windowSpentAndPrune(m) + usdValue > m.dailyCapUsd) {
            return (PaymentIntentRegistry.RefusalReason.OverDailyCap, usdValue);
        }
        if (amountWei > m.balance) {
            return (PaymentIntentRegistry.RefusalReason.InsufficientBalance, usdValue);
        }
        return (PaymentIntentRegistry.RefusalReason.None, usdValue);
    }

    /// @dev Sum of USD spent inside the rolling 24h window; advances the head
    ///      pointer past spends that have aged out so the array stays short.
    function _windowSpentAndPrune(Mandate storage m) internal returns (uint256 total) {
        uint256 cutoff = block.timestamp > DAILY_WINDOW ? block.timestamp - DAILY_WINDOW : 0;
        uint256 head = m.spendHead;
        uint256 n = m.spends.length;
        while (head < n && m.spends[head].timestamp <= cutoff) {
            head++;
        }
        m.spendHead = head;
        for (uint256 i = head; i < n; i++) {
            total += m.spends[i].usdValue;
        }
    }
}
