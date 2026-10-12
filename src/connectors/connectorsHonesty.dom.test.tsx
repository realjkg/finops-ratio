// @vitest-environment happy-dom
// Honesty on anonymous /connectors: offline sandbox seeds are never counted or labeled "live"; the
// AI-spend-vs-total view is linked; and the page says the Ingested path needs authentication.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Connectors from '../../pages/connectors';
import { OFFLINE_SANDBOX_SOURCE_IDS } from '@/costsource/sandboxSources';
import { sourcesForEnv } from '@/costsource/seed';
import { useStore } from '@/store/useStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SOURCES = sourcesForEnv({});
let root: Root | undefined;
const container = document.createElement('div');

beforeEach(async () => {
  useStore.setState({ connectorSessions: {}, ingestRuns: {}, connectorBusy: null, simulation: null });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(SOURCES)));
  await act(async () => {
    root = createRoot(container);
    root.render(<Connectors />);
  });
  await vi.waitFor(() => expect(container.textContent).toContain('Live connector status requires'));
});
afterEach(() => {
  act(() => root?.unmount());
  vi.unstubAllGlobals();
});

it('counts offline sandbox seeds as seeded and reports 0 live', () => {
  const text = container.textContent ?? '';
  expect(SOURCES.filter((s) => s.configured && !OFFLINE_SANDBOX_SOURCE_IDS.has(s.id))).toHaveLength(0);
  expect(text).not.toMatch(/\d+\s*\/\s*\d+\s*live/i);
  for (const label of ['Public cloud', 'Private cloud', 'On-prem']) {
    expect(text).toMatch(new RegExp(`${label} · \\d+ of \\d+ seeded · 0 live`));
  }
});

it('does not call the seeded sandbox section "Active"', () => {
  const text = container.textContent ?? '';
  expect(text).not.toMatch(/Active\s*—/);
  expect(text).toContain('Offline sandbox — 6 seeded adapters, none live');
});

it('links /costsource and states that only the Static seed is shown anonymously', () => {
  const link = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/costsource');
  expect(link?.textContent).toContain('AI spend vs total cloud spend');
  expect(container.textContent).toContain('The Ingested path needs an authenticated connection; only the Static seed is shown here.');
});
