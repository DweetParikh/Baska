import Link from "next/link";
import { Card } from "@/components/ui";

const SECTIONS: [string, string][] = [
  ["What is a Baska fund?", "A fund is an on-chain vault holding a basket of tokenized stocks plus a USDC buffer. You deposit USDC and receive fund shares. Share price (NAV) is the vault's total value divided by shares outstanding. There is no promised yield: the price moves with the underlying stocks."],
  ["Depositing", "Deposits mint shares at the current NAV. A 0.5% slippage guard is set as the minimum shares you accept. Deposits need fresh oracle prices (under 60 seconds old), so they pause automatically if the price feed is down."],
  ["Withdrawing", "You can redeem shares for USDC from the fund's idle buffer, or redeem in kind to receive your pro-rata share of every asset the fund holds. In-kind redemption never needs a price and is never paused."],
  ["Rebalancing", "A keeper bot deploys idle USDC into the target weights and rebalances when holdings drift. Swaps are checked on-chain against NAV-slippage and drift limits."],
  ["Prices and devnet", "This deployment runs on Solana devnet with mock tokens that have no value. Oracle prices are copied from real US equity quotes by a price-updater service, so values move with the real market but nothing is redeemable for real assets."],
  ["Risks", "Share prices can fall. Tokenized securities may carry eligibility and jurisdiction restrictions. This software is a demo and has not been audited. Nothing here is investment advice."],
];

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Docs</h1>
        <p className="mt-2 text-soft">How Baska works, in plain language.</p>
      </div>
      {SECTIONS.map(([title, body]) => (
        <Card key={title}>
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-soft">{body}</p>
        </Card>
      ))}
      <Link href="/markets" className="inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark">
        Explore markets
      </Link>
    </div>
  );
}
