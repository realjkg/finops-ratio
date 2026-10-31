import { expect, test } from '@playwright/test';

// The three simulated API connections import in the browser: no request leaves the page, nothing
// overflows a phone screen, and the per-currency totals reconcile.
for (const width of [390, 1440]) {
  test(`synthetic API connections import and reconcile client-side at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/connectors');
    await page.waitForLoadState('networkidle');
    const requests: string[] = [];
    page.on('request', (r) => { if (!/\/_next\//.test(r.url())) requests.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    const cards = page.getByRole('article');
    await expect(cards).toHaveCount(3);
    await expect(page.getByText('Synthetic', { exact: true })).toHaveCount(3);
    for (const name of ['Example Cloud billing API', 'Example Private Cloud usage API', 'Example Datacenter cost allocation API']) {
      await page.getByRole('article', { name }).getByRole('button', { name: 'Import sample' }).click();
      await expect(page.getByRole('article', { name }).getByRole('status')).toContainText('Reconciled');
    }
    const totals = page.getByRole('table', { name: 'Imported totals by currency' });
    await expect(totals).toContainText('EUR 2,339.00');
    await expect(totals).toContainText('USD 4,617.88');
    expect(requests.filter((r) => !r.startsWith('GET /api/costsource/sources'))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
