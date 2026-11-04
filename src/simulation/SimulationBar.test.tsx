import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SimulationBar } from './SimulationBar';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/' }) }));

describe('simulation bar', () => {
  const html = renderToStaticMarkup(<SimulationBar />);
  it('calls the public demo the sample workspace and states it is synthetic', () => {
    expect(html).toContain('Sample workspace');
    expect(html).not.toContain('Seeded demo');
    expect(html).toContain('Synthetic data · No live connections');
    expect(html).toContain('June 2026 · USD · Cost basis not stated');
    expect(html).not.toMatch(/Updated \d|min ago|Simulated costs/);
  });
});
