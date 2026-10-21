// Shared shell-routing contract: routes in this set render inside AppShell
// (nav + simulation bar + agent launcher); everything else renders bare.
// Imported by pages/_app.tsx and asserted by tests so the embed-route
// guarantee can't silently regress.
import { NAV_ITEMS } from '@/components/layout/NavBar';

export const SHELL_ROUTES: ReadonlySet<string> = new Set<string>([
  ...NAV_ITEMS.map((item) => item.href),
  '/demo', '/agent-workflows', '/workspace', '/outcomes', '/costsource', '/finio', '/finio/demo', '/prediction', '/tokenomics', '/attribution',
  // '/tokenomics/embed' is deliberately absent — the embed route renders bare
  // (no shell chrome) for iframe embedding.
]);
