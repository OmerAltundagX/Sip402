import { fallback, http, type Transport } from "viem";

/**
 * The public Monad testnet RPC limits eth_call to ~15 requests/s per IP. The excess
 * gets HTTP 429 with a JSON-RPC error body (code -32011, "requests limited to
 * 15/sec"). viem parses the body first, sees code -32011 instead of status 429 and
 * does not retry it, so rate-limit errors are retried here: exponential backoff
 * from 200 ms (200, 400, 800, 1600, 3200 ms, about 6 s in total) with jitter so a
 * burst of requests does not retry in lockstep.
 */
export const RPC_RETRY = { retryCount: 5, retryDelay: 200 } as const;

const RATE_LIMITED = /requests limited|rate limit|too many requests/i;

/** True if the error, or anything in its cause chain, is an RPC rate-limit rejection. */
export function isRateLimited(err: unknown): boolean {
  for (let e = err as { code?: unknown; status?: unknown; message?: string; details?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === -32011 || e.code === 429 || e.status === 429) return true;
    if (RATE_LIMITED.test(`${e.details ?? ""} ${e.message ?? ""}`)) return true;
  }
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** viem's http transport (which still retries 5xx and network errors) plus rate-limit retries. */
function rateLimitedHttp(url: string | undefined): Transport {
  const base = http(url, RPC_RETRY);
  return (params) => {
    const transport = base(params);
    return {
      ...transport,
      async request(args, opts) {
        for (let attempt = 0; ; attempt++) {
          try {
            return await transport.request(args, opts);
          } catch (err) {
            if (attempt >= RPC_RETRY.retryCount || !isRateLimited(err)) throw err;
            const backoff = (1 << attempt) * RPC_RETRY.retryDelay;
            await sleep(backoff * (0.75 + Math.random() * 0.5));
          }
        }
      },
    } as ReturnType<Transport>;
  };
}

/**
 * HTTP transport with rate-limit retries, and an optional fallback RPC that takes
 * over when the primary still fails after its retries.
 */
export function rpcTransport(url?: string, fallbackUrl?: string): Transport {
  const primary = rateLimitedHttp(url);
  if (!fallbackUrl) return primary;
  return fallback([primary, rateLimitedHttp(fallbackUrl)]);
}
