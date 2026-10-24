import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Response } from "express";
import { formatEther, isHash, verifyMessage, type Hex } from "viem";
import { monadTestnet } from "@sip402/shared/monad";
import { askMessage } from "@sip402/shared/protocol";
import { answerFor, toChunks } from "./answers";
import { readSession, verifyChunkPayment } from "./chain";
import { config } from "./config";

type Stream = {
  sessionId: bigint;
  /** Price per chunk of the session's tier, as stored on-chain. */
  pricePerChunk: bigint;
  chunks: string[];
  /** Number of chunks paid and verified on-chain. Chunk `paid` is the one currently delivered. */
  paid: number;
  verifying: boolean;
  client?: Response;
  /** Last /ask, /stream or /paid; a paused stream is dropped after config.streamIdleTimeoutMs. */
  lastActivity: number;
};

const streams = new Map<string, Stream>();
const sessionsInUse = new Set<string>();

function dropStream(token: string) {
  const stream = streams.get(token);
  if (!stream) return;
  stream.client?.end();
  streams.delete(token);
  sessionsInUse.delete(stream.sessionId.toString());
}

// A paused client keeps its stream; nothing is charged while it waits. Streams with no
// activity for the idle timeout are dropped so abandoned sessions do not pile up.
setInterval(
  () => {
    const now = Date.now();
    for (const [token, stream] of streams) {
      if (stream.verifying || now - stream.lastActivity < config.streamIdleTimeoutMs) continue;
      send(stream, "expired", { idleMs: now - stream.lastActivity, paid: stream.paid });
      dropStream(token);
    }
  },
  Math.min(config.streamIdleTimeoutMs / 5, 5_000),
).unref();

function send(stream: Stream, event: string, data: unknown) {
  stream.client?.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendChunk(stream: Stream, index: number) {
  send(stream, "chunk", { index, text: stream.chunks[index], total: stream.chunks.length });
}

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

app.get("/info", (_req, res) => {
  res.json({
    chainId: monadTestnet.id,
    contract: config.contract,
    provider: config.provider,
    // Default tier's price, kept for clients that do not know about tiers.
    pricePerChunk: config.tiers[0].pricePerChunk.toString(),
    tiers: config.tiers.map((t) => ({ id: t.id, label: t.label, pricePerChunk: t.pricePerChunk.toString() })),
  });
});

/** Body: { sessionId, prompt, signature }. Returns a stream token for /stream and /paid. */
app.post("/ask", async (req, res) => {
  const { sessionId, prompt, signature } = req.body ?? {};
  if (typeof sessionId !== "string" || !/^\d+$/.test(sessionId) || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "sessionId (decimal string) and prompt are required" });
  }
  if (sessionsInUse.has(sessionId)) return res.status(409).json({ error: "session already streaming" });

  const session = await readSession(BigInt(sessionId));
  if (!session.open) return res.status(400).json({ error: "session is not open" });
  if (session.provider !== config.provider) return res.status(400).json({ error: "session is for another provider" });
  const tier = config.tiers.find((t) => t.pricePerChunk === session.pricePerChunk);
  if (!tier) return res.status(400).json({ error: "session price does not match any price tier" });
  if (session.chunksPaid !== 0n) return res.status(400).json({ error: "session already used" });

  const signed = await verifyMessage({
    address: session.sessionKey,
    message: askMessage(sessionId, prompt),
    signature: signature as Hex,
  }).catch(() => false);
  if (!signed) return res.status(401).json({ error: "invalid session key signature" });

  const chunks = toChunks(answerFor(prompt), config.wordsPerChunk);
  const token = randomUUID();
  streams.set(token, { sessionId: BigInt(sessionId), pricePerChunk: tier.pricePerChunk, chunks, paid: 0, verifying: false, lastActivity: Date.now() });
  sessionsInUse.add(sessionId);

  res.json({ token, tier: tier.id, totalChunks: chunks.length, affordableChunks: (session.deposit / session.pricePerChunk).toString() });
});

/**
 * Server-sent events: `chunk` { index, text, total }, `done` { paid }, and `expired` { idleMs, paid }
 * when the stream is dropped for inactivity. Reconnecting replays the chunks delivered so far.
 */
app.get("/stream/:token", (req, res) => {
  const stream = streams.get(req.params.token);
  if (!stream) return res.status(404).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  stream.client = res;
  stream.lastActivity = Date.now();

  // The first chunk is free to read; each later chunk is sent only after the previous one is paid.
  for (let i = 0; i <= Math.min(stream.paid, stream.chunks.length - 1); i++) sendChunk(stream, i);
  if (stream.paid === stream.chunks.length) send(stream, "done", { paid: stream.paid });

  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  // A dropped connection keeps the stream so the client can reconnect; /end or the idle timeout removes it.
  req.on("close", () => {
    clearInterval(heartbeat);
    if (stream.client === res) stream.client = undefined;
  });
});

/** Body: { token }. The client is done with the stream (answer complete or session cancelled). */
app.post("/end", (req, res) => {
  const { token } = req.body ?? {};
  if (typeof token === "string") dropStream(token);
  res.json({ ok: true });
});

/** Body: { token, txHash }. Verifies payment for the current chunk, then releases the next one. */
app.post("/paid", async (req, res) => {
  const { token, txHash } = req.body ?? {};
  const stream = typeof token === "string" ? streams.get(token) : undefined;
  if (!stream) return res.status(404).json({ error: "unknown stream" });
  if (typeof txHash !== "string" || !isHash(txHash)) return res.status(400).json({ error: "invalid txHash" });
  if (stream.paid >= stream.chunks.length) return res.status(400).json({ error: "answer already fully paid" });
  if (stream.verifying) return res.status(409).json({ error: "a payment is already being verified" });

  stream.verifying = true;
  stream.lastActivity = Date.now();
  const started = performance.now();
  try {
    const chunkIndex = stream.paid;
    const check = await verifyChunkPayment(txHash, stream.sessionId, chunkIndex, stream.pricePerChunk);
    const verifyMs = Math.round(performance.now() - started);
    if (!check.ok) return res.status(402).json({ error: check.reason, verifyMs });

    stream.paid++;
    stream.lastActivity = Date.now();
    if (stream.paid < stream.chunks.length) sendChunk(stream, stream.paid);
    else send(stream, "done", { paid: stream.paid });

    res.json({ ok: true, chunkIndex, verifyMs, blockNumber: check.blockNumber.toString() });
  } finally {
    stream.verifying = false;
  }
});

app.use((err: Error, _req: express.Request, res: Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(config.port, () => {
  console.log(`Sip402 provider listening on http://localhost:${config.port}`);
  console.log(`contract ${config.contract}, provider ${config.provider}`);
  console.log(`tiers: ${config.tiers.map((t) => `${t.label} ${formatEther(t.pricePerChunk)} MON`).join(", ")}`);
});
