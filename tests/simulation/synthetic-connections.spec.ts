import { expect, test } from '@playwright/test';

// The three simulated API connections import in the browser: no request leaves the page, nothing
// overflows a phone screen, and the per-currency totals reconcile.
for (const width of [390, 768, 1024, 1280, 1440]) {
  test(`synthetic API connections import and reconcile client-side at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
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
    // The totals render as a table from 640px up and as stacked rows below it: read the whole section either way.
    const totals = page.locator('section[aria-labelledby="synthetic-connections-heading"]');
    await expect(totals).toContainText('EUR 2,339.00');
    await expect(totals).toContainText('USD 4,617.88');
    expect(requests.filter((r) => !r.startsWith('GET /api/costsource/sources'))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Every money value is fully visible: inside the viewport, and not clipped by its own box.
    const clipped = await page.evaluate(() => [...document.querySelectorAll('article dd, article td, article th, [aria-label="Imported totals by currency"] td')]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => { const r = el.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 0.5 || el.scrollWidth > el.clientWidth + 1; })
      .map((el) => el.textContent));
    expect(clipped).toEqual([]);
    // Every money table or stacked list stays inside its card (the page scrolls inside <main>, so
    // document.scrollWidth cannot see a spill).
    const spill = await page.evaluate(() => [...document.querySelectorAll('article table, article dl, section[aria-labelledby="synthetic-connections-heading"] > div table, section[aria-labelledby="synthetic-connections-heading"] > div dl')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => { const box = el.closest('article, .rounded-card')!.getBoundingClientRect(); const r = el.getBoundingClientRect(); return { text: (el.getAttribute('aria-label') ?? el.textContent ?? '').slice(0, 40), over: Math.round(r.right - box.right) }; })
      .filter((x) => x.over > 0));
    expect(spill).toEqual([]);
    // The N/A list is collapsed by default and, opened, stays compact.
    const details = page.getByRole('article', { name: 'Example Private Cloud usage API' }).locator('details');
    await expect(details).not.toHaveAttribute('open', '');
    await details.locator('summary').click();
    const height = (await details.boundingBox())!.height;
    expect(height, `N/A list is ${height}px tall at ${width}x900`).toBeLessThan(width < 600 ? 844 * 1.5 : 900 * 1.5);
  });
}
