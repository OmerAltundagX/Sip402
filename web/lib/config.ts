export const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3001";
/** Override to use a keyed RPC if the public endpoint rate-limits. */
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || undefined;

/** Ethereum mainnet slot time, used only for the labeled speed comparison. */
export const ETHEREUM_BLOCK_TIME_MS = 12_000;
