// Runs one real SipSession on Monad testnet with a throwaway payer key that only
// lives in memory. Fund the printed address, then the script opens a session on
// the chosen tier, cancels after STOP_AFTER sips, prints the summary and sends
// everything left back to RETURN_TO.
// Usage (from web/, provider server running against testnet):
//   RETURN_TO=0x... NEXT_PUBLIC_SERVER_URL=http://localhost:3001 [TIER=fast] [SIPS=20] [STOP_AFTER=9] \
//     npx tsx scripts/session-testnet.mts
import { EventSource } from "eventsource";
import {
  createWalletClient,
  custom,
  formatEther,
  getAddress,
  http,
  parseEther,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

(globalThis as { EventSource?: unknown }).EventSource = EventSource;
const { monadTestnet, explorerTx, GAS_LIMITS } = await import("@sip402/shared/monad");
const { fetchProviderInfo, publicClient, SipSession, walletNetCost } = await import("../lib/session");
type Summary = import("../lib/session").SessionSummary;

const RETURN_TO = getAddress(process.env.RETURN_TO ?? "");
const SIPS = BigInt(process.env.SIPS ?? 20);
const STOP_AFTER = Number(process.env.STOP_AFTER ?? 9);
const FUND_TIMEOUT_MS = 15 * 60_000;

const payer = privateKeyToAccount(generatePrivateKey());
const rpc = http(monadTestnet.rpcUrls.default.http[0])({ chain: monadTestnet });

// A minimal injected-style wallet: signs exactly the gas and fees SipSession asks for.
const wallet = createWalletClient({
  chain: monadTestnet,
  transport: custom({
    async request({ method, params }) {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [payer.address];
      if (method === "eth_sendTransaction") {
        const tx = (params as Record<string, Hex>[])[0];
        const serialized = await payer.signTransaction({
          chainId: monadTestnet.id,
          type: "eip1559",
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value ?? "0x0"),
          gas: BigInt(tx.gas),
          maxFeePerGas: BigInt(tx.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
          nonce: await publicClient.getTransactionCount({ address: payer.address, blockTag: "pending" }),
        });
        return rpc.request({ method: "eth_sendRawTransaction", params: [serialized] });
      }
      return rpc.request({ method, params } as never);
    },
  }),
});

const provider = await fetchProviderInfo();
const tier = provider.tiers.find((t) => t.id === (process.env.TIER ?? "fast")) ?? provider.tiers[0];
const info = { ...provider, pricePerChunk: tier.pricePerChunk };
const cap = SIPS * tier.pricePerChunk;

console.log(`FUND_ME ${payer.address} with 0.3 MON (tier ${tier.label}, cap ${formatEther(cap)} MON)`);
const started = Date.now();
let funded = 0n;
while ((funded = await publicClient.getBalance({ address: payer.address })) === 0n) {
  if (Date.now() - started > FUND_TIMEOUT_MS) throw new Error("not funded in time");
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`funded with ${formatEther(funded)} MON`);
// Reserve-balance rule: let the new balance reach the lagged state before spending it.
const fundedAt = await publicClient.getBlockNumber();
while ((await publicClient.getBlockNumber()) < fundedAt + 3n) await new Promise((r) => setTimeout(r, 200));

let summary: Summary | undefined;
let paid = 0;
const confirm: number[] = [];
await new Promise<void>((resolve, reject) => {
  const session = new SipSession(wallet, payer.address, info, {
    onPhase: (phase) => {
      console.log(`phase: ${phase}`);
      if (phase === "done") resolve();
    },
    onOpened: (o) => console.log(`opened #${o.sessionId}: ${explorerTx(o.hash)}, gas allowance ${formatEther(o.gasAllowanceWei)} MON`),
    onChunk: () => {},
    onPayment: (p) => {
      paid++;
      confirm.push(p.confirmMs);
      console.log(`  sip #${p.index + 1}: ${p.confirmMs.toFixed(0)} ms, fee ${formatEther(p.feeWei)} MON ${explorerTx(p.hash)}`);
      if (paid === STOP_AFTER) session.cancel();
    },
    onClosed: (c) => console.log(`closed (${c.reason}): ${c.chunksPaid} sips, refund ${formatEther(c.refundWei)} MON`),
    onSwept: () => {},
    onSummary: (s) => {
      summary = s;
    },
    onError: (m) => reject(new Error(m)),
  });
  void session.start("Why pay for AI by the chunk?", cap);
});

const s = summary!;
const keyGas = s.fees.paysWei + s.fees.closeWei + s.fees.sweepWei;
const report = {
  tier: tier.label,
  sips: s.chunksPaid,
  avgConfirmMs: Math.round(confirm.reduce((a, b) => a + b, 0) / confirm.length),
  depositMon: formatEther(s.depositWei),
  gasAllowanceMon: formatEther(s.gasAllowanceWei),
  paidToProviderMon: formatEther(s.paidToProviderWei),
  feesMon: { open: formatEther(s.fees.openWei), pays: formatEther(s.fees.paysWei), close: formatEther(s.fees.closeWei), sweep: formatEther(s.fees.sweepWei), total: formatEther(s.fees.totalWei) },
  feePerSipMon: formatEther(s.fees.paysWei / BigInt(s.chunksPaid)),
  refundMon: formatEther(s.refundWei),
  sweptMon: formatEther(s.sweptWei),
  dustMon: formatEther(s.dustWei),
  netCostMon: formatEther(s.netCostWei),
  addsUp: walletNetCost(s) === s.netCostWei,
  refundMathOk: s.refundWei + s.sweptWei === s.depositWei - s.paidToProviderWei - keyGas - s.dustWei,
  txs: { open: explorerTx(s.openTx), close: explorerTx(s.closeTx), sweep: s.sweepTx ? explorerTx(s.sweepTx) : null },
};
console.log("REPORT " + JSON.stringify(report, null, 1));

// Send everything left back. The payer's last transaction was openSession, so this
// qualifies as an emptying transaction under the reserve-balance rule.
const balance = await publicClient.getBalance({ address: payer.address });
const block = await publicClient.getBlock();
const maxFeePerGas = ((block.baseFeePerGas ?? 0n) * 11n) / 10n + parseEther("0.000000002");
const value = balance - GAS_LIMITS.transfer * maxFeePerGas;
if (value > 0n) {
  const signer = createWalletClient({ chain: monadTestnet, transport: http(), account: payer });
  const hash = await signer.sendTransaction({
    to: RETURN_TO,
    value,
    gas: GAS_LIMITS.transfer,
    maxFeePerGas,
    maxPriorityFeePerGas: parseEther("0.000000002"),
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`returned ${formatEther(value)} MON to ${RETURN_TO}: ${explorerTx(hash)}`);
}
console.log("TESTNET OK");
process.exit(0);
