import { formatEther } from "viem";

/** A glass that fills with every paid chunk; the empty part is what will be refunded. */
export function Glass({ spentWei, capWei }: { spentWei: bigint; capWei: bigint }) {
  const ratio = capWei > 0n ? Math.min(Number((spentWei * 10_000n) / capWei) / 10_000, 1) : 0;
  // Glass interior spans y = 24..196 in the SVG viewBox.
  const top = 24;
  const height = 172;
  const liquidY = top + height * (1 - ratio);

  return (
    <div className="flex flex-col items-center gap-3">
      <svg viewBox="0 0 160 220" className="h-56 w-40" aria-label={`${Math.round(ratio * 100)}% of the cap spent`}>
        <defs>
          <clipPath id="glass-inside">
            <path d="M22 24 L138 24 L124 196 Q123 204 115 204 L45 204 Q37 204 36 196 Z" />
          </clipPath>
          <linearGradient id="liquid" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#b9acff" />
            <stop offset="100%" stopColor="#6a52f5" />
          </linearGradient>
        </defs>
        <g clipPath="url(#glass-inside)">
          <rect
            x="0"
            y={liquidY}
            width="160"
            height={220 - liquidY}
            fill="url(#liquid)"
            style={{ transition: "y 0.45s ease-out, height 0.45s ease-out" }}
          />
          {ratio > 0 && (
            <ellipse cx="80" cy={liquidY} rx="70" ry="4" fill="#d6ceff" opacity="0.7" style={{ transition: "cy 0.45s ease-out" }} />
          )}
        </g>
        <path
          d="M22 24 L138 24 L124 196 Q123 204 115 204 L45 204 Q37 204 36 196 Z"
          fill="none"
          stroke="#cfc7ee"
          strokeOpacity="0.55"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path d="M34 40 L44 180" stroke="#ffffff" strokeOpacity="0.18" strokeWidth="5" strokeLinecap="round" />
      </svg>
      <div className="text-center font-mono text-sm">
        <span className="text-lg text-foreground">{formatEther(spentWei)}</span>
        <span className="text-muted"> / {formatEther(capWei)} MON</span>
      </div>
    </div>
  );
}
