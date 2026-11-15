// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IOracleCapAdapter.sol";
import "./interfaces/AggregatorV3Interface.sol";

/// @title OracleCapAdapter
/// @notice The real cap adapter (DESIGN.md §3.3): wraps the QIE Oracle's
///         QIE/USD feed and converts native-QIE amounts to 18-decimal USD
///         values for AgentVault's cap checks.
/// @dev Fail-closed by construction. A price is trustworthy only when ALL of
///      these hold: the feed call succeeds, the round is complete
///      (answeredInRound >= roundId > 0), the answer is positive, and the
///      round's updatedAt is neither zero, in the future, nor older than
///      `maxStaleness`. Anything else makes `isAvailable` false and
///      `usdValueOf` revert, which AgentVault records as ORACLE_UNAVAILABLE.
///
///      Feed facts (probed read-only, 2026-11-15):
///      - QIE mainnet (1990): 0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17 is a
///        live AggregatorV3 feed, decimals 8, description "QIE / USDT".
///        Its QIE rounds update on a multi-hour cadence (a ~5.9h-old round
///        was observed while the ETH feed's was ~39min old), so the staleness
///        bound must be generous; mainnet deployments use 24h.
///      - QIE testnet (1983): NO oracle feed exists at the documented
///        addresses (eth_getCode is empty there). This adapter deployed on
///        testnet therefore reports unavailable and every payment is refused
///        ORACLE_UNAVAILABLE — the intended fail-closed behaviour until QIE
///        ships a testnet feed. Testnet execution demos keep using the mock
///        adapter; the real one is wired live at the mainnet stage.
///
///      `feed` and `maxStaleness` are immutable on purpose: if the cadence
///      or the feed changes, deploy a fresh adapter and point the vault at
///      it via AgentVault.setOracleAdapter (the vault admin's one power).
contract OracleCapAdapter is IOracleCapAdapter {
    AggregatorV3Interface public immutable feed;
    /// @notice Maximum accepted age of a feed round, in seconds.
    uint256 public immutable maxStaleness;

    error BadAdapterParams();
    error PriceUnavailable();

    constructor(address feed_, uint256 maxStaleness_) {
        if (feed_ == address(0) || maxStaleness_ == 0) revert BadAdapterParams();
        feed = AggregatorV3Interface(feed_);
        maxStaleness = maxStaleness_;
    }

    /// @inheritdoc IOracleCapAdapter
    function isAvailable() external view override returns (bool) {
        (bool ok, , ) = _readFeed();
        return ok;
    }

    /// @inheritdoc IOracleCapAdapter
    /// @dev USD value with 18 decimals: amountWei (18-dec token) scaled by
    ///      the feed answer and normalised by the feed's own decimals —
    ///      read live from the feed, never assumed (the QIE feed uses 8).
    function usdValueOf(uint256 amountWei) external view override returns (uint256) {
        (bool ok, int256 answer, uint8 feedDecimals) = _readFeed();
        if (!ok) revert PriceUnavailable();
        return (amountWei * uint256(answer)) / (10 ** uint256(feedDecimals));
    }

    /// @dev Single fail-closed read of the feed. Every failure mode —
    ///      reverting feed, missing contract (testnet), incomplete round,
    ///      non-positive answer, zero/future/stale updatedAt — returns
    ///      ok = false instead of propagating partial data.
    function _readFeed()
        internal
        view
        returns (bool ok, int256 answer, uint8 feedDecimals)
    {
        uint80 roundId;
        uint256 updatedAt;
        uint80 answeredInRound;
        try feed.latestRoundData() returns (
            uint80 roundId_,
            int256 answer_,
            uint256,
            uint256 updatedAt_,
            uint80 answeredInRound_
        ) {
            roundId = roundId_;
            answer = answer_;
            updatedAt = updatedAt_;
            answeredInRound = answeredInRound_;
        } catch {
            return (false, 0, 0);
        }

        if (roundId == 0 || answeredInRound < roundId) return (false, 0, 0);
        if (answer <= 0) return (false, 0, 0);
        if (updatedAt == 0 || updatedAt > block.timestamp) return (false, 0, 0);
        if (block.timestamp - updatedAt > maxStaleness) return (false, 0, 0);

        try feed.decimals() returns (uint8 d) {
            feedDecimals = d;
        } catch {
            return (false, 0, 0);
        }
        return (true, answer, feedDecimals);
    }
}
