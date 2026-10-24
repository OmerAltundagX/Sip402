"use client";

import { useEffect, useRef, useState } from "react";
import { formatEther, parseEther, type Address, type Hash, type WalletClient } from "viem";
import { explorerAddress, explorerTx } from "@sip402/shared/monad";
import { Glass } from "@/components/Glass";
import { Metrics } from "@/components/Metrics";
import { PaymentLog } from "@/components/PaymentLog";
import { fetchProviderInfo, SipSession, type Payment, type Phase, type ProviderInfo } from "@/lib/session";
import { connectWallet } from "@/lib/wallet";

const SUGGESTIONS = ["How does Sip402 work?", "Why is Monad so fast?", "Why pay for AI by the chunk?"];
const CAPS = ["0.1", "0.2", "0.3"];

type Closed = { hash: Hash; chunksPaid: number; refundWei: bigint; reason: string };
type Opened = { sessionId: bigint; hash: Hash; sessionKey: Address; maxChunks: number; gasAllowanceWei: bigint };

const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  opening: "Opening session",
  warming: "Preparing session key",
  streaming: "Streaming",
  closing: "Closing session",
  sweeping: "Sweeping leftover gas",
  done: "Session closed",
  error: "Something went wrong",
};

export default function Home() {
  const [info, setInfo] = useState<ProviderInfo>();
  const [wallet, setWallet] = useState<{ client: WalletClient; address: Address }>();
  const [prompt, setPrompt] = useState(SUGGESTIONS[0]);
  const [cap, setCap] = useState(CAPS[1]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState<string>();
  const [chunks, setChunks] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [opened, setOpened] = useState<Opened>();
  const [closed, setClosed] = useState<Closed>();
  const [swept, setSwept] = useState<{ hash: Hash; amountWei: bigint } | null>();
  const [error, setError] = useState<string>();
  const session = useRef<SipSession>(null);

  useEffect(() => {
    fetchProviderInfo().then(setInfo, (err) => setError(`Provider server unreachable: ${err.message}`));
  }, []);

  const active = phase !== "idle" && phase !== "done" && phase !== "error";
  const capWei = parseEther(cap);
  const spentWei = payments.reduce((a, p) => a + p.priceWei, 0n);
  const waitingForPayment = phase === "streaming" && chunks.length > payments.length;

  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  async function onConnect() {
    try {
      setError(undefined);
      const { wallet, address } = await connectWallet();
      setWallet({ client: wallet, address });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function onAsk() {
    if (!wallet || !info || active) return;
    setChunks([]);
    setTotal(0);
    setPayments([]);
    setOpened(undefined);
    setClosed(undefined);
    setSwept(undefined);
    setError(undefined);

    const s = new SipSession(wallet.client, wallet.address, info, {
      onPhase: (p, d) => {
        setPhase(p);
        setDetail(d);
      },
      onOpened: setOpened,
      onChunk: ({ index, text, total }) => {
        setTotal(total);
        setChunks((prev) => {
          const next = [...prev];
          next[index] = text;
          return next;
        });
      },
      onPayment: (p) => setPayments((prev) => [...prev, p]),
      onClosed: setClosed,
      onSwept: setSwept,
      onError: setError,
    });
    session.current = s;
    void s.start(prompt, capWei);
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Sip<span className="text-monad">402</span>
          </h1>
          <p className="text-muted">Pay for AI by the sip. Every chunk settles on Monad before the next one arrives.</p>
        </div>
        {wallet ? (
          <a
            href={explorerAddress(wallet.address)}
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-line bg-panel px-4 py-2 font-mono text-sm"
          >
            {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)} · Monad Testnet
          </a>
        ) : (
          <button onClick={onConnect} className="rounded-full bg-monad px-5 py-2 font-medium text-white hover:bg-monad/85">
            Connect wallet
          </button>
        )}
      </header>

      {error && (
        <div className="mt-6 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_340px]">
        <section className="space-y-4">
          <div className="rounded-2xl border border-line bg-panel p-4">
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={active}
                className="flex-1 rounded-xl border border-line bg-background px-4 py-3 outline-none focus:border-monad disabled:opacity-60"
                placeholder="Ask anything"
              />
              <select
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                disabled={active}
                className="rounded-xl border border-line bg-background px-3 py-3 font-mono text-sm disabled:opacity-60"
                aria-label="Spending cap"
              >
                {CAPS.map((c) => (
                  <option key={c} value={c}>
                    cap {c} MON
                  </option>
                ))}
              </select>
              {active && phase === "streaming" ? (
                <button
                  onClick={() => session.current?.stop()}
                  className="rounded-xl bg-red-500 px-6 py-3 font-semibold text-white hover:bg-red-500/85"
                >
                  Stop
                </button>
              ) : (
                <button
                  onClick={onAsk}
                  disabled={!wallet || !info || active || !prompt.trim()}
                  className="rounded-xl bg-monad px-6 py-3 font-semibold text-white hover:bg-monad/85 disabled:opacity-40"
                >
                  Ask
                </button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setPrompt(s)}
                  disabled={active}
                  className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-foreground disabled:opacity-40"
                >
                  {s}
                </button>
              ))}
            </div>
            {info && (
              <p className="mt-3 text-xs text-muted">
                {formatEther(info.pricePerChunk)} MON per chunk · up to {Number(capWei / info.pricePerChunk)} chunks · unspent
                balance is refunded
              </p>
            )}
          </div>

          <div className="min-h-72 rounded-2xl border border-line bg-panel p-6">
            {phase !== "idle" && (
              <div className="mb-4 flex items-center gap-2 text-sm">
                {active && <span className="h-2 w-2 animate-pulse rounded-full bg-monad" />}
                <span className="font-medium">{PHASE_LABEL[phase]}</span>
                {detail && <span className="text-muted">· {detail}</span>}
                {total > 0 && (
                  <span className="ml-auto font-mono text-muted">
                    {chunks.length}/{total} chunks
                  </span>
                )}
              </div>
            )}
            {chunks.length === 0 && phase === "idle" && (
              <p className="text-muted">Connect your wallet, pick a question and press Ask. You can stop at any moment.</p>
            )}
            <p className="text-lg leading-relaxed">
              {chunks.map((c, i) => (
                <span key={i} className={i < payments.length ? "chunk-in" : "chunk-in text-foreground/70"}>
                  {c}
                </span>
              ))}
              {waitingForPayment && <span className="ml-1 inline-block h-5 w-2 animate-pulse bg-monad align-middle" />}
            </p>
            {waitingForPayment && <p className="mt-3 text-xs text-muted">Paying for this chunk on Monad…</p>}

            {closed && (
              <div className="mt-6 rounded-xl border border-line bg-background/60 p-4 text-sm">
                <div className="font-medium">
                  Paid for {closed.chunksPaid} chunk{closed.chunksPaid === 1 ? "" : "s"} ({closed.reason})
                </div>
                <div className="mt-1 text-muted">
                  Refunded{" "}
                  <a href={explorerTx(closed.hash)} target="_blank" rel="noreferrer" className="font-mono text-foreground underline">
                    {formatEther(closed.refundWei)} MON
                  </a>{" "}
                  unspent cap.
                  {swept && (
                    <>
                      {" "}
                      Returned{" "}
                      <a href={explorerTx(swept.hash)} target="_blank" rel="noreferrer" className="font-mono text-foreground underline">
                        {Number(formatEther(swept.amountWei)).toFixed(4)} MON
                      </a>{" "}
                      leftover gas allowance.
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-line bg-panel p-5">
            <Glass spentWei={spentWei} capWei={capWei} />
            {opened && (
              <p className="mt-3 text-center text-xs text-muted">
                Session{" "}
                <a href={explorerTx(opened.hash)} target="_blank" rel="noreferrer" className="underline">
                  #{opened.sessionId.toString()}
                </a>{" "}
                · session key {opened.sessionKey.slice(0, 6)}…{opened.sessionKey.slice(-4)} · gas allowance{" "}
                {Number(formatEther(opened.gasAllowanceWei)).toFixed(3)} MON
              </p>
            )}
          </div>
          <div className="rounded-2xl border border-line bg-panel p-5">
            <h2 className="mb-3 text-sm font-medium">Live metrics</h2>
            <Metrics payments={payments} />
          </div>
          {payments.length > 0 && (
            <div className="rounded-2xl border border-line bg-panel p-5">
              <h2 className="mb-3 text-sm font-medium">Payments</h2>
              <PaymentLog payments={payments} />
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
