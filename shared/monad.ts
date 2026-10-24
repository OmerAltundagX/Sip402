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

// Monad charges gas_limit, not gas_used, so limits are kept tight.
// Measured on Monad testnet with eth_estimateGas, plus ~10% headroom.
export const GAS_LIMITS = {
  openSession: 160_000n, // measured 143,720
  pay: 61_000n, // measured 54,683 (provider already holds MON)
  payFirstToEmptyProvider: 88_000n, // measured 79,981 (creates provider account)
  close: 61_000n, // measured 54,901 via session key, 44,655 via payer
} as const;

export const explorerTx = (hash: string) => `${monadTestnet.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (address: string) =>
  `${monadTestnet.blockExplorers.default.url}/address/${address}`;
