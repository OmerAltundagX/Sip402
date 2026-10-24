"use client";

import { useEffect, useRef, useState } from "react";
import { formatEther, type Address, type Hash } from "viem";
import { explorerAddress, explorerTx, monadTestnet } from "@sip402/shared/monad";
import { Glass } from "@/components/Glass";
import { Metrics } from "@/components/Metrics";
import { LivePayments } from "@/components/LivePayments";
import { SessionSummary } from "@/components/SessionSummary";
import {
  fetchProviderInfo,
  SipSession,
  type EndReason,
  type Payment,
  type Phase,
  type PriceTier,
  type ProviderInfo,
  type SessionSummary as Summary,
} from "@/lib/session";
import { connectWallet, reconnectWallet, switchToMonad, watchWallet, type WalletState } from "@/lib/wallet";

const SUGGESTIONS = ["How does Sip402 work?", "Why is Monad so fast?", "Why pay for AI by the chunk?"];
/** Spending cap in sips; the deposit is sips × the tier's price. */
const SIP_CAPS = [10, 20, 30];

type Closed = { hash: Hash; chunksPaid: number; refundWei: bigint; reason: EndReason };
type Opened = { sessionId: bigint; hash: Hash; sessionKey: Address; maxChunks: number; gasAllowanceWei: bigint };

const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  opening: "Opening session",
  warming: "Preparing session key",
  streaming: "Streaming",
  paused: "Paused",
  expired: "Stream timed out",
  closing: "Closing session",
  sweeping: "Sweeping leftover gas",
  done: "Session closed",
  error: "Something went wrong",
};

