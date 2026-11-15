// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AggregatorV3Interface
/// @notice The Chainlink-style price-feed interface the QIE Oracle exposes
///         (QIE Docs, "QIE Oracle"). Verified live on QIE mainnet
///         2026-11-15 against the QIE/USD feed
///         0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17: decimals() = 8,
///         description() = "QIE / USDT", version() = 1, latestRoundData()
///         returns live rounds. The legacy latestAnswer()/latestTimestamp()
///         helpers REVERT on that feed, so consumers must use
///         latestRoundData() only — as this interface's consumer does.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function version() external view returns (uint256);

    function getRoundData(
        uint80 _roundId
    )
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
