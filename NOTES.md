# Notes

## Agent mode

`agent/agent-demo.ts` shows Sip402 as a protocol rather than a chat app: an autonomous agent pays an AI API per sip from the terminal. It reuses the web app's `SipSession` (open session, per-sip `pay()` with the tuned gas limits and fees, close + refund + sweep) and signs with its own key instead of a browser wallet.

### Setup

```shell
npm install
npm run agent -- --init        # creates agent/.env with a fresh AGENT_PRIVATE_KEY and prints the address
```

Fund the printed address with testnet MON. Each run needs about 0.2 MON on hand at the start (spending cap + gas allowance + open fee); almost all of it comes back through the refund and the sweep. A run costs roughly 0.05 to 0.13 MON net, depending on how many sips it pays.

The provider server must be running (`npm run server`).

### Run

```shell
npm run agent -- [--tier fast|smart|pro] [--sips 20] [--stop-when "<keyword>"] "<question>"
```

Example, stopping as soon as the answer mentions the keyword:

```shell
npm run agent -- --stop-when parallel "Why is Monad so fast?"
```

The agent pays for each sip it reads and logs one line per payment. When the streamed text contains the `--stop-when` keyword, it stops paying, closes the session and gets the unspent cap refunded. It also stops at the sip cap. A summary with deposit, provider payments, network fees, refund, net cost and MonadVision links ends the run.

### Environment (`agent/.env`, see `agent/.env.example`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_PRIVATE_KEY` | (required) | The agent's testnet wallet. Gitignored; never commit it. |
| `SIP402_SERVER_URL` | `http://localhost:3001` | Provider server |
| `RPC_URL` | `https://testnet-rpc.monad.xyz` | Monad RPC |

`npm run agent -- --address` prints the agent's address without running a session. If the wallet is underfunded, the agent prints the amount it needs and waits (up to 30 minutes) for the funds to arrive.
