import {
  createWalletClient,
  custom,
  getAddress,
  hexToNumber,
  numberToHex,
  type Address,
  type EIP1193Provider,
  type Hex,
  type WalletClient,
} from "viem";
import { monadTestnet } from "@sip402/shared/monad";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export type WalletState = { client: WalletClient; address: Address; chainId: number };

function injected(): EIP1193Provider {
  const provider = window.ethereum;
  if (!provider) throw new Error("No browser wallet found. Install MetaMask, Rabby or another injected wallet.");
  return provider;
}

const clientFor = (provider: EIP1193Provider) => createWalletClient({ chain: monadTestnet, transport: custom(provider) });

/** Connects the injected wallet (with a prompt) and makes sure it is on Monad Testnet. */
export async function connectWallet(): Promise<WalletState> {
  const provider = injected();
  const client = clientFor(provider);
  const [address] = await client.requestAddresses();
  await switchToMonad();
  return { client, address, chainId: await client.getChainId() };
}

/** Returns the already-authorized account without prompting, if there is one. */
export async function reconnectWallet(): Promise<WalletState | undefined> {
  const provider = window.ethereum;
  if (!provider) return undefined;
  const client = clientFor(provider);
  const [address] = await client.getAddresses();
  if (!address) return undefined;
  return { client, address, chainId: await client.getChainId() };
}

export async function switchToMonad() {
  const provider = injected();
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(monadTestnet.id) }] });
  } catch {
    await clientFor(provider).addChain({ chain: monadTestnet });
  }
}

/** Subscribes to account and network changes in the wallet. Returns an unsubscribe function. */
export function watchWallet(handlers: { onAccount: (address?: Address) => void; onChain: (chainId: number) => void }) {
  const provider = window.ethereum;
  if (!provider) return () => {};
  const onAccounts = (accounts: Address[]) => handlers.onAccount(accounts[0] ? getAddress(accounts[0]) : undefined);
  const onChain = (chainId: string) => handlers.onChain(hexToNumber(chainId as Hex));
  provider.on("accountsChanged", onAccounts);
  provider.on("chainChanged", onChain);
  return () => {
    provider.removeListener("accountsChanged", onAccounts);
    provider.removeListener("chainChanged", onChain);
  };
}
