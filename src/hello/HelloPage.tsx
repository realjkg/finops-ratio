// Standalone /hello route — demonstrates the HelloClient seam with a mock/live
// toggle. Isolated from the main 3-panel Ratio app; does not touch the store.
import Link from 'next/link';
import { useState, useCallback } from 'react';
import { createHelloClient } from './index';
import type { HelloMessage } from './index';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: HelloMessage }
  | { status: 'error'; message: string };

export function HelloPage() {
  const [clientMode, setClientMode] = useState<'mock' | 'live'>('mock');
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });

  const fetchGreeting = useCallback(async () => {
    setLoadState({ status: 'loading' });
    try {
      const client = createHelloClient(clientMode);
      const data = await client.getGreeting();
      setLoadState({ status: 'success', data });
    } catch (err) {
      setLoadState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [clientMode]);

  const sourceColor =
    loadState.status === 'success'
      ? loadState.data.source === 'mock'
        ? 'text-shape'
        : 'text-value'
      : '';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-void px-4 font-body text-txt">
      {/* Card */}
      <div className="w-full max-w-md rounded-card border border-edge bg-slab p-8">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight text-txt">
          Hello World
        </h1>
        <p className="mb-6 text-sm text-sub">
          Ratio client seam demo — swap between mock and live backends without
          touching this component.
        </p>

        {/* Mode toggle */}
        <div className="mb-6 flex gap-2">
          {(['mock', 'live'] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setClientMode(m);
                setLoadState({ status: 'idle' });
              }}
              className={[
                'rounded-card border px-4 py-1.5 text-sm font-medium transition-colors',
                clientMode === m
                  ? m === 'mock'
                    ? 'border-shape bg-shape/10 text-shape'
                    : 'border-value bg-value/10 text-value'
                  : 'border-edge bg-raised text-sub hover:text-txt',
              ].join(' ')}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Fetch button */}
        <button
          onClick={fetchGreeting}
          disabled={loadState.status === 'loading'}
          className="mb-6 w-full rounded-card bg-gate px-4 py-2 text-sm font-semibold text-void transition-opacity disabled:opacity-50"
        >
          {loadState.status === 'loading' ? 'Fetching…' : 'Get Greeting'}
        </button>

        {/* Result — idle */}
        {loadState.status === 'idle' && (
          <p className="text-center text-sm text-dim">
            Press the button to fetch a greeting.
          </p>
        )}

        {/* Result — success */}
        {loadState.status === 'success' && (
          <div className="space-y-3 rounded-card border border-edge bg-deep p-4">
            <p className="text-base text-txt">{loadState.data.message}</p>
            <dl className="space-y-1 text-xs">
              <div className="flex justify-between">
                <dt className="text-sub">source</dt>
                <dd className={`font-mono font-semibold ${sourceColor}`}>
                  {loadState.data.source}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sub">timestamp</dt>
                <dd className="font-mono text-dim">{loadState.data.timestamp}</dd>
              </div>
            </dl>
          </div>
        )}

        {/* Result — error */}
        {loadState.status === 'error' && (
          <div className="rounded-card border border-cost/40 bg-cost/10 p-4">
            <p className="text-sm font-medium text-cost">Error</p>
            <p className="mt-1 text-xs text-sub">{loadState.message}</p>
          </div>
        )}
      </div>

      {/* Back link */}
      <Link href="/" className="mt-6 text-xs text-dim hover:text-sub">
        ← back to Ratio
      </Link>
    </div>
  );
}

