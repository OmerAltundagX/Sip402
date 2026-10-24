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

export type Phase =
  | "idle"
  | "opening"
  | "warming"
  | "streaming"
  | "paused"
  | "expired"
  | "closing"
  | "sweeping"
  | "done"
  | "error";

export type Payment = {
  index: number;
  hash: Hash;
  /** Send to receipt, measured in the browser. */
  confirmMs: number;
  /** Provider's on-chain check before releasing the next chunk; null if reported after Cancel. */
  verifyMs: number | null;
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
  /** Per-session gas limits, estimated once the session exists (see GAS_LIMITS). */
  private gas: { pay: bigint; close: bigint } = { pay: GAS_LIMITS.pay, close: GAS_LIMITS.close };
  private syncSendSupported = true;
  private source?: EventSource;
  private queue: Promise<void> = Promise.resolve();
  /** Cancelled, or the spending cap was reached: no further payments, close is pending or done. */
  private stopped = false;
  private paused = false;
  /** The provider dropped the stream after the idle timeout; only Cancel is possible. */
  private expired = false;
  /** Chunk that arrived while paused; it is paid for on Resume. */
  private pendingIndex?: number;
  private lastChunkIndex = -1;
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

  /**
   * Stop paying for new chunks. An in-flight payment still finishes; the session stays
   * open on-chain and no transaction is sent until Resume or Cancel.
   */
  pause() {
    if (this.paused || this.stopped || this.finished) return;
    this.paused = true;
    this.events.onPhase("paused", "No payments are sent while paused");
  }

  /** Continue paying from the next chunk of the same answer. No wallet popup. */
  resume() {
    if (!this.paused || this.expired || this.stopped || this.finished) return;
    this.paused = false;
    this.events.onPhase("streaming");
    const index = this.pendingIndex;
    this.pendingIndex = undefined;
    if (index !== undefined) this.enqueuePayment(index);
  }

  /** Close the session and refund the unspent balance. Works while streaming, paused or expired. */
  cancel() {
    if (this.stopped) return;
    this.stopped = true;
    // The stream stays open until the in-flight payment settles, so the provider
    // still accepts its /paid report; closeAndSweep() closes it afterwards.
    void this.queue.then(() => this.finish("cancelled by user"));
  }

  private enqueuePayment(index: number) {
    this.queue = this.queue.then(() => this.payFor(index)).catch((err) => this.fail(err));
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
    const [nonce, pay, close] = await Promise.all([
      publicClient.getTransactionCount({ address: this.sessionKey.address, blockTag: "pending" }),
      this.estimateGas("pay", this.providerEmpty ? GAS_LIMITS.payFirstToEmptyProvider : GAS_LIMITS.pay),
      this.estimateGas("close", GAS_LIMITS.close),
    ]);
    this.nonce = nonce;
    this.gas = { pay, close };
  }

  /**
   * Gas for this session's pay() or close(), plus 10% headroom. Storage layout makes
   * the cost differ between sessions on Monad, so a fixed limit is either wasteful
   * or occasionally too low.
   */
  private async estimateGas(functionName: "pay" | "close", fallback: bigint): Promise<bigint> {
    try {
      const estimate = await publicClient.estimateContractGas({
        address: this.info.contract,
        abi: sip402Abi,
        functionName,
        args: [this.sessionId],
        account: this.sessionKey.address,
      });
      return (estimate * 110n) / 100n;
    } catch {
      return fallback;
    }
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
      // A chunk released by the last payment after Cancel is neither shown nor paid for.
      if (this.stopped || this.finished) return;
      const chunk = JSON.parse((e as MessageEvent).data) as { index: number; text: string; total: number };
      // A reconnect replays the chunks delivered so far.
      if (chunk.index <= this.lastChunkIndex) return;
      this.lastChunkIndex = chunk.index;
      this.events.onChunk(chunk);
      this.enqueuePayment(chunk.index);
    });
    source.addEventListener("done", () => {
      source.close();
      void this.queue.then(() => this.finish("answer complete"));
    });
    source.addEventListener("expired", () => {
      source.close();
      if (this.stopped || this.finished) return;
      this.expired = true;
      this.paused = true;
      this.events.onPhase("expired", "The provider closed the idle stream. Cancel to get your refund.");
    });
    source.onerror = () => {
      // EventSource reconnects on its own; only give up once it has closed for good.
      if (source.readyState !== EventSource.CLOSED || this.stopped || this.finished || this.expired) return;
      this.fail(new Error("Lost connection to the provider"));
    };
  }

  private async payFor(index: number) {
    if (this.stopped || this.finished) return;
    if (this.paused) {
      this.pendingIndex = index;
      return;
    }
    if (this.paid >= this.maxChunks) {
      this.source?.close();
      this.stopped = true;
      void this.finish("spending cap reached");
      return;
    }

    const started = performance.now();
    const receipt = await this.sendFromKey("pay", this.gas.pay);
    const confirmMs = performance.now() - started;
    if (receipt.status !== "success") throw new Error(`pay() for chunk ${index + 1} reverted (tx ${receipt.transactionHash})`);
    this.paid++;

    // The first payment created the provider's account; later ones are cheaper.
    const reestimate = this.providerEmpty
      ? this.estimateGas("pay", GAS_LIMITS.pay).then((gas) => {
          this.gas.pay = gas;
          this.providerEmpty = false;
        })
      : undefined;

    // The payment is on-chain either way, so it is recorded even if the report below is late.
    const [verifyMs] = await Promise.all([this.reportPayment(receipt.transactionHash), reestimate]);
    this.events.onPayment({
      index,
      hash: receipt.transactionHash,
      confirmMs,
      verifyMs,
      feeWei: receipt.gasUsed * receipt.effectiveGasPrice,
      priceWei: this.info.pricePerChunk,
    });
  }

  /**
   * Tells the provider about a payment so it releases the next chunk. Returns the
   * provider's verification time, or null for a late report after Cancel.
   */
  private async reportPayment(txHash: Hash): Promise<number | null> {
    const ending = () => this.stopped || this.finished !== undefined;
    try {
      const res = await fetch(`${SERVER_URL}/paid`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: this.token, txHash }),
      });
      const body = await res.json();
      if (res.ok) return body.verifyMs;
      if (ending()) return null;
      throw new Error(`Provider rejected payment: ${body.error}`);
    } catch (err) {
      if (ending()) return null;
      throw err;
    }
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
    // Best effort: the provider also drops the stream after its idle timeout.
    if (this.token) {
      void fetch(`${SERVER_URL}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: this.token }),
      }).catch(() => {});
    }
    this.events.onPhase("closing", "Refunding the unspent balance");
    const receipt = await this.sendFromKey("close", this.gas.close);
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
