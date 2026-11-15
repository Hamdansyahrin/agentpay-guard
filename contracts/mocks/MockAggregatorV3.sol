// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockAggregatorV3
/// @notice Test stand-in for a QIE Oracle AggregatorV3 feed. Round data is
///         fully settable — answer (incl. zero/negative), round completeness,
///         updatedAt — and the feed can be made to revert, so
///         OracleCapAdapter's fail-closed paths are exercisable in tests.
contract MockAggregatorV3 {
    uint8 public decimals;
    string public description = "MOCK / USD";
    uint256 public version = 1;

    uint80 public roundId;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public answeredInRound;
    bool public reverts;

    error FeedDown();

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        decimals = decimals_;
        roundId = 1;
        answeredInRound = 1;
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function setRound(
        uint80 roundId_,
        int256 answer_,
        uint256 updatedAt_,
        uint80 answeredInRound_
    ) external {
        roundId = roundId_;
        answer = answer_;
        updatedAt = updatedAt_;
        answeredInRound = answeredInRound_;
    }

    function setAnswer(int256 answer_) external {
        answer = answer_;
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        updatedAt = updatedAt_;
    }

    /// @notice Simulate a feed that has gone down entirely (calls revert).
    function setReverts(bool reverts_) external {
        reverts = reverts_;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        if (reverts) revert FeedDown();
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }

    function getRoundData(
        uint80 _roundId
    ) external view returns (uint80, int256, uint256, uint256, uint80) {
        if (reverts) revert FeedDown();
        return (_roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}
