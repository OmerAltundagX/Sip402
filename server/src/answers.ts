// Pre-generated answers keep the demo fast and deterministic.
// A live LLM can replace answerFor() later without changing the payment flow.

const ANSWERS: { match: RegExp; text: string }[] = [
  {
    match: /monad|fast|parallel|throughput/i,
    text:
      "Monad is an EVM-compatible Layer 1 built for speed without giving up decentralization. " +
      "It runs ten thousand transactions per second by separating consensus from execution, so validators agree on transaction order first and execute right after. " +
      "MonadBFT, its consensus protocol, produces a block about every four hundred milliseconds and finalizes it in under a second." +
      "Execution is optimistic and parallel: transactions run at the same time and are re-executed only when they truly conflict. " +
      "MonadDb, a custom state database, keeps storage reads from becoming the bottleneck on ordinary hardware. " +
      "Because it is fully EVM compatible, Solidity contracts and tools like Foundry and viem work unchanged. " +
      "For developers, this means confirmations that feel instant and gas that is cheap enough to pay for every small action. " +
      "That is exactly what makes per-chunk payments, like the ones funding this answer, practical without payment channels.",
  },
  {
    match: /sip402|how does|how it works|pay/i,
    text:
      "Sip402 lets you pay for an AI answer one piece at a time instead of buying a subscription. " +
      "When you start, you deposit a small spending cap into a smart contract and authorize a temporary session key. " +
      "The provider sends the first chunk of the answer, and the session key pays for it on Monad. " +
      "The provider waits until that payment is confirmed on-chain before sending the next chunk. " +
      "This repeats for every chunk, so neither side ever risks more than the price of a single chunk. " +
      "You can press Stop at any moment, and the contract refunds everything you did not spend. " +
      "Because Monad confirms transactions in well under a second, the payments keep pace with your reading. " +
      "Two AI agents that have never met can use the same flow, since trust comes from the chain rather than an account.",
  },
];

const FALLBACK =
  "Most AI products charge you up front, through a monthly subscription or a bundle of prepaid credits. " +
  "You pay the same whether the answer is brilliant or useless, and you only find out after the money is gone. " +
  "Metered billing exists, but it is settled at the end of the month by a company you have to trust. " +
  "Streaming payments change that relationship by tying every unit of value to a unit of payment. " +
  "If the answer stops being useful, you stop reading, and you stop paying in the same instant. " +
  "Providers benefit too, because each piece of work is paid before the next one starts, so there are no unpaid invoices. " +
  "This only works on a chain that confirms payments faster than people read and charges almost nothing per transaction. " +
  "With sub-second confirmations, every sentence can carry its own receipt.";

export function answerFor(prompt: string): string {
  return ANSWERS.find((a) => a.match.test(prompt))?.text ?? FALLBACK;
}

/** Splits text into chunks of whole sentences with at least `targetWords` words each. */
export function toChunks(text: string, targetWords: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    current += sentence;
    if (current.trim().split(/\s+/).length >= targetWords) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
