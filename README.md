# Sip402

**Pay for AI by the sip.**

Sip402 streams an AI answer chunk by chunk and settles each chunk on Monad before the next one is sent. Stop at any moment and you only pay for what you read; the rest is refunded.

## How it works

1. **Open session** — the user deposits a spending cap and authorizes a temporary session key (one wallet popup).
2. **Stream** — the provider sends a chunk; the session key calls `pay()` and the chunk price goes to the provider.
3. **Verify** — the provider checks the `ChunkPaid` event on-chain, then sends the next chunk.
4. **Close** — on Stop or when the answer ends, `close()` refunds the unspent balance.

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
| `GET /stream/:token` | SSE: `chunk { index, text, total }`, then `done` |
| `POST /paid` `{ token, txHash }` | Verifies the `ChunkPaid` event for the current chunk, then releases the next one |

### Local end-to-end test

Runs the full flow against anvil without spending testnet MON:

```shell
anvil --chain-id 10143 --block-time 1
forge create src/Sip402.sol:Sip402 --rpc-url http://127.0.0.1:8545 --unlocked --from <anvil account 0> --broadcast
# in server/: start the server against anvil, then run the test
PROVIDER_ADDRESS=<anvil account 1> CONTRACT_ADDRESS=<local address> RPC_URL=http://127.0.0.1:8545 npx tsx src/index.ts
RPC_URL=http://127.0.0.1:8545 npx tsx scripts/e2e-local.ts            # full answer
STOP_AFTER=2 RPC_URL=http://127.0.0.1:8545 npx tsx scripts/e2e-local.ts  # stop and refund
```
