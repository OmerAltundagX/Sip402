import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Response } from "express";
import { isHash, verifyMessage, type Hex } from "viem";
import { monadTestnet } from "../../shared/monad";
import { askMessage } from "../../shared/protocol";
import { answerFor, toChunks } from "./answers";
import { readSession, verifyChunkPayment } from "./chain";
import { config } from "./config";

type Stream = {
  sessionId: bigint;
  chunks: string[];
  /** Number of chunks paid and verified on-chain. Chunk `paid` is the one currently delivered. */
  paid: number;
  verifying: boolean;
  client?: Response;
};

const streams = new Map<string, Stream>();
const sessionsInUse = new Set<string>();

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
    pricePerChunk: config.pricePerChunk.toString(),
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
  if (session.pricePerChunk < config.pricePerChunk) return res.status(400).json({ error: "price per chunk too low" });
  if (session.chunksPaid !== 0n) return res.status(400).json({ error: "session already used" });

  const signed = await verifyMessage({
    address: session.sessionKey,
    message: askMessage(sessionId, prompt),
    signature: signature as Hex,
  }).catch(() => false);
  if (!signed) return res.status(401).json({ error: "invalid session key signature" });

  const chunks = toChunks(answerFor(prompt), config.wordsPerChunk);
  const token = randomUUID();
  streams.set(token, { sessionId: BigInt(sessionId), chunks, paid: 0, verifying: false });
  sessionsInUse.add(sessionId);

  res.json({ token, totalChunks: chunks.length, affordableChunks: (session.deposit / session.pricePerChunk).toString() });
});

/** Server-sent events: `chunk` { index, text, total } and `done` { paid }. */
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

  // The first chunk is free to read; each later chunk is sent only after the previous one is paid.
  for (let i = 0; i <= Math.min(stream.paid, stream.chunks.length - 1); i++) sendChunk(stream, i);
  if (stream.paid === stream.chunks.length) send(stream, "done", { paid: stream.paid });

  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    streams.delete(req.params.token);
    sessionsInUse.delete(stream.sessionId.toString());
  });
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
  const started = performance.now();
  try {
    const chunkIndex = stream.paid;
    const check = await verifyChunkPayment(txHash, stream.sessionId, chunkIndex);
    const verifyMs = Math.round(performance.now() - started);
    if (!check.ok) return res.status(402).json({ error: check.reason, verifyMs });

    stream.paid++;
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
  console.log(`contract ${config.contract}, provider ${config.provider}, price ${config.pricePerChunk} wei/chunk`);
});
