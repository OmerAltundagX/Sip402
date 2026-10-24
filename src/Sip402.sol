// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Sip402
/// @notice Pay for content by the chunk. A payer escrows a spending cap and
///         authorizes a temporary session key. Each pay() call releases one
///         chunk price to the provider; close() refunds the unspent balance.
contract Sip402 {
    /// @dev Packed into three slots. pay() only writes the slot holding
    ///      chunksPaid; the remaining balance is derived from it.
    struct Session {
        address payer;
        uint96 pricePerChunk;
        address provider;
        uint96 deposit;
        address sessionKey;
        uint64 chunksPaid;
        bool open;
    }

    uint256 public nextSessionId = 1;
    mapping(uint256 => Session) public sessions;

    event SessionOpened(
        uint256 indexed sessionId,
        address indexed payer,
        address indexed provider,
        address sessionKey,
        uint256 pricePerChunk,
        uint256 deposit
    );
    event ChunkPaid(uint256 indexed sessionId, uint256 chunkIndex, uint256 amount);
    event SessionClosed(uint256 indexed sessionId, uint256 chunksPaid, uint256 refund);

    error InvalidParams();
    error NotSessionKey();
    error NotAuthorized();
    error SessionNotOpen();
    error InsufficientBalance();
    error TransferFailed();

    /// @notice Opens a session. msg.value covers the spending cap plus a gas
    ///         allowance that is forwarded to the session key so it can send
    ///         pay() and close() transactions without the payer's wallet.
    /// @return sessionId The id of the new session.
    function openSession(address provider, uint256 pricePerChunk, address sessionKey, uint256 gasAllowance)
        external
        payable
        returns (uint256 sessionId)
    {
        if (provider == address(0) || sessionKey == address(0) || pricePerChunk == 0) revert InvalidParams();
        if (msg.value <= gasAllowance) revert InvalidParams();
        uint256 deposit = msg.value - gasAllowance;
        if (deposit < pricePerChunk || deposit > type(uint96).max) revert InvalidParams();

        sessionId = nextSessionId++;
        // Both casts are safe: pricePerChunk <= deposit <= type(uint96).max.
        sessions[sessionId] = Session({
            payer: msg.sender,
            // forge-lint: disable-next-line(unsafe-typecast)
            pricePerChunk: uint96(pricePerChunk),
            provider: provider,
            // forge-lint: disable-next-line(unsafe-typecast)
            deposit: uint96(deposit),
            sessionKey: sessionKey,
            chunksPaid: 0,
            open: true
        });

        emit SessionOpened(sessionId, msg.sender, provider, sessionKey, pricePerChunk, deposit);

        if (gasAllowance > 0) _send(sessionKey, gasAllowance);
    }

    /// @notice Pays the provider for one chunk. Only the session key may call.
    function pay(uint256 sessionId) external {
        Session storage s = sessions[sessionId];
        if (msg.sender != s.sessionKey) revert NotSessionKey();
        if (!s.open) revert SessionNotOpen();

        uint256 chunkIndex = s.chunksPaid;
        uint256 price = s.pricePerChunk;
        if ((chunkIndex + 1) * price > s.deposit) revert InsufficientBalance();

        // Overflowing uint64 would take ~1.8e19 pay() transactions.
        // forge-lint: disable-next-line(unsafe-typecast)
        s.chunksPaid = uint64(chunkIndex + 1);
        emit ChunkPaid(sessionId, chunkIndex, price);

        _send(s.provider, price);
    }

    /// @notice Closes the session and refunds the unspent balance to the payer.
    ///         Callable by the payer or the session key.
    function close(uint256 sessionId) external {
        Session storage s = sessions[sessionId];
        if (msg.sender != s.payer && msg.sender != s.sessionKey) revert NotAuthorized();
        if (!s.open) revert SessionNotOpen();

        s.open = false;
        uint256 refund = remaining(sessionId);
        emit SessionClosed(sessionId, s.chunksPaid, refund);

        if (refund > 0) _send(s.payer, refund);
    }

    /// @notice Unspent balance of a session.
    function remaining(uint256 sessionId) public view returns (uint256) {
        Session storage s = sessions[sessionId];
        return uint256(s.deposit) - uint256(s.chunksPaid) * s.pricePerChunk;
    }

    function _send(address to, uint256 amount) private {
        // forge-lint: disable-next-line(arbitrary-send-eth)
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
