// /tokenomics — the self-serve scenario playground on seeded data (shell
// route). Visitors move model-mix / volume / growth sliders and watch cost,
// value, the value ratio, and the three integrity layers recompute
// instantly — all client-side over src/tokenomics seeds; no mode toggle, no
// run button. A bare variant for iframe embedding lives at /tokenomics/embed.
import Link from 'next/link';
import { TokenomicsPlayground } from './TokenomicsPlayground';

export function TokenomicsPage() {
  return (
    <div className="min-h-screen bg-void px-4 py-10 font-body text-txt">
      <div className="mx-auto max-w-6xl">
        <TokenomicsPlayground />
        <Link href="/" className="mt-8 block text-center text-xs text-dim hover:text-sub">
          ← back to Ratio
        </Link>
      </div>
    </div>
  );
}
