export const SERVER_URL = (process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001").replace(/\/+$/, "");
/** Override to use a keyed RPC if the public endpoint rate-limits. */
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || undefined;
/** Optional second RPC, used when the primary still fails after its rate-limit retries. */
export const RPC_URL_FALLBACK = process.env.NEXT_PUBLIC_RPC_URL_FALLBACK || undefined;

/** Ethereum mainnet slot time, used only for the labeled speed comparison. */
export const ETHEREUM_BLOCK_TIME_MS = 12_000;
