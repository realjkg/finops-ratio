// Global CSS must be imported in _app — nowhere else in the Pages Router.
import '../src/index.css';
import type { AppProps } from 'next/app';
import { useRouter } from 'next/router';
import { PersonaProvider } from '@/components/PersonaProvider';
import { AppShell } from '@/components/layout/AppShell';
import { NAV_ITEMS } from '@/components/layout/NavBar';

// The six north-star objects share one AppShell (nav + agent launcher + chat).
// Legacy/demo routes (/mission, /finio, /hello, /tokenomics, /prediction,
// /costsource) stay reachable by URL but render bare — they are not part of the
// six-object IA and carry no shared nav.
const SHELL_ROUTES = new Set<string>(NAV_ITEMS.map((item) => item.href));

export default function RatioApp({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const useShell = SHELL_ROUTES.has(router.pathname);
  const page = <Component {...pageProps} />;

  // Persona context wraps every page so the active lens (executive default /
  // technical / procurement) is available app-wide.
  return (
    <PersonaProvider>
      {useShell ? <AppShell>{page}</AppShell> : page}
    </PersonaProvider>
  );
}

