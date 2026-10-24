import { formatEther } from "viem";
import { explorerTx } from "@sip402/shared/monad";
import type { Payment } from "@/lib/session";

export function PaymentLog({ payments }: { payments: Payment[] }) {
  if (payments.length === 0) return null;
  return (
    <ol className="max-h-64 space-y-1 overflow-y-auto pr-1 font-mono text-xs">
      {[...payments].reverse().map((p) => (
        <li key={p.hash} className="chunk-in flex items-center justify-between gap-2 rounded-lg bg-background/60 px-3 py-2">
          <span className="text-muted">#{p.index + 1}</span>
          <span>{formatEther(p.priceWei)} MON</span>
          <span className="text-monad-light">{p.confirmMs.toFixed(0)} ms</span>
          <a
            href={explorerTx(p.hash)}
            target="_blank"
            rel="noreferrer"
            className="text-muted underline decoration-dotted hover:text-foreground"
          >
            {p.hash.slice(0, 8)}…{p.hash.slice(-4)}
          </a>
        </li>
      ))}
    </ol>
  );
}
