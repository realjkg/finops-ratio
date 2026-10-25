// Custom HTML document: sets lang and inlines the theme pre-paint script.
import { Html, Head, Main, NextScript } from 'next/document';
import { withBasePath } from '@/lib/basePath';
import { PREPAINT_SCRIPT } from '@/theme/user';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta
          name="description"
          content="Ratio governs AI workload spend by measuring value, not just cost."
        />
        <link rel="icon" type="image/svg+xml" href={withBasePath('/favicon.svg')} />
        {/* Constant string: applies a stored built-in theme before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: PREPAINT_SCRIPT }} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}

