// Drives the browser SipSession class from Node against a local anvil chain,
// with anvil's unlocked account standing in for the browser wallet.
// Usage (from web/): see README ("Local end-to-end test"). Options (env):
//   TIER=smart              price tier id from the provider's /info (default: first tier)
//   SIPS=20                 spending cap in sips (cap = SIPS × tier price)
//   STOP_AFTER=n            Cancel right after payment n is reported
//   STOP_IN_FLIGHT=n        Cancel ~100 ms after chunk n arrives, while its pay() is in flight
//   PAUSE_AT=n              Pause ~100 ms after chunk n arrives (its pay() still finishes), then:
//     RESUME_AFTER_MS=m     resume after m ms and expect the full answer
//     CANCEL_AFTER_MS=m     cancel after m ms
//     EXPECT_EXPIRED=1      wait for the provider's idle timeout, then cancel
import { EventSource } from "eventsource";
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";

const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
const num = (name: string) => (process.env[name] ? Number(process.env[name]) : undefined);
const STOP_AFTER = num("STOP_AFTER");
const STOP_IN_FLIGHT = num("STOP_IN_FLIGHT");
const PAUSE_AT = num("PAUSE_AT");
const RESUME_AFTER_MS = num("RESUME_AFTER_MS");
const CANCEL_AFTER_MS = num("CANCEL_AFTER_MS");
const EXPECT_EXPIRED = process.env.EXPECT_EXPIRED === "1";
process.env.NEXT_PUBLIC_RPC_URL = RPC;
(globalThis as { EventSource?: unknown }).EventSource = EventSource;

const { monadTestnet } = await import("@sip402/shared/monad");
const { fetchProviderInfo, SipSession, walletNetCost } = await import("../lib/session");
type Summary = import("../lib/session").SessionSummary;

const transport = http(RPC);
const reader = createPublicClient({ chain: monadTestnet, transport });
const [payer] = await createWalletClient({ chain: monadTestnet, transport }).getAddresses();
const wallet = createWalletClient({ chain: monadTestnet, transport });
const provider = await fetchProviderInfo();
const tier = process.env.TIER ? provider.tiers.find((t) => t.id === process.env.TIER) : provider.tiers[0];
if (!tier) throw new Error(`unknown tier ${process.env.TIER}`);
// Same as the page: the tier only sets the session's price per chunk.
const info = { ...provider, pricePerChunk: tier.pricePerChunk };
const cap = BigInt(num("SIPS") ?? 20) * tier.pricePerChunk;
console.log(`tier ${tier.label}: ${formatEther(tier.pricePerChunk)} MON per sip, cap ${formatEther(cap)} MON`);
const before = await reader.getBalance({ address: payer });

const check = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};

let paid = 0;
let total = 0;
let refund = 0n;
let swept = 0n;
let paused = false;
let expired = false;
let paidAtResume: number | undefined;
let reason: string | undefined;
let summary: Summary | undefined;
let pendingSip: number | undefined;
await new Promise<void>((resolve, reject) => {
  const session = new SipSession(wallet, payer, info, {
    onPhase: (phase, detail) => {
      console.log(`phase: ${phase}${detail ? ` (${detail})` : ""}`);
      if (phase === "paused" && !paused) {
        paused = true;
        if (RESUME_AFTER_MS !== undefined) {
          setTimeout(() => {
            paidAtResume = paid;
            session.resume();
          }, RESUME_AFTER_MS);
        }
        if (CANCEL_AFTER_MS !== undefined) setTimeout(() => session.cancel(), CANCEL_AFTER_MS);
      }
      if (phase === "expired") {
        expired = true;
        session.cancel();
      }
      if (phase === "done") resolve();
    },
    onOpened: (o) => console.log(`opened #${o.sessionId}, gas allowance ${formatEther(o.gasAllowanceWei)} MON`),
    onChunk: (c) => {
      total = c.total;
      console.log(`  [${c.index + 1}/${c.total}] ${c.text.trim()}`);
      if (c.index + 1 === STOP_IN_FLIGHT) setTimeout(() => session.cancel(), 100);
      if (c.index + 1 === PAUSE_AT) setTimeout(() => session.pause(), 100);
    },
    onPaymentStart: (index) => {
      if (pendingSip !== undefined) reject(new Error(`payment ${index + 1} started while ${pendingSip + 1} pending`));
      pendingSip = index;
    },
    onPayment: (p) => {
      if (pendingSip !== p.index) reject(new Error(`payment ${p.index + 1} confirmed without a pending event`));
      pendingSip = undefined;
      paid++;
      console.log(`  paid #${p.index + 1}: ${p.confirmMs.toFixed(0)} ms, verify ${p.verifyMs} ms, fee ${formatEther(p.feeWei)}`);
      if (paid === STOP_AFTER) session.cancel();
      // Only the payment in flight when Pause was pressed may land while paused.
      if (paused && paidAtResume === undefined && paid > PAUSE_AT!) reject(new Error(`payment #${paid} sent while paused`));
    },
    onClosed: (c) => {
      refund = c.refundWei;
      reason = c.reason;
      console.log(`closed: ${c.chunksPaid} paid, refund ${formatEther(c.refundWei)} MON (${c.reason})`);
    },
    onSwept: (s) => {
      swept = s?.amountWei ?? 0n;
      console.log(`swept: ${s ? formatEther(s.amountWei) : "nothing"} MON`);
    },
    onSummary: (s) => {
      summary = s;
    },
    onError: (m) => reject(new Error(m)),
  });
  void session.start("Why pay for AI by the chunk?", cap);
});

