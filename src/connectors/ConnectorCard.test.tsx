// ConnectorCard — H3: the browser "Test connection" only probes offline sandbox
// sources. Live connectors are probed through the authenticated API
// (GET /api/v1/connectors?probe=true); no token ever reaches the browser.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectorCard } from './ConnectorCard';
import { sourcesForEnv } from '@/costsource/seed';
import type { CostSourceDescriptor } from '@/costsource/CostSourceClient';

const onTest = async () => {
  throw new Error('not called during render');
};

function sourceById(id: string): CostSourceDescriptor {
  const src = sourcesForEnv({ KUBERNETES_FOCUS_ENDPOINT: 'https://billing.internal/focus.csv' }).find((s) => s.id === id);
  if (!src) throw new Error(`missing ${id}`);
  return src;
}

function testButton(html: string): string {
  const m = html.match(/<button[^>]*>(?:Testing…|Test connection)<\/button>/);
  if (!m) throw new Error('Test connection button not rendered');
  return m[0];
}

describe('ConnectorCard — Test connection gating (H3)', () => {
  it('enables Test connection for an offline sandbox source', () => {
    const html = renderToStaticMarkup(<ConnectorCard source={sourceById('pointfive-sandbox')} onTest={onTest} />);
    expect(testButton(html)).not.toMatch(/\sdisabled=""/);
  });

  it('disables Test connection for a connected live connector and points to the authenticated API', () => {
    const live = sourceById('kubernetes');
    expect(live.configured).toBe(true);
    const html = renderToStaticMarkup(<ConnectorCard source={live} onTest={onTest} />);
    expect(testButton(html)).toMatch(/\sdisabled=""/);
    expect(html).toContain('GET /api/v1/connectors?probe=true');
  });
});
