// Agent mode: an autonomous agent pays an AI API per sip from the terminal.
// It reuses the web app's SipSession (open, per-sip pay(), close + refund + sweep),
// signing with its own key from AGENT_PRIVATE_KEY instead of a browser wallet.
//
//   npm run agent -- --init                         create agent/.env with a fresh key
//   npm run agent -- [--tier fast] [--sips 20] [--stop-when "<keyword>"] "<question>"
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EventSource } from "eventsource";
import { createWalletClient, custom, formatEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), ".env");

// ---------- terminal output ----------
const ansi = (code: string) => (text: string | number) => `\x1b[${code}m${text}\x1b[0m`;
const c = {
  dim: ansi("2"),
  bold: ansi("1"),
  purple: ansi("38;5;141"),
  green: ansi("32"),
  yellow: ansi("33"),
  red: ansi("31"),
  cyan: ansi("36"),
};
const agentLog = (msg: string) => console.log(`${c.purple("[agent]")} ${msg}`);
const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const mon = (wei: bigint, digits = 6) => `${Number(formatEther(wei)).toFixed(digits)} MON`;
const fail = (msg: string): never => {
  console.error(`${c.red("[agent]")} ${msg}`);
  process.exit(1);
};

// ---------- args and env ----------
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tier: { type: "string", default: "fast" },
    sips: { type: "string", default: "20" },
    "stop-when": { type: "string" },
    init: { type: "boolean", default: false },
    address: { type: "boolean", default: false },
  },
});

if (args.init) {
  if (existsSync(ENV_FILE)) fail(`${ENV_FILE} already exists; not overwriting it.`);
  const key = generatePrivateKey();
  writeFileSync(ENV_FILE, `# Agent wallet for npm run agent. Testnet only; never commit this file.\nAGENT_PRIVATE_KEY=${key}\n`);
  chmodSync(ENV_FILE, 0o600);
  agentLog(`created ${ENV_FILE}`);
  agentLog(`agent address ${c.bold(privateKeyToAccount(key).address)}`);
  process.exit(0);
}

try {
  process.loadEnvFile(ENV_FILE);
} catch {
  // Env vars may also come from the shell.
}
const privateKey = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
if (!privateKey) fail("AGENT_PRIVATE_KEY is not set. Run `npm run agent -- --init` or see agent/.env.example.");
const agent = privateKeyToAccount(privateKey!);
if (args.address) {
  console.log(agent.address);
  process.exit(0);
}

const question = positionals.join(" ").trim();
if (!question) fail('Usage: npm run agent -- [--tier fast] [--sips 20] [--stop-when "<keyword>"] "<question>"');
const sips = Number(args.sips);
if (!Number.isInteger(sips) || sips < 1) fail("--sips must be a positive integer");
const stopWhen = args["stop-when"]?.toLowerCase();

// The session module reads these at import time.
process.env.NEXT_PUBLIC_SERVER_URL ??= process.env.SIP402_SERVER_URL ?? "http://localhost:3001";
if (process.env.RPC_URL) process.env.NEXT_PUBLIC_RPC_URL ??= process.env.RPC_URL;
(globalThis as { EventSource?: unknown }).EventSource = EventSource;

const { explorerTx, monadTestnet, GAS_LIMITS, BASE_FEE_HEADROOM_PCT } = await import("@sip402/shared/monad");
const { fetchProviderInfo, publicClient, SipSession } = await import("../web/lib/session");
type Summary = import("../web/lib/session").SessionSummary;

// A wallet that signs exactly the gas and fees SipSession requests with the agent's key.
const { rpcTransport } = await import("@sip402/shared/rpc");
const rpc = rpcTransport(process.env.NEXT_PUBLIC_RPC_URL, process.env.RPC_URL_FALLBACK)({ chain: monadTestnet });
const wallet = createWalletClient({
  chain: monadTestnet,
  transport: custom({
    async request({ method, params }) {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [agent.address];
      if (method === "eth_sendTransaction") {
        const tx = (params as Record<string, Hex>[])[0];
        const signed = await agent.signTransaction({
          chainId: monadTestnet.id,
          type: "eip1559",
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value ?? "0x0"),
          gas: BigInt(tx.gas),
          maxFeePerGas: BigInt(tx.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
          nonce: await publicClient.getTransactionCount({ address: agent.address, blockTag: "pending" }),
        });
        return rpc.request({ method: "eth_sendRawTransaction", params: [signed] });
      }
      return rpc.request({ method, params } as never);
    },
  }),
});

// ---------- provider and funding ----------
const provider = await fetchProviderInfo().catch((err) =>
  fail(`provider server unreachable at ${process.env.NEXT_PUBLIC_SERVER_URL}: ${err.message}`),
);
const tier = provider.tiers.find((t) => t.id === args.tier) ?? fail(`unknown tier "${args.tier}"`);
const capWei = BigInt(sips) * tier.pricePerChunk;

// Same budget SipSession uses: cap + gas allowance for every sip, close and sweep, plus the open fee.
const [block, priorityFee] = await Promise.all([publicClient.getBlock(), publicClient.estimateMaxPriorityFeePerGas()]);
const maxFee = ((block.baseFeePerGas ?? 0n) * (100n + BASE_FEE_HEADROOM_PCT)) / 100n + priorityFee;
const gasUnits =
  BigInt(sips) * GAS_LIMITS.pay +
  (GAS_LIMITS.payFirstToEmptyProvider - GAS_LIMITS.pay) +
  GAS_LIMITS.close +
  GAS_LIMITS.transfer +
  GAS_LIMITS.openSession;
const neededWei = capWei + gasUnits * maxFee;

