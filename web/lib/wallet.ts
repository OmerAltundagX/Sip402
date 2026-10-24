import { createWalletClient, custom, numberToHex, type Address, type EIP1193Provider, type WalletClient } from "viem";
import { monadTestnet } from "@sip402/shared/monad";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

/** Connects the injected wallet and makes sure it is on Monad Testnet. */
export async function connectWallet(): Promise<{ wallet: WalletClient; address: Address }> {
  const provider = window.ethereum;
  if (!provider) throw new Error("No browser wallet found. Install MetaMask or another injected wallet.");

  const wallet = createWalletClient({ chain: monadTestnet, transport: custom(provider) });
  const [address] = await wallet.requestAddresses();

  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(monadTestnet.id) }] });
  } catch {
    await wallet.addChain({ chain: monadTestnet });
  }

  return { wallet, address };
}
