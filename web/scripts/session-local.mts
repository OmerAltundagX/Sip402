// Drives the browser SipSession class from Node against a local anvil chain,
// with anvil's unlocked account standing in for the browser wallet.
// Usage (from web/): see README ("Local end-to-end test"). Options (env):
//   CAP=0.2                 spending cap in MON
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
const { fetchProviderInfo, SipSession } = await import("../lib/session");

const transport = http(RPC);
const reader = createPublicClient({ chain: monadTestnet, transport });
const [payer] = await createWalletClient({ chain: monadTestnet, transport }).getAddresses();
const wallet = createWalletClient({ chain: monadTestnet, transport });
const info = await fetchProviderInfo();
const cap = parseEther(process.env.CAP ?? "0.2");
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
    onPayment: (p) => {
      paid++;
      console.log(`  paid #${p.index + 1}: ${p.confirmMs.toFixed(0)} ms, verify ${p.verifyMs} ms, fee ${formatEther(p.feeWei)}`);
      if (paid === STOP_AFTER) session.cancel();
      // Only the payment in flight when Pause was pressed may land while paused.
      if (paused && paidAtResume === undefined && paid > PAUSE_AT!) reject(new Error(`payment #${paid} sent while paused`));
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

const expectPaid = STOP_AFTER ?? STOP_IN_FLIGHT ?? (PAUSE_AT !== undefined && RESUME_AFTER_MS === undefined ? PAUSE_AT : undefined);
if (expectPaid !== undefined) check(paid === expectPaid, `expected ${expectPaid} payments, got ${paid}`);
if (PAUSE_AT !== undefined) check(paused, "session never paused");
if (RESUME_AFTER_MS !== undefined) {
  check(paidAtResume === PAUSE_AT, `expected ${PAUSE_AT} payments at resume, got ${paidAtResume}`);
  check(paid === Math.min(total, Number(cap / info.pricePerChunk)), `expected the full answer after resume, got ${paid}`);
}
if (EXPECT_EXPIRED) check(expired, "stream did not expire");
check(refund === cap - BigInt(paid) * info.pricePerChunk, "refund mismatch");
check(swept > 0n, "expected a sweep");
// Net cost = content + all gas; the gas allowance must have come back.
const content = BigInt(paid) * info.pricePerChunk;
check(net >= content && net <= content + parseEther("0.05"), `unexpected net cost ${formatEther(net)}`);
console.log("SESSION OK");
process.exit(0);
