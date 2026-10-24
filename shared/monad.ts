import { defineChain } from "viem";

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: {
    default: { name: "MonadVision", url: "https://testnet.monadvision.com" },
  },
  testnet: true,
});

export const SIP402_ADDRESS = "0x0654aB49C0AF16c0E660E84A8A879e497095a6D8" as const;

// Monad charges gas_limit, not gas_used, so limits are kept tight. Receipts and
// traces on Monad report gasUsed = gas limit, so execution gas was measured
// with eth_estimateGas on testnet (state overrides for pay/close).
//
// Monad prices cold storage per page: a session whose three struct slots
// straddle a page boundary pays one extra cold access (+8,095 gas). The web
// client therefore estimates each call for the actual session and adds
// GAS_BUFFER_PCT; these worst-case values (+15%, rounded up) are only the
// fallback and the gas allowance budget, so they always cover the per-session limit.
//
// 15% is larger than the +8,095 page-crossing cost (~13-15%), so even an
// estimate taken on a non-crossing path cannot leave pay()/close() short.
export const GAS_BUFFER_PCT = 15n;
export const GAS_LIMITS = {
  openSession: 175_000n, // measured 143,732 (~151,800 if the new session straddles a page)
  pay: 73_000n, // measured 54,683, straddling 62,778 (provider already holds MON)
  payFirstToEmptyProvider: 102_000n, // measured 79,981, straddling 88,076 (creates provider account)
  close: 73_000n, // measured 54,901, straddling 62,996 (via session key)
  transfer: 21_000n, // sweep: exact, a plain transfer always uses 21,000
} as const;

/**
 * maxFeePerGas = base fee + this % + priority fee. The effective price is
 * min(base + priority, maxFee), so headroom is only a cap; it mainly sizes the
 * gas allowance (swept back). Monad's base fee is floored at 100 gwei and rises slowly.
 */
export const BASE_FEE_HEADROOM_PCT = 10n;

export const explorerTx = (hash: string) => `${monadTestnet.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (address: string) =>
  `${monadTestnet.blockExplorers.default.url}/address/${address}`;
