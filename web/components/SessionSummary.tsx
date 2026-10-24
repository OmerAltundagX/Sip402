import { formatEther, type Address, type Hash } from "viem";
import { explorerAddress, explorerTx } from "@sip402/shared/monad";
import { walletNetCost, type SessionSummary as Summary } from "@/lib/session";

const mon = (wei: bigint) => `${Number(formatEther(wei)).toFixed(6)} MON`;
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

function Link({ tx, address, children }: { tx?: Hash; address?: Address; children: React.ReactNode }) {
  const href = tx ? explorerTx(tx) : address ? explorerAddress(address) : undefined;
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-foreground">
      {children}
    </a>
  );
}

function Row({
  sign,
  label,
  detail,
  wei,
  strong,
}: {
  sign: "−" | "+" | "=" | "";
  label: string;
  detail?: React.ReactNode;
  wei: bigint;
  strong?: boolean;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-2 ${strong ? "font-semibold" : ""}`}>
      <div>
        <div>{label}</div>
        {detail && <div className="text-xs font-normal text-muted">{detail}</div>}
      </div>
      <div className="whitespace-nowrap font-mono">
        <span className="text-muted">{sign} </span>
        {mon(wei)}
      </div>
    </div>
  );
}

/** Where the money went, line by line, with the matching transactions on MonadVision. */
export function SessionSummary({ summary: s }: { summary: Summary }) {
  const addsUp = walletNetCost(s) === s.netCostWei;
  return (
    <div className="mt-6 rounded-xl border border-line bg-background/60 p-4 text-sm">
      <div className="mb-1 font-medium">Where the money went</div>
      <p className="mb-2 text-xs text-muted">
        Session owner <Link address={s.payer}>{short(s.payer)}</Link> · session key{" "}
        <Link address={s.sessionKey}>{short(s.sessionKey)}</Link>
      </p>

      <div className="divide-y divide-line">
        <Row
          sign="−"
          label="Deposited"
          detail={
            <>
              {mon(s.capWei)} spending cap + {mon(s.gasAllowanceWei)} gas allowance ·{" "}
              <Link tx={s.openTx}>openSession tx</Link>
            </>
          }
          wei={s.depositWei}
        />
        <Row
          sign="−"
          label="Network fee for opening"
          detail={<>paid by your wallet · <Link tx={s.openTx}>openSession tx</Link></>}
          wei={s.fees.openWei}
        />
        <Row
          sign="+"
          label="Refunded by the contract"
          detail={
            <>
              unspent cap, an internal transfer inside the <Link tx={s.closeTx}>close tx</Link>
            </>
          }
          wei={s.refundWei}
        />
        <Row
          sign="+"
          label="Leftover gas returned"
          detail={s.sweepTx ? <Link tx={s.sweepTx}>sweep tx</Link> : "nothing left to sweep"}
          wei={s.sweptWei}
        />
        <Row sign="=" label="Net cost" wei={s.netCostWei} strong />
      </div>

      <div className="mt-3 rounded-lg border border-line p-3">
        <div className="mb-1 text-xs uppercase tracking-wide text-muted">Net cost breakdown</div>
        <div className="divide-y divide-line">
          <Row
            sign=""
            label="Paid to provider"
            detail={
              <>
                {s.chunksPaid} chunk{s.chunksPaid === 1 ? "" : "s"} × {mon(s.priceWei)} to{" "}
                <Link address={s.provider}>{short(s.provider)}</Link> · one pay() tx each, listed under Payments
              </>
            }
            wei={s.paidToProviderWei}
          />
          <Row
            sign=""
            label="Network fees spent"
            detail={
              <>
                open {mon(s.fees.openWei)} · {s.chunksPaid} payments {mon(s.fees.paysWei)} ·{" "}
                <Link tx={s.closeTx}>close</Link> {mon(s.fees.closeWei)}
                {s.sweepTx && (
                  <>
                    {" "}
                    · <Link tx={s.sweepTx}>sweep</Link> {mon(s.fees.sweepWei)}
                  </>
                )}
              </>
            }
            wei={s.fees.totalWei}
          />
          {s.dustWei > 0n && (
            <Row
              sign=""
              label="Left on the session key"
              detail={
                <>
                  gas price headroom the sweep reserved but was not charged ·{" "}
                  <Link address={s.sessionKey}>session key</Link>
                </>
              }
              wei={s.dustWei}
            />
          )}
        </div>
      </div>

      <p className={`mt-2 text-xs ${addsUp ? "text-muted" : "text-red-300"}`}>
        {addsUp
          ? "✓ Adds up: deposit + opening fee − refund − returned gas = paid to provider + network fees" +
            (s.dustWei > 0n ? " + leftover on the session key." : ".")
          : `Mismatch of ${mon(walletNetCost(s) - s.netCostWei)}; please report this.`}
      </p>
    </div>
  );
}
