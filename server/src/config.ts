import { getAddress, parseEther } from "viem";
import { SIP402_ADDRESS } from "@sip402/shared/monad";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see server/.env.example)`);
  return value;
}

export type PriceTier = { id: string; label: string; pricePerChunk: bigint };

/** PRICE_TIERS="id:Label:priceMON,...". The first tier is the default. */
function parseTiers(spec: string): PriceTier[] {
  const tiers = spec.split(",").map((entry) => {
    const [id, label, price] = entry.split(":").map((part) => part.trim());
    if (!id || !label || !price) throw new Error(`Invalid PRICE_TIERS entry "${entry}", expected id:Label:priceMON`);
    return { id, label, pricePerChunk: parseEther(price) };
  });
  if (new Set(tiers.map((t) => t.pricePerChunk)).size !== tiers.length) {
    throw new Error("PRICE_TIERS prices must be unique: the on-chain session price identifies the tier");
  }
  return tiers;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  rpcUrl: process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz",
  /** Optional second RPC, used when the primary still fails after its rate-limit retries. */
  rpcUrlFallback: process.env.RPC_URL_FALLBACK || undefined,
  contract: getAddress(process.env.CONTRACT_ADDRESS ?? SIP402_ADDRESS),
  provider: getAddress(required("PROVIDER_ADDRESS")),
  tiers: parseTiers(process.env.PRICE_TIERS ?? "fast:Fast:0.0001,smart:Smart:0.0003,pro:Pro:0.0005"),
  wordsPerChunk: Number(process.env.WORDS_PER_CHUNK ?? 10),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  /** How long a paused stream is kept without any payment before it is dropped. */
  streamIdleTimeoutMs: Number(process.env.STREAM_IDLE_TIMEOUT_MS ?? 5 * 60_000),
};
