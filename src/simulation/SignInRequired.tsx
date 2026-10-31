// Signed-out state for the customer-simulation pages: explains what the page is
// and offers the two ways forward, instead of a lone heading and link.
import Link from 'next/link';

export function SignInRequired({ title, detail, loading = false }: { title: string; detail: string; loading?: boolean }) {
  return (
    <div className="h-full overflow-y-auto px-4 py-10 sm:px-8">
      <section className="mx-auto max-w-xl rounded-lg border border-edge bg-deep p-6 sm:p-8" aria-busy={loading}>
        <p className="text-xs font-semibold uppercase tracking-wider text-unit">Customer simulation</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-txt">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-sub">{loading ? 'Restoring your workspace…' : detail}</p>
        <p className="mt-2 text-sm leading-6 text-sub">
          Sign in with a simulated customer identity to continue. No password, personal account or cloud credential is used.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Link href="/simulation" className="sim-button">Choose a simulated identity</Link>
          <Link href="/demo" className="text-sm text-unit underline">Back to the seeded demo</Link>
        </div>
      </section>
    </div>
  );
}
