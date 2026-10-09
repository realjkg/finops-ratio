// Bare /tokenomics/embed — the playground without the AppShell, for iframe
// embedding (e.g. Webflow). The route stays out of SHELL_ROUTES
// (src/lib/shellRoutes.ts), which is what keeps this page chrome-free.
import { TokenomicsPlayground } from '@/tokenomics/TokenomicsPlayground';

export default function TokenomicsEmbed() {
  return (
    <div className="min-h-screen bg-void px-4 py-6 font-body text-txt">
      <div className="mx-auto max-w-6xl">
        <TokenomicsPlayground />
      </div>
    </div>
  );
}
