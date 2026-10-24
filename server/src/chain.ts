import { createPublicClient, http, parseEventLogs, type Address, type Hash } from "viem";
import { monadTestnet } from "@sip402/shared/monad";
import { sip402Abi } from "@sip402/shared/sip402Abi";
import { config } from "./config";

export const client = createPublicClient({
  chain: monadTestnet,
  transport: http(config.rpcUrl),
  pollingInterval: 50,
});

export type OnchainSession = {
  payer: Address;
  provider: Address;
  sessionKey: Address;
  pricePerChunk: bigint;
  deposit: bigint;
  chunksPaid: bigint;
  open: boolean;
};

export async function readSession(sessionId: bigint): Promise<OnchainSession> {
  const [payer, pricePerChunk, provider, deposit, sessionKey, chunksPaid, open] = await client.readContract({
    address: config.contract,
    abi: sip402Abi,
    functionName: "sessions",
    args: [sessionId],
  });
  return { payer, provider, sessionKey, pricePerChunk, deposit, chunksPaid, open };
}

export type PaymentCheck = { ok: true; blockNumber: bigint } | { ok: false; reason: string };

/** Confirms that txHash is a successful pay() for exactly this session and chunk. */
export async function verifyChunkPayment(txHash: Hash, sessionId: bigint, expectedIndex: number): Promise<PaymentCheck> {
  // The payer already waited for the receipt, so it is usually available on the first call.
  const receipt = await client
    .getTransactionReceipt({ hash: txHash })
    .catch(() => client.waitForTransactionReceipt({ hash: txHash, pollingInterval: 50, timeout: 10_000 }))
    .catch(() => null);

  if (!receipt) return { ok: false, reason: "transaction not found" };
  if (receipt.status !== "success") return { ok: false, reason: "transaction reverted" };
  if (receipt.to?.toLowerCase() !== config.contract.toLowerCase()) {
    return { ok: false, reason: "transaction is not to the Sip402 contract" };
  }

  const paid = parseEventLogs({ abi: sip402Abi, logs: receipt.logs, eventName: "ChunkPaid" }).find(
    (log) =>
      log.address.toLowerCase() === config.contract.toLowerCase() &&
      log.args.sessionId === sessionId &&
      log.args.chunkIndex === BigInt(expectedIndex),
  );
  if (!paid) return { ok: false, reason: `no ChunkPaid event for chunk ${expectedIndex}` };
  if (paid.args.amount < config.pricePerChunk) return { ok: false, reason: "payment below chunk price" };

  return { ok: true, blockNumber: receipt.blockNumber };
}
