// /finio/demo — the live FinIO A2A exchange: mock/live toggle, FOCUS version
// negotiation, and the returned rows. The overview that links here is /finio.
import Head from 'next/head';
import { FinioPage } from '@/finio/FinioPage';

export default function FinioDemo() {
  return (
    <>
      <Head>
        <title>FinIO exchange | Ratio</title>
        <meta
          name="description"
          content="Run a FinIO agent-to-agent handshake and FOCUS export against seed data."
        />
      </Head>
      <FinioPage />
    </>
  );
}
