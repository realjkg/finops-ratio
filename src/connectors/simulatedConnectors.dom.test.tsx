// @vitest-environment happy-dom
// Anonymous /connectors: every non-sandbox card is a labeled simulation over bundled fixtures. No
// auth banner, no Retry loop, and "Simulate connect" never touches the network (so it cannot count
// as a failed auth attempt). Sandbox cards keep their walk. A real 401 becomes a locked state.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Connectors from '../../pages/connectors';
import { LiveDataAuthError, type CostSourceClient } from '@/costsource';
import { OFFLINE_SANDBOX_SOURCE_IDS } from '@/costsource/sandboxSources';
import { sourcesForEnv } from '@/costsource/seed';
import { useStore } from '@/store/useStore';
import { ConnectorCard } from './ConnectorCard';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SOURCES = sourcesForEnv({});
const LIVE = SOURCES.filter((s) => !OFFLINE_SANDBOX_SOURCE_IDS.has(s.id));
const ILLUSTRATIVE = ['kubernetes', 'nutanix', 'pointfive-live'];
const fetchSpy = vi.fn(async () => Response.json(SOURCES)); // the anonymous /api/costsource/sources answer
let root: Root | undefined;
const container = document.createElement('div');

beforeEach(async () => {
  useStore.setState({ connectorSessions: {}, ingestRuns: {}, connectorBusy: null, simulation: null });
  vi.stubGlobal('fetch', fetchSpy);
  await act(async () => {
    root = createRoot(container);
    root.render(<Connectors />);
  });
  await vi.waitFor(() => expect(container.textContent).toContain('Live connector status requires'));
  fetchSpy.mockClear(); // only the mount-time registry fetch is allowed
});
afterEach(() => {
  act(() => root?.unmount());
  vi.unstubAllGlobals();
});

const card = (name: string) => {
  const h3 = [...container.querySelectorAll('h3')].find((h) => h.textContent === name);
  if (!h3?.parentElement) throw new Error(`no card for ${name}`);
  return h3.parentElement;
};
const buttons = (el: Element) => [...el.querySelectorAll('button')].map((b) => b.textContent ?? '');

it('non-sandbox cards are simulated: chip, note, Simulate connect, no auth banner or Retry', () => {
  expect(LIVE).toHaveLength(6);
  for (const src of LIVE) {
    const el = card(src.name);
    expect(el.textContent).toContain('simulated');
    expect(el.textContent).toContain('Live connection requires the authenticated API');
    expect(el.textContent).not.toContain('requires authenticated API access');
    expect(buttons(el)).toEqual(['Simulate connect']);
    expect(el.textContent?.includes('illustrative, format not verified')).toBe(ILLUSTRATIVE.includes(src.id));
  }
});

it('Simulate connect lands normalized fixture rows with zero network calls, even when repeated', async () => {
  for (const src of LIVE) {
    const el = card(src.name);
    for (let i = 0; i < 2; i++) {
      await act(async () => [...el.querySelectorAll('button')].find((b) => /Simulate|Re-ingest/.test(b.textContent ?? ''))!.click());
      await vi.waitFor(() => expect(el.textContent).toContain('Data landed'));
    }
    expect(el.textContent).toMatch(/Rows ingested\d/);
    expect(el.textContent).not.toMatch(/requires authenticated API access|Retry/);
  }
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('sandbox cards keep the plain Connect walk and no simulated chip', () => {
  for (const src of SOURCES.filter((s) => OFFLINE_SANDBOX_SOURCE_IDS.has(s.id))) {
    const el = card(src.name);
    expect(buttons(el)).toEqual(['Connect']);
    expect(el.textContent).not.toContain('simulated');
  }
});

it('a genuine LiveDataAuthError becomes a locked state with no Retry', async () => {
  const refused = { healthCheck: async () => Promise.reject(new LiveDataAuthError()) } as unknown as CostSourceClient;
  await useStore.getState().connectConnector('aws-data-exports', refused);
  const session = useStore.getState().connectorSessions['aws-data-exports'];
  expect(session.state).toBe('locked');
  const html = renderToStaticMarkup(<ConnectorCard source={LIVE[0]} session={session} onConnect={() => {}} />);
  expect(html).toContain('Locked: needs authenticated API access');
  expect(html).not.toMatch(/Retry|<button/);
});
