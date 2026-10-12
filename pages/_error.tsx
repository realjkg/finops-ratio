// Custom error page for 404 and 500. Next's built-in one ships an inline style element, which the
// Content-Security-Policy (style-src 'self') blocks; this page uses only the app's own classes.
// (pages/404.tsx would be a page route that the RBAC route matrix must list; _error is exempt.)
import Link from 'next/link';
import type { NextPageContext } from 'next';

export default function ErrorPage({ statusCode }: { statusCode: number }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-void p-6 text-txt">
      <h1 className="font-mono text-lg">{statusCode === 404 ? '404: page not found' : `Error ${statusCode}`}</h1>
      <p className="text-sm text-sub">{statusCode === 404 ? 'That address does not exist in Ratio.' : 'Something went wrong on our side.'}</p>
      <Link href="/" className="rounded border border-edge bg-raised px-3 py-1 font-mono text-xs text-txt hover:bg-slab">Back to Findings</Link>
    </main>
  );
}

ErrorPage.getInitialProps = ({ res, err }: NextPageContext) => ({ statusCode: res?.statusCode ?? err?.statusCode ?? 404 });
