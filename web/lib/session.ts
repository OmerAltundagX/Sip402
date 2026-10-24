import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hash,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { GAS_LIMITS, monadTestnet } from "@sip402/shared/monad";
import { askMessage } from "@sip402/shared/protocol";
import { sip402Abi } from "@sip402/shared/sip402Abi";
import { RPC_URL, SERVER_URL } from "./config";

/** Monad's reserve-balance rule looks back this many blocks. */
const RESERVE_LAG_BLOCKS = 3n;
const TRANSFER_GAS = 21_000n;

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(RPC_URL),
  pollingInterval: 50,
});

export type ProviderInfo = { contract: Address; provider: Address; pricePerChunk: bigint };

export type Phase = "idle" | "opening" | "warming" | "streaming" | "closing" | "sweeping" | "done" | "error";

export type Payment = {
  index: number;
  hash: Hash;
  /** Send to receipt, measured in the browser. */
  confirmMs: number;
  /** Provider's on-chain check before releasing the next chunk. */
  verifyMs: number;
  /** gasUsed × effectiveGasPrice from the receipt. */
  feeWei: bigint;
  priceWei: bigint;
};

export type SessionEvents = {
  onPhase: (phase: Phase, detail?: string) => void;
  onOpened: (info: { sessionId: bigint; hash: Hash; sessionKey: Address; maxChunks: number; gasAllowanceWei: bigint }) => void;
  onChunk: (chunk: { index: number; text: string; total: number }) => void;
  onPayment: (payment: Payment) => void;
  onClosed: (info: { hash: Hash; chunksPaid: number; refundWei: bigint; reason: string }) => void;
  onSwept: (info: { hash: Hash; amountWei: bigint } | null) => void;
  onError: (message: string) => void;
};

export async function fetchProviderInfo(): Promise<ProviderInfo> {
  const res = await fetch(`${SERVER_URL}/info`);
  if (!res.ok) throw new Error(`Provider server returned ${res.status}`);
  const body = await res.json();
  return { contract: body.contract, provider: body.provider, pricePerChunk: BigInt(body.pricePerChunk) };
}

async function waitForBlock(target: bigint) {
  while ((await publicClient.getBlockNumber({ cacheTime: 0 })) < target) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const errorMessage = (err: unknown) =>
  err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err);

const isUnsupportedMethod = (err: unknown) =>
  err instanceof Error &&
  /MethodNotFound|MethodNotSupported|method not found|not supported|does not exist|not available/i.test(
    `${err.name} ${err.message}`,
  );

/**
 * One paid streaming session. The payer's wallet signs only openSession; every
 * pay(), close() and the final sweep are signed by an in-memory session key.
 */
