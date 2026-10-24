# Sip402

**Pay for AI by the sip.**

Sip402 streams an AI answer chunk by chunk and settles each chunk on Monad before the next one is sent. Pause or cancel at any moment and you only pay for what you read; the rest is refunded.

## How it works

1. **Open session** — the user deposits a spending cap and authorizes a temporary session key (one wallet popup).
2. **Stream** — the provider sends a chunk; the session key calls `pay()` and the chunk price goes to the provider.
3. **Verify** — the provider checks the `ChunkPaid` event on-chain, then sends the next chunk.
4. **Close** — on Cancel or when the answer ends, `close()` refunds the unspent balance.

While streaming you can **Pause** (no further payments; the session stays open on-chain), **Resume** (continue the same answer, no wallet popup) or **Cancel** (close, refund and return the unused gas allowance).

Each side's risk is capped at one chunk.

## Contract

`Sip402` on Monad Testnet (chain 10143): [`0x0654aB49C0AF16c0E660E84A8A879e497095a6D8`](https://testnet.monadvision.com/address/0x0654aB49C0AF16c0E660E84A8A879e497095a6D8) (verified)

```shell
forge test
forge script script/Deploy.s.sol --rpc-url monad --account <keystore> --broadcast
./script/export-abi.sh   # regenerates shared/sip402Abi.ts after contract changes
```

## Repository layout

| Path | What |
| --- | --- |
| `src/`, `test/`, `script/` | Foundry contract, tests, deploy script |
| `shared/` | Chain config, gas limits, ABI and protocol shared by server and web |
| `server/` | Provider: Node + Express, streams chunks over SSE, verifies payments on-chain |
| `web/` | Next.js + viem frontend |

## Provider server

```shell
npm install
cp server/.env.example server/.env   # set PROVIDER_ADDRESS
npm run server
```

| Endpoint | Purpose |
| --- | --- |
| `GET /info` | Contract, provider address and price per chunk |
| `POST /ask` `{ sessionId, prompt, signature }` | Checks the session on-chain and the session key's signature, returns a stream token |
| `GET /stream/:token` | SSE: `chunk { index, text, total }`, then `done`; `expired` if dropped for inactivity. Reconnecting replays delivered chunks |
| `POST /paid` `{ token, txHash }` | Verifies the `ChunkPaid` event for the current chunk, then releases the next one |
| `POST /end` `{ token }` | Client is done with the stream |

A paused stream is kept for `STREAM_IDLE_TIMEOUT_MS` (default 5 minutes) without a payment, then dropped. The deposit stays safe in the contract; the client offers Cancel to close the session and get the refund.

## Web app

```shell
npm run server   # terminal 1
npm run web      # terminal 2, then open http://localhost:3000
```

Connect an injected wallet (MetaMask, Rabby etc.), pick a question and a spending cap, and press **Ask**. Use **Pause**, **Resume** and **Cancel** while it streams. The wallet signs only `openSession`; an in-memory session key signs every `pay()`, the `close()` and a final sweep that returns the unused gas allowance. Live metrics show measured send-to-receipt time on Monad next to a labeled 12 s-per-block Ethereum estimate.

Monad specifics handled in `web/lib/session.ts`:

- **Gas limit billing**: `pay()` and `close()` gas is estimated per session (+10%), because Monad prices cold storage per page and a session whose slots straddle a page boundary costs 8,000 more gas. `shared/monad.ts` holds the worst-case fallbacks.
- **Reserve balance rule**: the session key waits 3 blocks after being funded before its first `pay()`, and 3 blocks after `close()` before sweeping its leftover balance.
- **Latency**: payments use `eth_sendRawTransactionSync`, which returns the receipt in one round trip, with a fallback to send and poll.
- **Nonces**: one payment in flight at a time, with a local nonce counter that is resynced from the chain on errors.

### Local end-to-end test

Runs every case against a local anvil chain (chain ID 10143, so anvil applies Monad's gas rules) without spending testnet MON. It starts anvil and the provider server on port 3901 and cleans up afterwards:

```shell
./script/e2e-local.sh
```

Cases: full answer, cancel after n payments, cancel while a payment is in flight, spending cap reached, a session whose storage straddles a page boundary, pause then resume, pause then cancel, and the paused-stream idle timeout (with a 3 s timeout).
