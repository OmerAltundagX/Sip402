import { useEffect, useRef } from "react";
import { formatEther } from "viem";
import { explorerTx } from "@sip402/shared/monad";
import type { Payment } from "@/lib/session";

const MAX_ROWS = 50;
const shortHash = (hash: string) => `${hash.slice(0, 6)}…${hash.slice(-4)}`;

/** One row per paid chunk, newest on top; the in-flight payment shows as a pending row. */
export function LivePayments({
  payments,
  pending,
}: {
  payments: Payment[];
  pending?: { index: number; priceWei: bigint };
}) {
  const list = useRef<HTMLOListElement>(null);

  // Newest rows are on top, so keep the list scrolled to the top as they arrive.
  useEffect(() => {
    list.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [payments.length, pending?.index]);

  if (payments.length === 0 && !pending) {
    return <p className="text-sm text-muted">Each paid sip appears here with its Monad transaction.</p>;
  }

  const rows = payments.slice(-MAX_ROWS).reverse();
  return (
    <ol ref={list} className="max-h-80 space-y-1.5 overflow-y-auto pr-1 font-mono text-sm">
      {pending && (
        <li
          key={`pending-${pending.index}`}
          className="slide-in flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-muted"
        >
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-monad border-t-transparent" />
          <span>Sip #{pending.index + 1}</span>
          <span>· {formatEther(pending.priceWei)} MON</span>
          <span className="ml-auto">confirming…</span>
        </li>
      )}
      {rows.map((p) => (
        <li key={p.hash} className="slide-in flex items-center gap-3 rounded-lg bg-background/60 px-3 py-2">
          <span className="text-emerald-400">✓</span>
          <span>Sip #{p.index + 1}</span>
          <span className="text-muted">· {formatEther(p.priceWei)} MON</span>
          <span className="text-monad-light">· {p.confirmMs.toFixed(0)} ms</span>
          <a
            href={explorerTx(p.hash)}
            target="_blank"
            rel="noreferrer"
            title={p.hash}
            className="ml-auto text-muted underline decoration-dotted hover:text-foreground"
          >
            {shortHash(p.hash)} tx ↗
          </a>
        </li>
      ))}
    </ol>
  );
}
