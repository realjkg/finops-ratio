// #5 — the /costsource page renders each row in its own BillingCurrency; it
// never assumes USD (mixed-currency exports are legitimate).

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatMoney } from '@/lib/format';
import { FocusRowsCard } from './CostSourcePage';
import { normalizeRows } from './normalize';
import { rawRowsForVersion } from './seed';

describe('formatMoney', () => {
  it('formats in the given ISO currency', () => {
    expect(formatMoney(1234.5, 'EUR')).toContain('€');
    expect(formatMoney(1234.5, 'JPY')).toContain('¥');
    expect(formatMoney(1234.5, 'USD')).toContain('$');
  });
});

describe('FocusRowsCard', () => {
  it('renders each row with its own currency, never USD by default', () => {
    const raw = rawRowsForVersion('1.4').slice(0, 2);
    raw[0] = { ...raw[0], BillingCurrency: 'EUR', BilledCost: 100 };
    raw[1] = { ...raw[1], BillingCurrency: 'USD', BilledCost: 200 };
    const { rows } = normalizeRows(raw, 'focus-file-sandbox', '1.4');
    const html = renderToStaticMarkup(<FocusRowsCard rows={rows} />);
    expect(html).toContain('€');
    expect(html).toContain('$');
    expect(html).toContain('EUR');
  });
});
