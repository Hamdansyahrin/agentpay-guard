// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Guarded Agent Badge (soulbound)
/// @notice A non-transferable ERC-721 badge minted by AgentPayGuard to every
///         address that completes Agent ID-gated registration. It is a
///         proof-of-registration marker, not a tradable asset.
/// @dev Hand-rolled minimal ERC-721 to keep deployment bytecode small.
///      All transfer/approval functions revert: the badge is soulbound.
///      The only privileged account is `guard` (the AgentPayGuard contract),
///      which can mint — once per address — and nothing else.
contract GuardBadge {
    string public constant name = "Guarded Agent";
    string public constant symbol = "GAGENT";

    /// @notice The AgentPayGuard contract; the only account allowed to mint.
    address public immutable guard;

    uint256 private _nextId = 1;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(address => bool) public hasBadge;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event BadgeMinted(address indexed to, uint256 indexed tokenId);

    error NotGuard();
    error AlreadyBadged();
    error Soulbound();
    error NonexistentToken();

    constructor(address guard_) {
        guard = guard_;
    }

    /// @notice Mint the badge to a newly registered Agent ID holder.
    /// @dev Guard-only. One badge per address, ever.
    function mint(address to) external returns (uint256 tokenId) {
        if (msg.sender != guard) revert NotGuard();
        if (hasBadge[to]) revert AlreadyBadged();
        tokenId = _nextId++;
        _owners[tokenId] = to;
        _balances[to] = 1;
        hasBadge[to] = true;
        emit Transfer(address(0), to, tokenId);
        emit BadgeMinted(to, tokenId);
    }

    function balanceOf(address owner_) external view returns (uint256) {
        return _balances[owner_];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _owners[tokenId];
        if (o == address(0)) revert NonexistentToken();
        return o;
    }

    /// @notice Static descriptive metadata; no external assets, no promises.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert NonexistentToken();
        return
            "data:application/json,{\"name\":\"Guarded Agent Badge\",\"description\":\"Soulbound badge: this address registered an agent identity with AgentPay Guard. It carries no monetary value and promises no returns.\"}";
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC165
            interfaceId == 0x80ac58cd || // ERC721
            interfaceId == 0x5b5e139f; // ERC721Metadata
    }

    // ---- Soulbound: every transfer / approval path reverts ----

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }
}
