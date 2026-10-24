# Deploy

The provider server runs on **Render** and the web app on **Vercel**. Both import `@sip402/shared`, an npm workspace package in `shared/` outside their folders, so both install from the **repo root** (`npm ci` there links the workspace packages). The contract is already deployed and verified; nothing to do on-chain.

Deploy the server first: the web build needs its URL.

## 1. Server on Render (Web Service)

| Setting | Value |
| --- | --- |
| Repository | `OmerAltundagX/Sip402`, branch `master` |
| Runtime | Node |
| Root Directory | *(leave empty: repo root)* |
| Build Command | `npm ci` |
| Start Command | `npm run start -w server` |
| Health Check Path | `/health` |

`npm run start -w server` runs `tsx src/index.ts` (tsx is a regular dependency, so it is installed even with `NODE_ENV=production`). It reads configuration only from environment variables; there is no `.env` file on Render.

### Render environment variables

| Name | Required | Value |
| --- | --- | --- |
| `NODE_VERSION` | yes | `20` |
| `PROVIDER_ADDRESS` | yes | Address that receives sip payments |
| `ALLOWED_ORIGINS` | yes | Vercel production URL, e.g. `https://sip402.vercel.app` (comma-separated for several; add `http://localhost:3000` for local testing) |
| `PRICE_TIERS` | no | Default `fast:Fast:0.0001,smart:Smart:0.0003,pro:Pro:0.0005` |
| `WORDS_PER_CHUNK` | no | Default `10` |
| `STREAM_IDLE_TIMEOUT_MS` | no | Default `300000` (5 min) |
| `RPC_URL` | no | Default `https://testnet-rpc.monad.xyz` |
| `RPC_URL_FALLBACK` | no | Second RPC, used when the primary still fails after rate-limit retries |
| `CONTRACT_ADDRESS` | no | Default is the deployed Sip402 contract |

Do not set `PORT`; Render provides it and the server listens on it.

Check: `https://<your-service>.onrender.com/health` returns `{"ok":true,...}` and `/info` lists the tiers.

SSE goes through Render's proxy unbuffered: the stream sends `text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, flushes headers immediately and pings every 15 s.

## 2. Web on Vercel

| Setting | Value |
| --- | --- |
| Framework Preset | Next.js |
| Root Directory | `web` |
| Include files outside the root directory in the Build Step | **On** (needed: install runs at the repo root and the build reads `shared/`) |
| Install Command | from `web/vercel.json`: `cd .. && npm ci` |
| Build Command | from `web/vercel.json`: `next build` |
| Output Directory | default (`.next`) |
| Node.js Version | 20.x (from `engines` in `web/package.json`) |

`web/next.config.ts` transpiles `@sip402/shared` and traces files from the repo root.

### Vercel environment variables

| Name | Required | Value |
| --- | --- | --- |
| `NEXT_PUBLIC_SERVER_URL` | yes | Render URL, e.g. `https://sip402-server.onrender.com` (no trailing slash needed) |
| `NEXT_PUBLIC_RPC_URL` | no | Keyed RPC for the browser |
| `NEXT_PUBLIC_RPC_URL_FALLBACK` | no | Second RPC for the browser |

`NEXT_PUBLIC_*` values are baked in at build time: after changing one, redeploy.

## 3. Connect them

1. Deploy Render, copy its URL.
2. Deploy Vercel with `NEXT_PUBLIC_SERVER_URL` set to that URL, copy the Vercel production URL.
3. Set `ALLOWED_ORIGINS` on Render to the Vercel production URL (Render restarts automatically).
4. Open the Vercel URL, connect the wallet, ask a question.

## Gotchas

- **Cold starts**: Render's free tier sleeps after ~15 minutes idle; the first request can take up to a minute. Open `/health` before a demo.
- **Preview URLs**: Vercel preview deployments have their own URLs, which are not in `ALLOWED_ORIGINS`. Use the production URL, or add the preview URL.
- **One instance**: streams live in server memory. Keep the Render service at one instance.
- **Rate limits**: the public Monad RPC allows ~15 `eth_call`/s per IP. Server and browser retry with backoff; for heavier use set `RPC_URL` / `NEXT_PUBLIC_RPC_URL` to a keyed RPC.

## Verified

From a clean clone, the way each platform runs it:

- Render: `NODE_ENV=production npm ci` at the repo root, then `npm run start -w server` with env vars only; `/health`, `/info`, CORS (allowed and rejected origins, `POST /ask` preflight) and SSE headers checked.
- Vercel: `cd web`, `cd .. && npm ci`, `NEXT_PUBLIC_SERVER_URL=… next build`; all pages prerender and the server URL is in the client bundle.
