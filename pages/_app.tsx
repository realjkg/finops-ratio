// Global CSS must be imported in _app — nowhere else in the Pages Router.
import '../src/index.css';
import type { AppProps } from 'next/app';
import { useRouter } from 'next/router';
import { PersonaProvider } from '@/components/PersonaProvider';
import { AppShell } from '@/components/layout/AppShell';
import { NAV_ITEMS } from '@/components/layout/NavBar';

// The six north-star objects share one AppShell (nav + agent launcher + chat).
// /demo also uses the shell so a self-service visitor gets the same navigation
// and real Ratio AI launcher while trying the product. Other legacy/demo routes
// (/mission, /finio, /hello, /tokenomics, /prediction, /costsource) remain bare.
const SHELL_ROUTES = new Set<string>([
  ...NAV_ITEMS.map((item) => item.href),
  '/demo',
]);

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