/** Final status, so a finished answer never looks like a cancellation. */
const END_LABEL: Record<EndReason, string> = {
  completed: "Answer complete",
  cancelled: "Cancelled",
  cap: "Spending cap reached",
  error: "Closed after an error",
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function Home() {
  const [info, setInfo] = useState<ProviderInfo>();
  const [wallet, setWallet] = useState<WalletState>();
  /** The account that opened the current session; refunds and the sweep always go here. */
  const [owner, setOwner] = useState<Address>();
  const [sessionCap, setSessionCap] = useState<bigint>();
  const [prompt, setPrompt] = useState(SUGGESTIONS[0]);
  const [sips, setSips] = useState(SIP_CAPS[1]);
  const [tierId, setTierId] = useState<string>();
  /** Price the current session was opened with. */
  const [sessionPrice, setSessionPrice] = useState<bigint>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState<string>();
  const [chunks, setChunks] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [opened, setOpened] = useState<Opened>();
  const [closed, setClosed] = useState<Closed>();
  const [summary, setSummary] = useState<Summary>();
  /** Chunk whose pay() is in flight, for the live feed's pending row. */
  const [pendingSip, setPendingSip] = useState<number>();
  const [error, setError] = useState<string>();
  const session = useRef<SipSession>(null);

  useEffect(() => {
    fetchProviderInfo().then(setInfo, (err) => setError(`Provider server unreachable: ${err.message}`));
  }, []);

  // Pick up an already-authorized wallet, then follow account and network switches live.
  useEffect(() => {
    void reconnectWallet().then((w) => w && setWallet(w), () => {});
    return watchWallet({
      onAccount: (address) => {
        if (!address) return setWallet(undefined);
        void reconnectWallet().then(setWallet, () => {});
      },
      onChain: (chainId) => setWallet((prev) => (prev ? { ...prev, chainId } : prev)),
    });
  }, []);

  const active = phase !== "idle" && phase !== "done" && phase !== "error";
  const wrongChain = wallet !== undefined && wallet.chainId !== monadTestnet.id;
  const tiers: PriceTier[] = info
    ? info.tiers.length > 0
      ? info.tiers
      : [{ id: "default", label: "Standard", pricePerChunk: info.pricePerChunk }]
    : [];
  const tier = tiers.find((t) => t.id === tierId) ?? tiers[0];
  const nextCapWei = tier ? BigInt(sips) * tier.pricePerChunk : 0n;
  const capWei = sessionCap ?? nextCapWei;
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
      setWallet(await connectWallet());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSwitchNetwork() {
    try {
      await switchToMonad();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function onAsk() {
    if (!wallet || !info || !tier || active || wrongChain) return;
    const askCap = BigInt(sips) * tier.pricePerChunk;
    setChunks([]);
    setTotal(0);
    setPayments([]);
    setOpened(undefined);
    setClosed(undefined);
    setSummary(undefined);
    setPendingSip(undefined);
    setError(undefined);
    setOwner(wallet.address);
    setSessionCap(askCap);
    setSessionPrice(tier.pricePerChunk);

    // The tier only sets the session's price per chunk; everything else is unchanged.
    const s = new SipSession(wallet.client, wallet.address, { ...info, pricePerChunk: tier.pricePerChunk }, {
      onPhase: (p, d) => {
        setPhase(p);
        setDetail(d);
        // An in-flight payment still finishes while paused; any other end clears it.
        if (p !== "streaming" && p !== "paused") setPendingSip(undefined);
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
      onPaymentStart: setPendingSip,
      onPayment: (p) => {
        setPendingSip(undefined);
        setPayments((prev) => [...prev, p]);
      },
      onClosed: setClosed,
      onSwept: () => {},
      onSummary: setSummary,
      onError: setError,
    });
    session.current = s;
    void s.start(prompt, askCap);
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
            className={`rounded-full border bg-panel px-4 py-2 font-mono text-sm ${wrongChain ? "border-amber-400/60" : "border-line"}`}
          >
            {short(wallet.address)} · {wrongChain ? "Wrong network" : "Monad Testnet"}
          </a>
        ) : (
          <button onClick={onConnect} className="rounded-full bg-monad px-5 py-2 font-medium text-white hover:bg-monad/85">
            Connect wallet
          </button>
        )}
      </header>

      {wrongChain && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          <span>
            Your wallet is on another network. Sip402 runs on Monad Testnet.
            {active && " The current session keeps running: its session key talks to Monad directly."}
          </span>
          <button onClick={onSwitchNetwork} className="rounded-lg bg-amber-400/20 px-3 py-1.5 font-medium hover:bg-amber-400/30">
            Switch to Monad Testnet
          </button>
        </div>
      )}

      {error && (
        <div className="mt-6 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_340px]">
        <section className="space-y-4">
          <div className="rounded-2xl border border-line bg-panel p-4">
            {tiers.length > 1 && (
              <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Model tier">
                {tiers.map((t) => {
                  const selected = t.id === tier?.id;
                  return (
                    <button
                      key={t.id}
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setTierId(t.id)}
                      disabled={active}
                      className={`rounded-xl border px-4 py-2 text-left transition-colors disabled:cursor-not-allowed ${
                        selected
                          ? "border-monad bg-monad/15"
                          : "border-line bg-background hover:border-monad/60 disabled:opacity-40"
                      }`}
                    >
                      <div className="font-semibold">{t.label}</div>
                      <div className="font-mono text-xs text-muted">{formatEther(t.pricePerChunk)} MON per sip</div>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={active}
                className="flex-1 rounded-xl border border-line bg-background px-4 py-3 outline-none focus:border-monad disabled:opacity-60"
                placeholder="Ask anything"
              />
              <select
                value={sips}
                onChange={(e) => setSips(Number(e.target.value))}
                disabled={active}
                className="rounded-xl border border-line bg-background px-3 py-3 font-mono text-sm disabled:opacity-60"
                aria-label="Spending cap"
              >
                {SIP_CAPS.map((c) => (
                  <option key={c} value={c}>
                    up to {c} sips
                  </option>
                ))}
              </select>
              {phase === "streaming" || phase === "paused" || phase === "expired" ? (
                <div className="flex gap-2">
                  {phase === "streaming" && (
                    <button
                      onClick={() => session.current?.pause()}
                      className="rounded-xl border border-line bg-background px-5 py-3 font-semibold hover:border-monad"
                    >
                      Pause
                    </button>
                  )}
                  {phase === "paused" && (
                    <button
                      onClick={() => session.current?.resume()}
                      className="rounded-xl bg-monad px-5 py-3 font-semibold text-white hover:bg-monad/85"
                    >
                      Resume
                    </button>
                  )}
                  <button
                    onClick={() => session.current?.cancel()}
                    className="rounded-xl bg-red-500 px-5 py-3 font-semibold text-white hover:bg-red-500/85"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={onAsk}
                  disabled={!wallet || !info || active || wrongChain || !prompt.trim()}
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
            {tier && (
              <p className="mt-3 text-xs text-muted">
                {tier.label} · {formatEther(tier.pricePerChunk)} MON per sip · spending cap {formatEther(nextCapWei)} MON for up
                to {sips} sips · unspent balance is refunded
                {active && " · tier is locked while a session is open"}
              </p>
            )}
          </div>

          <div className="min-h-72 rounded-2xl border border-line bg-panel p-6">
            {phase !== "idle" && (
              <div className="mb-4 flex items-center gap-2 text-sm">
                {active && <span className="h-2 w-2 animate-pulse rounded-full bg-monad" />}
                <span className="font-medium">{phase === "done" && closed ? END_LABEL[closed.reason] : PHASE_LABEL[phase]}</span>
                {detail && <span className="text-muted">· {detail}</span>}
                {total > 0 && (
                  <span className="ml-auto font-mono text-muted">
                    {chunks.length}/{total} chunks
                  </span>
                )}
              </div>
            )}
            {chunks.length === 0 && phase === "idle" && (
              <p className="text-muted">
                Connect your wallet, pick a question and press Ask. Pause or cancel at any moment.
              </p>
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
            {phase === "paused" && (
              <p className="mt-3 text-xs text-muted">
                Paused. The session stays open on-chain and nothing is charged. Resume continues this answer without a new
                wallet prompt.
              </p>
            )}
            {phase === "expired" && (
              <div className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
                The provider closed this stream because it sat paused too long (about 5 minutes), so it can no longer be
                resumed. Your deposit
                is safe in the contract: press <span className="font-semibold">Cancel</span> to close the session and get the
                unspent balance back.
              </div>
            )}

            {closed && (
              <div
                className={`mt-6 rounded-xl border px-4 py-3 text-sm ${
                  closed.reason === "completed" ? "border-monad/50 bg-monad/10" : "border-line bg-background/60"
                }`}
              >
                <span className="font-medium">{END_LABEL[closed.reason]}.</span>{" "}
                <span className="text-muted">
                  {closed.reason === "completed"
                    ? `You read the whole answer and paid for all ${closed.chunksPaid} chunks.`
                    : `You paid for the ${closed.chunksPaid} chunk${closed.chunksPaid === 1 ? "" : "s"} you read; the rest of the cap was refunded.`}
                  {!summary && " Returning leftover gas…"}
                </span>
              </div>
            )}
            {summary && <SessionSummary summary={summary} />}
          </div>

          <div className="rounded-2xl border border-line bg-panel p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-medium">Live payments</h2>
              {payments.length > 0 && (
                <span className="font-mono text-xs text-muted">
                  {payments.length} sip{payments.length === 1 ? "" : "s"} settled on Monad
                </span>
              )}
            </div>
            <LivePayments
              payments={payments}
              pending={pendingSip !== undefined && sessionPrice ? { index: pendingSip, priceWei: sessionPrice } : undefined}
            />
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-line bg-panel p-5">
            <Glass spentWei={spentWei} capWei={capWei} />
            {owner && phase !== "idle" && (
              <p className="mt-3 text-center text-xs text-muted">
                Session owner{" "}
                <a href={explorerAddress(owner)} target="_blank" rel="noreferrer" className="font-mono underline">
                  {short(owner)}
                </a>{" "}
                · refunds and leftover gas go here
              </p>
            )}
            {owner && active && wallet?.address !== owner && (
              <p className="mt-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
                {wallet
                  ? `Your wallet switched to ${short(wallet.address)}. `
                  : "Your wallet disconnected. "}
                This session keeps running on its session key and still belongs to {short(owner)}; the refund goes there.
              </p>
            )}
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
        </aside>
      </div>
    </main>
  );
}
