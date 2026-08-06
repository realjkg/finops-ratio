// /finio — public overview of the FinIO A2A interchange.
// The live exchange it links to lives at /finio/demo.
import Head from 'next/head';
import { FinioOverviewPage } from '@/finio/FinioOverviewPage';

export default function Finio() {
  return (
    <>
      <Head>
        <title>FinIO — agent-to-agent FinOps interchange | Ratio</title>
        <meta
          name="description"
          content="Exchange FOCUS-shaped cost and value data between agents over HTTP. Standard FOCUS columns carry cost; x_Ratio extensions carry the value ratio."
        />
      </Head>
      <FinioOverviewPage />
    </>
  );
}
