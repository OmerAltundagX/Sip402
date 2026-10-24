// Drives the browser SipSession class from Node against a local anvil chain,
// with anvil's unlocked account standing in for the browser wallet.
// Usage (from web/): RPC=http://127.0.0.1:8545 [STOP_AFTER=n] npx tsx scripts/session-local.mts
import { EventSource } from "eventsource";
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";

const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
const STOP_AFTER = process.env.STOP_AFTER ? Number(process.env.STOP_AFTER) : Infinity;
process.env.NEXT_PUBLIC_RPC_URL = RPC;
(globalThis as { EventSource?: unknown }).EventSource = EventSource;

const { monadTestnet } = await import("@sip402/shared/monad");
const { fetchProviderInfo, SipSession } = await import("../lib/session");

const transport = http(RPC);
const reader = createPublicClient({ chain: monadTestnet, transport });
const [payer] = await createWalletClient({ chain: monadTestnet, transport }).getAddresses();
const wallet = createWalletClient({ chain: monadTestnet, transport });
const info = await fetchProviderInfo();
const cap = parseEther(process.env.CAP ?? "0.2");
const before = await reader.getBalance({ address: payer });

let paid = 0;
let refund = 0n;
let swept = 0n;
await new Promise<void>((resolve, reject) => {
  const session = new SipSession(wallet, payer, info, {
    onPhase: (phase, detail) => {
      console.log(`phase: ${phase}${detail ? ` (${detail})` : ""}`);
      if (phase === "done") resolve();
    },
    onOpened: (o) => console.log(`opened #${o.sessionId}, gas allowance ${formatEther(o.gasAllowanceWei)} MON`),
    onChunk: (c) => console.log(`  [${c.index + 1}/${c.total}] ${c.text.trim()}`),
    onPayment: (p) => {
      paid++;
      console.log(`  paid #${p.index + 1}: ${p.confirmMs.toFixed(0)} ms, verify ${p.verifyMs} ms, fee ${formatEther(p.feeWei)}`);
      if (paid === STOP_AFTER) session.stop();
    },
    onClosed: (c) => {
      refund = c.refundWei;
      console.log(`closed: ${c.chunksPaid} paid, refund ${formatEther(c.refundWei)} MON (${c.reason})`);
    },
    onSwept: (s) => {
      swept = s?.amountWei ?? 0n;
      console.log(`swept: ${s ? formatEther(s.amountWei) : "nothing"} MON`);
    },
    onError: (m) => reject(new Error(m)),
  });
  void session.start("Why pay for AI by the chunk?", cap);
});

const after = await reader.getBalance({ address: payer });
const net = before - after;
console.log(`payer net cost ${formatEther(net)} MON for ${paid} chunks`);
if (refund !== cap - BigInt(paid) * info.pricePerChunk) throw new Error("refund mismatch");
if (swept === 0n) throw new Error("expected a sweep");
// Net cost = content + all gas; the gas allowance must have come back.
const content = BigInt(paid) * info.pricePerChunk;
if (net < content || net > content + parseEther("0.05")) throw new Error(`unexpected net cost ${formatEther(net)}`);
console.log("SESSION OK");
process.exit(0);
