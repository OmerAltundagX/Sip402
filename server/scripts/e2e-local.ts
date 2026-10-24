// End-to-end smoke test against a local anvil chain: open session, paid stream, close and refund.
// Usage: see README ("Local end-to-end test"). STOP_AFTER=n stops after n paid chunks.
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  parseEventLogs,
  type Address,
  type Hash,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { GAS_LIMITS, monadTestnet } from "@sip402/shared/monad";
import { askMessage } from "@sip402/shared/protocol";
import { sip402Abi } from "@sip402/shared/sip402Abi";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3001";
const STOP_AFTER = process.env.STOP_AFTER ? Number(process.env.STOP_AFTER) : Infinity;
const PROMPT = process.env.PROMPT ?? "How does Sip402 work?";

const chain = { ...monadTestnet, rpcUrls: { default: { http: [RPC_URL] } } };
const publicClient = createPublicClient({ chain, transport: http(), pollingInterval: 50 });

const info = (await (await fetch(`${SERVER_URL}/info`)).json()) as {
  contract: Address;
  provider: Address;
  pricePerChunk: string;
};
const price = BigInt(info.pricePerChunk);

// The payer is anvil's first unlocked account, so no private key is needed here.
const [payerAddress] = await createWalletClient({ chain, transport: http() }).getAddresses();
const payer = createWalletClient({ chain, transport: http(), account: payerAddress });
const sessionKey = privateKeyToAccount(generatePrivateKey());
const keyWallet = createWalletClient({ chain, transport: http(), account: sessionKey });

const cap = parseEther("0.1");
const gasAllowance = parseEther("0.5");
const payerStart = await publicClient.getBalance({ address: payerAddress });

const openHash = await payer.writeContract({
  address: info.contract,
  abi: sip402Abi,
  functionName: "openSession",
  args: [info.provider, price, sessionKey.address, gasAllowance],
  value: cap + gasAllowance,
  gas: GAS_LIMITS.openSession,
});
const openReceipt = await publicClient.waitForTransactionReceipt({ hash: openHash });
const [opened] = parseEventLogs({ abi: sip402Abi, logs: openReceipt.logs, eventName: "SessionOpened" });
const sessionId = opened.args.sessionId.toString();
console.log(`session ${sessionId} opened, key ${sessionKey.address}`);

const signature = await sessionKey.signMessage({ message: askMessage(sessionId, PROMPT) });
const askRes = await fetch(`${SERVER_URL}/ask`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId, prompt: PROMPT, signature }),
});
const ask = (await askRes.json()) as { token: string; totalChunks: number; error?: string };
if (!askRes.ok) throw new Error(`/ask failed: ${ask.error}`);
console.log(`answer has ${ask.totalChunks} chunks`);

let nonce = await publicClient.getTransactionCount({ address: sessionKey.address, blockTag: "pending" });
const confirmMs: number[] = [];

async function payFor(chunkIndex: number) {
  const providerBalance = await publicClient.getBalance({ address: info.provider });
  const started = performance.now();
  const hash: Hash = await keyWallet.writeContract({
    address: info.contract,
    abi: sip402Abi,
    functionName: "pay",
    args: [BigInt(sessionId)],
    gas: providerBalance === 0n ? GAS_LIMITS.payFirstToEmptyProvider : GAS_LIMITS.pay,
    nonce: nonce++,
  });
  await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  confirmMs.push(performance.now() - started);
  const res = await fetch(`${SERVER_URL}/paid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ask.token, txHash: hash }),
  });
  const body = (await res.json()) as { verifyMs?: number; error?: string };
  if (!res.ok) throw new Error(`/paid failed for chunk ${chunkIndex}: ${body.error}`);
  console.log(`  paid chunk ${chunkIndex} in ${confirmMs.at(-1)!.toFixed(0)} ms, verified in ${body.verifyMs} ms`);
}

// Node 20 has no EventSource, so read the SSE stream by hand.
const sse = await fetch(`${SERVER_URL}/stream/${ask.token}`);
const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader();
let buffer = "";
let paidChunks = 0;
read: while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += value;
  let sep: number;
  while ((sep = buffer.indexOf("\n\n")) !== -1) {
    const raw = buffer.slice(0, sep);
    buffer = buffer.slice(sep + 2);
    const event = raw.match(/^event: (.*)$/m)?.[1];
    const data = raw.match(/^data: (.*)$/m)?.[1];
    if (!event || !data) continue;
    if (event === "done") break read;
    const chunk = JSON.parse(data) as { index: number; text: string; total: number };
    console.log(`[${chunk.index + 1}/${chunk.total}] ${chunk.text.trim()}`);
    if (paidChunks >= STOP_AFTER) {
      console.log("stop pressed");
      break read;
    }
    await payFor(chunk.index);
    paidChunks++;
  }
}
await reader.cancel();

const closeHash = await keyWallet.writeContract({
  address: info.contract,
  abi: sip402Abi,
  functionName: "close",
  args: [BigInt(sessionId)],
  gas: GAS_LIMITS.close,
  nonce: nonce++,
});
const closeReceipt = await publicClient.waitForTransactionReceipt({ hash: closeHash });
const [closed] = parseEventLogs({ abi: sip402Abi, logs: closeReceipt.logs, eventName: "SessionClosed" });

const avg = confirmMs.reduce((a, b) => a + b, 0) / Math.max(confirmMs.length, 1);
console.log(`closed: ${closed.args.chunksPaid} chunks paid, refund ${formatEther(closed.args.refund)} MON`);
console.log(`avg send-to-receipt ${avg.toFixed(0)} ms over ${confirmMs.length} payments`);
const payerEnd = await publicClient.getBalance({ address: payerAddress });
console.log(`payer spent ${formatEther(payerStart - payerEnd)} MON (content + gas allowance + open gas)`);

if (closed.args.chunksPaid !== BigInt(paidChunks)) throw new Error("chunk count mismatch");
if (closed.args.refund !== cap - BigInt(paidChunks) * price) throw new Error("refund mismatch");
console.log("E2E OK");
