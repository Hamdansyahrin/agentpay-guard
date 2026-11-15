// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IOracleCapAdapter
/// @notice Converts a native-token amount into its USD value for cap checks
///         (DESIGN.md §3.3). The real implementation wraps the QIE Oracle's
///         QIE/USD feed; tests and the testnet deployment use a mock.
/// @dev USD values use 18 decimals of precision everywhere in AgentPay Guard:
///      $5.00 is `5e18`. Implementations must fail closed — when the price
///      cannot be trusted, `isAvailable` returns false and/or `usdValueOf`
///      reverts, and AgentVault refuses the payment as ORACLE_UNAVAILABLE.
interface IOracleCapAdapter {
    /// @notice USD value (18 decimals) of `amountWei` of the native token.
    function usdValueOf(uint256 amountWei) external view returns (uint256 usdValue);

    /// @notice True when the adapter can currently produce a trustworthy price.
    function isAvailable() external view returns (bool);
}
