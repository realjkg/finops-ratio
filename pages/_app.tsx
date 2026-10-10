// Global CSS must be imported in _app — nowhere else in the Pages Router.
import '../src/index.css';
import { SimulationProvider } from '@/simulation/SimulationProvider';
import type { AppProps } from 'next/app';
import { useRouter } from 'next/router';
import { PersonaProvider } from '@/components/PersonaProvider';
import { AppShell } from '@/components/layout/AppShell';
import { SHELL_ROUTES } from '@/lib/shellRoutes';

// The six north-star objects share one AppShell (nav + agent launcher + chat).
// /demo also uses the shell so a self-service visitor gets the same navigation
// and Ratio AI launcher while trying the product. Fixture sandboxes share
// navigation; /mission and /hello remain legacy standalone routes, and
// /tokenomics/embed is deliberately bare (iframe embedding).

export default function RatioApp({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const useShell = SHELL_ROUTES.has(router.pathname);
  const page = <Component {...pageProps} />;

  // Persona context wraps every page so the active lens (executive default /
  // technical / procurement) is available app-wide.
  return (
    <PersonaProvider>
      <SimulationProvider>
      {useShell ? <AppShell>{page}</AppShell> : page}
    </SimulationProvider>
    </PersonaProvider>
  );
}
