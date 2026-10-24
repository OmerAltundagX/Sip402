import { formatEther } from "viem";
import { ETHEREUM_BLOCK_TIME_MS } from "@/lib/config";
import type { Payment } from "@/lib/session";

const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const formatMon = (wei: bigint) => Number(formatEther(wei)).toFixed(4);

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-background/60 p-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 font-mono text-xl">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Metrics({ payments }: { payments: Payment[] }) {
  if (payments.length === 0) {
    return <p className="text-sm text-muted">Metrics appear after the first payment confirms.</p>;
  }

  const confirm = payments.map((p) => p.confirmMs);
  const avgConfirm = avg(confirm);
  const avgFee = payments.reduce((a, p) => a + p.feeWei, 0n) / BigInt(payments.length);
  const price = payments[0].priceWei;
  const monadTotalS = confirm.reduce((a, b) => a + b, 0) / 1000;
  const ethereumTotalS = (payments.length * ETHEREUM_BLOCK_TIME_MS) / 1000;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Payments" value={String(payments.length)} />
        <Stat
          label="Avg confirmation"
          value={`${avgConfirm.toFixed(0)} ms`}
          hint={`last ${confirm.at(-1)!.toFixed(0)} ms · send → receipt`}
        />
        <Stat label="Chunk price" value={`${formatMon(price)} MON`} hint="paid to the provider" />
        <Stat label="Avg network fee" value={`${formatMon(avgFee)} MON`} hint="gas limit × gas price (Monad charges the limit)" />
      </div>

      <div className="rounded-xl border border-line bg-background/60 p-3">
        <div className="text-xs uppercase tracking-wide text-muted">Same payments, waiting for confirmation</div>
        <div className="mt-2 space-y-2 font-mono text-sm">
          <Bar label="Monad (measured)" seconds={monadTotalS} max={ethereumTotalS} accent />
          <Bar label="Ethereum (estimate)" seconds={ethereumTotalS} max={ethereumTotalS} />
        </div>
        <p className="mt-2 text-xs text-muted">
          Ethereum estimate assumes each payment lands in the next 12 s block, which is a best case. Monad times are measured
          live in this browser.
        </p>
      </div>
    </div>
  );
}

function Bar({ label, seconds, max, accent }: { label: string; seconds: number; max: number; accent?: boolean }) {
  const width = Math.max((seconds / max) * 100, 1.5);
  return (
    <div>
      <div className="flex justify-between">
        <span className="text-muted">{label}</span>
        <span>{seconds.toFixed(1)} s</span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-line">
        <div
          className={`h-2 rounded-full ${accent ? "bg-monad" : "bg-muted/60"}`}
          style={{ width: `${width}%`, transition: "width 0.4s ease-out" }}
        />
      </div>
    </div>
  );
}
