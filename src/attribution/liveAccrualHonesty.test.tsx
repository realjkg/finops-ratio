import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MockAttributionClient } from './MockAttributionClient';
import { LiveAccrualBoard } from './LiveAccrualBoard';

it('replayed token and burn labels say simulated, never live', async () => {
  const report = await new MockAttributionClient().getAttributionReport('team');
  const html = renderToStaticMarkup(<LiveAccrualBoard report={report} />);
  expect(html).toContain('Tokens out (simulated)');
  expect(html).toContain('Tokens in (simulated)');
  expect(html).toContain('Portfolio burn (simulated)');
  expect(html).not.toMatch(/\(live\)/i);
});
