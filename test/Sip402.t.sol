// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Sip402} from "../src/Sip402.sol";

contract RejectsEther {
    receive() external payable {
        revert();
    }
}

contract Sip402Test is Test {
    Sip402 sip;

    address payer = makeAddr("payer");
    address provider = makeAddr("provider");
    address sessionKey = makeAddr("sessionKey");
    address stranger = makeAddr("stranger");

    uint256 constant PRICE = 0.001 ether;
    uint256 constant CAP = 0.1 ether;
    uint256 constant GAS_ALLOWANCE = 0.01 ether;

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

    function setUp() public {
        sip = new Sip402();
        vm.deal(payer, 10 ether);
    }

    function _open() internal returns (uint256) {
        vm.prank(payer);
        return sip.openSession{value: CAP + GAS_ALLOWANCE}(provider, PRICE, sessionKey, GAS_ALLOWANCE);
    }

    function _pay(uint256 id, uint256 times) internal {
        for (uint256 i; i < times; i++) {
            vm.prank(sessionKey);
            sip.pay(id);
        }
    }

    // ---------- openSession ----------

    function test_openSession_storesSessionAndForwardsGasAllowance() public {
        vm.expectEmit(address(sip));
        emit SessionOpened(1, payer, provider, sessionKey, PRICE, CAP);
        uint256 id = _open();

        assertEq(id, 1);
        assertEq(sip.nextSessionId(), 2);
        (address p, uint96 price, address prov, uint96 deposit, address key, uint64 paid, bool open) = sip.sessions(id);
        assertEq(p, payer);
        assertEq(price, PRICE);
        assertEq(prov, provider);
        assertEq(deposit, CAP);
        assertEq(key, sessionKey);
        assertEq(paid, 0);
        assertTrue(open);

        assertEq(sessionKey.balance, GAS_ALLOWANCE);
        assertEq(address(sip).balance, CAP);
        assertEq(sip.remaining(id), CAP);
    }

    function test_openSession_zeroGasAllowance() public {
        vm.prank(payer);
        uint256 id = sip.openSession{value: CAP}(provider, PRICE, sessionKey, 0);
        assertEq(sessionKey.balance, 0);
        assertEq(sip.remaining(id), CAP);
    }

    function test_openSession_incrementsIds() public {
        assertEq(_open(), 1);
        assertEq(_open(), 2);
    }

    function test_openSession_revertsOnInvalidParams() public {
        vm.startPrank(payer);

        vm.expectRevert(Sip402.InvalidParams.selector);
        sip.openSession{value: CAP}(address(0), PRICE, sessionKey, 0);

        vm.expectRevert(Sip402.InvalidParams.selector);
        sip.openSession{value: CAP}(provider, PRICE, address(0), 0);

        vm.expectRevert(Sip402.InvalidParams.selector);
        sip.openSession{value: CAP}(provider, 0, sessionKey, 0);

        // Value does not exceed the gas allowance.
        vm.expectRevert(Sip402.InvalidParams.selector);
        sip.openSession{value: GAS_ALLOWANCE}(provider, PRICE, sessionKey, GAS_ALLOWANCE);

        // Deposit smaller than one chunk.
        vm.expectRevert(Sip402.InvalidParams.selector);
        sip.openSession{value: PRICE - 1}(provider, PRICE, sessionKey, 0);

        vm.stopPrank();
    }

    function test_openSession_revertsIfSessionKeyRejectsGasAllowance() public {
        address badKey = address(new RejectsEther());
        vm.prank(payer);
        vm.expectRevert(Sip402.TransferFailed.selector);
        sip.openSession{value: CAP + GAS_ALLOWANCE}(provider, PRICE, badKey, GAS_ALLOWANCE);
    }

    // ---------- pay ----------

    function test_pay_transfersPriceToProvider() public {
        uint256 id = _open();

        vm.expectEmit(address(sip));
        emit ChunkPaid(id, 0, PRICE);
        _pay(id, 1);

        vm.expectEmit(address(sip));
        emit ChunkPaid(id, 1, PRICE);
        _pay(id, 1);

        assertEq(provider.balance, 2 * PRICE);
        assertEq(sip.remaining(id), CAP - 2 * PRICE);
        (,,,,, uint64 paid,) = sip.sessions(id);
        assertEq(paid, 2);
    }

    function test_pay_revertsIfNotSessionKey() public {
        uint256 id = _open();

        vm.prank(payer);
        vm.expectRevert(Sip402.NotSessionKey.selector);
        sip.pay(id);

        vm.prank(stranger);
        vm.expectRevert(Sip402.NotSessionKey.selector);
        sip.pay(id);
    }

    function test_pay_revertsForUnknownSession() public {
        vm.prank(sessionKey);
        vm.expectRevert(Sip402.NotSessionKey.selector);
        sip.pay(42);
    }

    function test_pay_revertsWhenCapExhausted() public {
        uint256 id = _open();
        _pay(id, CAP / PRICE);
        assertEq(sip.remaining(id), 0);

        vm.prank(sessionKey);
        vm.expectRevert(Sip402.InsufficientBalance.selector);
        sip.pay(id);
    }

    function test_pay_revertsAfterClose() public {
        uint256 id = _open();
        vm.prank(sessionKey);
        sip.close(id);

        vm.prank(sessionKey);
        vm.expectRevert(Sip402.SessionNotOpen.selector);
        sip.pay(id);
    }

    function test_pay_revertsIfProviderRejectsPayment() public {
        address badProvider = address(new RejectsEther());
        vm.prank(payer);
        uint256 id = sip.openSession{value: CAP}(badProvider, PRICE, sessionKey, 0);

        vm.prank(sessionKey);
        vm.expectRevert(Sip402.TransferFailed.selector);
        sip.pay(id);
    }

    // ---------- close ----------

    function test_close_bySessionKeyRefundsPayer() public {
        uint256 id = _open();
        _pay(id, 3);
        uint256 payerBefore = payer.balance;
        uint256 expectedRefund = CAP - 3 * PRICE;

        vm.expectEmit(address(sip));
        emit SessionClosed(id, 3, expectedRefund);
        vm.prank(sessionKey);
        sip.close(id);

        assertEq(payer.balance, payerBefore + expectedRefund);
        assertEq(address(sip).balance, 0);
        (,,,,,, bool open) = sip.sessions(id);
        assertFalse(open);
    }

    function test_close_byPayer() public {
        uint256 id = _open();
        uint256 payerBefore = payer.balance;

        vm.prank(payer);
        sip.close(id);

        assertEq(payer.balance, payerBefore + CAP);
    }

    function test_close_withNothingLeft() public {
        uint256 id = _open();
        _pay(id, CAP / PRICE);

        vm.expectEmit(address(sip));
        emit SessionClosed(id, CAP / PRICE, 0);
        vm.prank(sessionKey);
        sip.close(id);
    }

    function test_close_revertsIfNotAuthorized() public {
        uint256 id = _open();

        vm.prank(stranger);
        vm.expectRevert(Sip402.NotAuthorized.selector);
        sip.close(id);

        vm.prank(provider);
        vm.expectRevert(Sip402.NotAuthorized.selector);
        sip.close(id);
    }

    function test_close_revertsWhenAlreadyClosed() public {
        uint256 id = _open();
        vm.prank(payer);
        sip.close(id);

        vm.prank(payer);
        vm.expectRevert(Sip402.SessionNotOpen.selector);
        sip.close(id);
    }

    // ---------- invariants ----------

    function testFuzz_paymentsPlusRefundEqualDeposit(uint96 price, uint96 deposit, uint8 chunks) public {
        price = uint96(bound(price, 1, 1 ether));
        deposit = uint96(bound(deposit, price, 5 ether));
        uint256 n = bound(chunks, 0, deposit / price);
        vm.deal(payer, deposit);

        vm.prank(payer);
        uint256 id = sip.openSession{value: deposit}(provider, price, sessionKey, 0);
        _pay(id, n);
        vm.prank(sessionKey);
        sip.close(id);

        assertEq(provider.balance, n * price);
        assertEq(payer.balance, deposit - n * price);
        assertEq(provider.balance + payer.balance, deposit);
        assertEq(address(sip).balance, 0);
    }
}
