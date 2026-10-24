import { getAddress, parseEther } from "viem";
import { SIP402_ADDRESS } from "@sip402/shared/monad";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see server/.env.example)`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  rpcUrl: process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz",
  contract: getAddress(process.env.CONTRACT_ADDRESS ?? SIP402_ADDRESS),
  provider: getAddress(required("PROVIDER_ADDRESS")),
  pricePerChunk: parseEther(process.env.PRICE_PER_CHUNK_MON ?? "0.01"),
  wordsPerChunk: Number(process.env.WORDS_PER_CHUNK ?? 10),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  /** How long a paused stream is kept without any payment before it is dropped. */
  streamIdleTimeoutMs: Number(process.env.STREAM_IDLE_TIMEOUT_MS ?? 5 * 60_000),
};
