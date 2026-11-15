// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IOracleCapAdapter.sol";

/// @title MockOracleCapAdapter
/// @notice Test/testnet stand-in for the real OracleCapAdapter (DESIGN.md
///         §3.3, Stage 3). The price is settable, and the feed can be made
///         unavailable or stale on demand so the vault's fail-closed path
///         (ORACLE_UNAVAILABLE) is exercisable end to end.
/// @dev When stale or unavailable, `usdValueOf` reverts AND `isAvailable`
///      returns false — the vault treats either signal as a refusal.
contract MockOracleCapAdapter is IOracleCapAdapter {
    address public owner;

    /// @notice USD per whole token, 18 decimals (e.g. $0.50 = 0.5e18).
    uint256 public priceUsdPerToken;
    bool public available = true;
    bool public stale;

    event PriceSet(uint256 priceUsdPerToken);
    event AvailabilitySet(bool available);
    event StaleSet(bool stale);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint256 initialPriceUsdPerToken) {
        owner = msg.sender;
        priceUsdPerToken = initialPriceUsdPerToken;
    }

    function setPrice(uint256 priceUsdPerToken_) external onlyOwner {
        priceUsdPerToken = priceUsdPerToken_;
        emit PriceSet(priceUsdPerToken_);
    }

    function setAvailable(bool available_) external onlyOwner {
        available = available_;
        emit AvailabilitySet(available_);
    }

    /// @notice Simulate a feed that has stopped updating (stale rounds).
    function setStale(bool stale_) external onlyOwner {
        stale = stale_;
        emit StaleSet(stale_);
    }

    function isAvailable() external view override returns (bool) {
        return available && !stale;
    }

    function usdValueOf(uint256 amountWei) external view override returns (uint256) {
        require(available && !stale, "MockOracle: price unavailable");
        return (amountWei * priceUsdPerToken) / 1e18;
    }
}