const after = await reader.getBalance({ address: payer });
const net = before - after;
console.log(`payer net cost ${formatEther(net)} MON for ${paid} chunks`);

const expectPaid = STOP_AFTER ?? STOP_IN_FLIGHT ?? (PAUSE_AT !== undefined && RESUME_AFTER_MS === undefined ? PAUSE_AT : undefined);
if (expectPaid !== undefined) check(paid === expectPaid, `expected ${expectPaid} payments, got ${paid}`);
if (PAUSE_AT !== undefined) check(paused, "session never paused");
if (RESUME_AFTER_MS !== undefined) {
  check(paidAtResume === PAUSE_AT, `expected ${PAUSE_AT} payments at resume, got ${paidAtResume}`);
  if (STOP_AFTER === undefined) {
    check(paid === Math.min(total, Number(cap / info.pricePerChunk)), `expected the full answer after resume, got ${paid}`);
  }
}
if (EXPECT_EXPIRED) check(expired, "stream did not expire");
check(refund === cap - BigInt(paid) * info.pricePerChunk, "refund mismatch");
check(swept > 0n, "expected a sweep");

const cancelled = STOP_AFTER ?? STOP_IN_FLIGHT ?? CANCEL_AFTER_MS ?? (EXPECT_EXPIRED ? 1 : undefined);
const expectReason = cancelled !== undefined ? "cancelled" : paid < total ? "cap" : "completed";
check(reason === expectReason, `expected end reason ${expectReason}, got ${reason}`);

// The summary must account for every wei: the payer's real balance change equals its net cost.
check(summary !== undefined, "no session summary");
const s = summary!;
console.log(
  `summary: deposit ${formatEther(s.depositWei)}, provider ${formatEther(s.paidToProviderWei)}, fees ${formatEther(s.fees.totalWei)}, ` +
    `refund ${formatEther(s.refundWei)}, swept ${formatEther(s.sweptWei)}, dust ${formatEther(s.dustWei)}, net ${formatEther(s.netCostWei)}`,
);
check(s.chunksPaid === paid && s.refundWei === refund && s.sweptWei === swept, "summary disagrees with session events");
check(walletNetCost(s) === s.netCostWei, "summary lines do not add up");
check(s.netCostWei === net, `summary net cost ${formatEther(s.netCostWei)} != payer balance change ${formatEther(net)}`);
check(s.priceWei === tier.pricePerChunk && s.capWei === cap, "summary does not use the tier price");
// Everything that came back = deposit − paid to provider − gas spent by the session key − dust.
const keyGas = s.fees.paysWei + s.fees.closeWei + s.fees.sweepWei;
check(
  s.refundWei + s.sweptWei === s.depositWei - s.paidToProviderWei - keyGas - s.dustWei,
  "refund + returned gas != deposit − paid − gas",
);
console.log(
  `returned ${formatEther(s.refundWei + s.sweptWei)} = deposit ${formatEther(s.depositWei)} − paid ${formatEther(s.paidToProviderWei)} − gas ${formatEther(keyGas)} − dust ${formatEther(s.dustWei)}`,
);
// Net cost = content + all gas; the gas allowance must have come back.
const content = BigInt(paid) * info.pricePerChunk;
check(net >= content && net <= content + parseEther("0.05"), `unexpected net cost ${formatEther(net)}`);
console.log("SESSION OK");
process.exit(0);