console.log();
console.log(`${c.bold("Sip402 agent")} ${c.dim("· pay-per-sip AI from the terminal · Monad Testnet")}`);
console.log(c.dim("─".repeat(72)));
agentLog(`wallet   ${agent.address}`);
let balance = await publicClient.getBalance({ address: agent.address });
if (balance < neededWei) {
  agentLog(c.yellow(`needs ${mon(neededWei, 3)} for this run, has ${mon(balance, 3)}. Send testnet MON to ${agent.address}`));
  agentLog(c.dim("waiting for funds…"));
  const deadline = Date.now() + 30 * 60_000;
  while ((balance = await publicClient.getBalance({ address: agent.address })) < neededWei) {
    if (Date.now() > deadline) fail("not funded within 30 minutes");
    await new Promise((r) => setTimeout(r, 3000));
  }
  // Monad's reserve-balance rule checks a balance lagged by 3 blocks.
  const fundedAt = await publicClient.getBlockNumber();
  while ((await publicClient.getBlockNumber()) < fundedAt + 3n) await new Promise((r) => setTimeout(r, 200));
}
agentLog(`balance  ${mon(balance, 4)}`);
agentLog(`tier     ${c.bold(tier.label)} · ${formatEther(tier.pricePerChunk)} MON per sip · cap ${sips} sips (${formatEther(capWei)} MON)`);
if (stopWhen) agentLog(`goal     stop as soon as the answer mentions ${c.cyan(`"${args["stop-when"]}"`)}`);
agentLog(`question ${c.cyan(`"${question}"`)}`);
console.log(c.dim("─".repeat(72)));

// ---------- the session ----------
const texts: string[] = [];
let answerLength = 0;
const confirms: number[] = [];
let summary: Summary | undefined;
let stoppedByGoal = false;

await new Promise<void>((resolve) => {
  const session = new SipSession(wallet, agent.address, { ...provider, pricePerChunk: tier.pricePerChunk }, {
    onPhase: (phase) => {
      if (phase === "opening") agentLog("opening session…");
      if (phase === "warming") agentLog(c.dim("session key funded, waiting 3 blocks (Monad reserve-balance rule)…"));
      if (phase === "streaming" && confirms.length === 0) agentLog("streaming answer, paying per sip:");
      if (phase === "closing") agentLog("closing session, refunding unspent cap…");
      if (phase === "sweeping") agentLog(c.dim("returning leftover gas allowance…"));
      if (phase === "done" || phase === "error") resolve();
    },
    onOpened: (o) =>
      agentLog(`session #${o.sessionId} opened · gas allowance ${mon(o.gasAllowanceWei, 4)} · tx ${shortHash(o.hash)}`),
    onChunk: ({ index, text, total }) => {
      texts[index] = text;
      answerLength = total;
    },
    onPayment: (p) => {
      confirms.push(p.confirmMs);
      const text = (texts[p.index] ?? "").trim();
      console.log(
        `${c.green(`[sip #${p.index + 1}]`.padEnd(9))} paid ${formatEther(p.priceWei)} MON · ` +
          `${c.purple(`${p.confirmMs.toFixed(0).padStart(4)} ms`)} · tx ${c.dim(shortHash(p.hash))} · ${c.dim(`"${text}"`)}`,
      );
      // The agent pays for the sip it just read, then decides whether it needs more.
      if (stopWhen && texts.slice(0, p.index + 1).join("").toLowerCase().includes(stopWhen) && !stoppedByGoal) {
        stoppedByGoal = true;
        agentLog(c.yellow(`got what I needed after ${p.index + 1} sips — stopping, requesting refund.`));
        session.cancel();
      } else if (confirms.length === sips && answerLength > sips) {
        agentLog(c.yellow(`sip cap reached after ${sips} sips — stopping, requesting refund.`));
      }
    },
    onClosed: (closed) => {
      if (closed.reason === "completed") agentLog(`answer complete after ${closed.chunksPaid} sips.`);
    },
    onSwept: () => {},
    onSummary: (s) => {
      summary = s;
    },
    onError: (message) => console.error(`${c.red("[agent]")} ${message}`),
  });
  void session.start(question, capWei);
});

if (!summary) fail("session did not finish cleanly; see the error above.");
const s = summary!;

// ---------- summary ----------
const avgConfirm = confirms.length ? confirms.reduce((a, b) => a + b, 0) / confirms.length : 0;
const row = (label: string, value: string, note = "", strong = false) => {
  const padded = value.padStart(16); // pad before coloring, ANSI codes have no width
  console.log(`  ${label.padEnd(22)}${strong ? c.bold(padded) : padded}  ${c.dim(note)}`);
};
console.log(c.dim("─".repeat(72)));
console.log(c.bold("  Session summary"));
row("Sips paid", String(s.chunksPaid), `avg confirmation ${avgConfirm.toFixed(0)} ms`);
row("Deposited", mon(s.depositWei), `cap ${formatEther(s.capWei)} + gas allowance ${Number(formatEther(s.gasAllowanceWei)).toFixed(4)}`);
row("Paid to provider", mon(s.paidToProviderWei), `${s.chunksPaid} × ${formatEther(s.priceWei)} MON`);
row("Network fees", mon(s.fees.totalWei), `open, ${s.chunksPaid} payments, close, sweep`);
row("Refunded by contract", mon(s.refundWei), "unspent cap");
row("Leftover gas returned", mon(s.sweptWei), "sweep");
row("Net cost", mon(s.netCostWei), `paid to provider + network fees${s.dustWei > 0n ? " + gas dust" : ""}`, true);
console.log();
console.log(`  ${c.dim("open ")} ${explorerTx(s.openTx)}`);
console.log(`  ${c.dim("close")} ${explorerTx(s.closeTx)}`);
console.log();
process.exit(0);