export class SipSession {
  private readonly sessionKey = privateKeyToAccount(generatePrivateKey());
  private readonly keyWallet = createWalletClient({ chain: monadTestnet, transport: http(RPC_URL), account: this.sessionKey });
  private sessionId = 0n;
  private token = "";
  private nonce = 0;
  private maxChunks = 0;
  private paid = 0;
  private fees = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n };
  private providerEmpty = false;
  private syncSendSupported = true;
  private source?: EventSource;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private finished?: Promise<void>;

  constructor(
    private readonly wallet: WalletClient,
    private readonly payer: Address,
    private readonly info: ProviderInfo,
    private readonly events: SessionEvents,
  ) {}

  async start(prompt: string, capWei: bigint) {
    try {
      await this.open(capWei);
      await this.stream(prompt);
    } catch (err) {
      this.fail(err);
    }
  }

  /** User pressed Stop: finish the in-flight payment, then close and refund. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.source?.close();
    void this.queue.then(() => this.finish("stopped by user"));
  }

  private async open(capWei: bigint) {
    this.events.onPhase("opening", "Confirm the session in your wallet");
    const block = await publicClient.getBlock();
    const priority = await publicClient.estimateMaxPriorityFeePerGas();
    this.fees = { maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + priority, maxPriorityFeePerGas: priority };
    this.providerEmpty = (await publicClient.getBalance({ address: this.info.provider })) === 0n;

    // Gas budget for every possible pay(), the close() and the sweep. Leftovers are swept back.
    this.maxChunks = Number(capWei / this.info.pricePerChunk);
    const gasUnits =
      BigInt(this.maxChunks) * GAS_LIMITS.pay +
      (GAS_LIMITS.payFirstToEmptyProvider - GAS_LIMITS.pay) +
      GAS_LIMITS.close +
      TRANSFER_GAS;
    const gasAllowance = gasUnits * this.fees.maxFeePerGas;

    const hash = await this.wallet.writeContract({
      account: this.payer,
      chain: monadTestnet,
      address: this.info.contract,
      abi: sip402Abi,
      functionName: "openSession",
      args: [this.info.provider, this.info.pricePerChunk, this.sessionKey.address, gasAllowance],
      value: capWei + gasAllowance,
      gas: GAS_LIMITS.openSession,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("openSession reverted");
    const [opened] = parseEventLogs({ abi: sip402Abi, logs: receipt.logs, eventName: "SessionOpened" });
    this.sessionId = opened.args.sessionId;
    this.events.onOpened({
      sessionId: this.sessionId,
      hash,
      sessionKey: this.sessionKey.address,
      maxChunks: this.maxChunks,
      gasAllowanceWei: gasAllowance,
    });

    // Consensus checks gas against a balance lagged by a few blocks, so a freshly
    // funded session key must wait before its first transaction.
    this.events.onPhase("warming", "Letting the session key's gas allowance settle (~3 blocks)");
    await waitForBlock(receipt.blockNumber + RESERVE_LAG_BLOCKS);
    this.nonce = await publicClient.getTransactionCount({ address: this.sessionKey.address, blockTag: "pending" });
  }

  private async stream(prompt: string) {
    const sessionId = this.sessionId.toString();
    const signature = await this.sessionKey.signMessage({ message: askMessage(sessionId, prompt) });
    const res = await fetch(`${SERVER_URL}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, prompt, signature }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Provider refused the session: ${body.error}`);
    this.token = body.token;

    this.events.onPhase("streaming");
    const source = new EventSource(`${SERVER_URL}/stream/${this.token}`);
    this.source = source;
    source.addEventListener("chunk", (e) => {
      const chunk = JSON.parse((e as MessageEvent).data) as { index: number; text: string; total: number };
      this.events.onChunk(chunk);
      this.queue = this.queue.then(() => this.payFor(chunk.index)).catch((err) => this.fail(err));
    });
    source.addEventListener("done", () => {
      source.close();
      void this.queue.then(() => this.finish("answer complete"));
    });
    source.onerror = () => {
      if (this.stopped || this.finished) return;
      source.close();
      this.fail(new Error("Lost connection to the provider"));
    };
  }

  private async payFor(index: number) {
    if (this.stopped || this.finished) return;
    if (this.paid >= this.maxChunks) {
      this.source?.close();
      this.stopped = true;
      void this.finish("spending cap reached");
      return;
    }

    const gas = this.providerEmpty ? GAS_LIMITS.payFirstToEmptyProvider : GAS_LIMITS.pay;
    const started = performance.now();
    const receipt = await this.sendFromKey("pay", gas);
    const confirmMs = performance.now() - started;
    if (receipt.status !== "success") throw new Error(`pay() for chunk ${index + 1} reverted`);
    this.providerEmpty = false;
    this.paid++;

    const res = await fetch(`${SERVER_URL}/paid`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: this.token, txHash: receipt.transactionHash }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Provider rejected payment: ${body.error}`);

    this.events.onPayment({
      index,
      hash: receipt.transactionHash,
      confirmMs,
      verifyMs: body.verifyMs,
      feeWei: receipt.gasUsed * receipt.effectiveGasPrice,
      priceWei: this.info.pricePerChunk,
    });
  }

  /** Sends pay() or close() from the session key and returns its receipt. */
  private async sendFromKey(functionName: "pay" | "close", gas: bigint): Promise<TransactionReceipt> {
    const request = {
      address: this.info.contract,
      abi: sip402Abi,
      functionName,
      args: [this.sessionId],
      gas,
      nonce: this.nonce,
      ...this.fees,
    } as const;

    if (this.syncSendSupported) {
      try {
        // eth_sendRawTransactionSync returns the receipt in the same round trip.
        const receipt = await this.keyWallet.writeContractSync({ ...request, throwOnReceiptRevert: false });
        this.nonce++;
        return receipt;
      } catch (err) {
        if (!isUnsupportedMethod(err)) {
          await this.resyncNonce();
          throw err;
        }
        this.syncSendSupported = false;
      }
    }

    try {
      const hash = await this.keyWallet.writeContract(request);
      this.nonce++;
      return await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    } catch (err) {
      await this.resyncNonce();
      throw err;
    }
  }

  private async resyncNonce() {
    this.nonce = await publicClient.getTransactionCount({ address: this.sessionKey.address, blockTag: "pending" });
  }

  private finish(reason: string) {
    this.finished ??= this.closeAndSweep(reason).catch((err) => this.fail(err));
    return this.finished;
  }

  private async closeAndSweep(reason: string) {
    this.source?.close();
    this.events.onPhase("closing", "Refunding the unspent balance");
    const receipt = await this.sendFromKey("close", GAS_LIMITS.close);
    if (receipt.status !== "success") throw new Error("close() reverted");
    const [closed] = parseEventLogs({ abi: sip402Abi, logs: receipt.logs, eventName: "SessionClosed" });
    this.events.onClosed({
      hash: receipt.transactionHash,
      chunksPaid: Number(closed.args.chunksPaid),
      refundWei: closed.args.refund,
      reason,
    });

    // Sending value from an account below the reserve only works as an "emptying"
    // transaction: no other transaction from it in the last 3 blocks.
    this.events.onPhase("sweeping", "Returning leftover gas allowance to your wallet");
    await waitForBlock(receipt.blockNumber + RESERVE_LAG_BLOCKS);
    const balance = await publicClient.getBalance({ address: this.sessionKey.address });
    const maxFee = TRANSFER_GAS * this.fees.maxFeePerGas;
    if (balance <= maxFee) {
      this.events.onSwept(null);
    } else {
      const hash = await this.keyWallet.sendTransaction({
        to: this.payer,
        value: balance - maxFee,
        gas: TRANSFER_GAS,
        nonce: this.nonce,
        ...this.fees,
      });
      this.nonce++;
      const sweep = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
      this.events.onSwept(sweep.status === "success" ? { hash, amountWei: balance - maxFee } : null);
    }
    this.events.onPhase("done");
  }

  private fail(err: unknown) {
    this.events.onError(errorMessage(err));
    this.events.onPhase("error");
    this.source?.close();
    // Try to get the deposit back if a session was opened.
    if (this.sessionId !== 0n && !this.finished) {
      this.stopped = true;
      void this.finish("error");
    }
  }
}
