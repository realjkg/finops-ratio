import { expect, test, type Page } from '@playwright/test';

// One quiet demo indicator: every demo page carries the top-bar "Demo" badge (named "Demo environment —
// figures are illustrative") and no view spells out synthetic/sample/seeded data labels. /simulation is
// the exception the owner chose: its route name and heading say "Simulation", so it has no badge.
const DEMO_ROUTES = ['/', '/overview', '/workloads', '/connectors', '/frameworks', '/reports', '/demo', '/agent-workflows', '/workspace', '/outcomes',
  '/costsource', '/finio', '/finio/demo', '/prediction', '/tokenomics', '/attribution', '/mission', '/hello'];
const BADGE = 'Demo environment — figures are illustrative';
const LABELS = /synthetic|sample workspace|sample data|import sample|seeded|demo assumption|no live connections|\bexample (cloud|private cloud|datacenter)\b/i;
const badge = (page: Page) => page.getByRole('note', { name: BADGE });

/** Visible text plus accessible names and titles: what a sighted or screen-reader user meets. */
const viewText = (page: Page) => page.evaluate(() => [document.title, document.body.innerText,
  ...[...document.querySelectorAll('[aria-label],[title],[alt],[placeholder]')].flatMap((el) => ['aria-label', 'title', 'alt', 'placeholder'].map((a) => el.getAttribute(a) ?? ''))].join('\n'));

for (const width of [390, 1440]) {
  test(`every demo page carries exactly one Demo badge and no data label at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    for (const route of DEMO_ROUTES) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      await expect(badge(page), route).toHaveCount(1);
      await expect(badge(page), route).toBeVisible();
      await expect(badge(page), route).toHaveText('Demo');
      const text = await viewText(page);
      expect(text.match(LABELS)?.[0] ?? null, `${route}: ${text.match(new RegExp(`.{0,60}${LABELS.source}.{0,60}`, 'i'))?.[0]}`).toBeNull();
      expect(text, route).not.toMatch(/live verified|production data|production-ready data/i);
    }
  });
}

test('/simulation has no Demo badge and no data label: the route and the heading say Simulation', async ({ page }) => {
  for (const enabled of [true, false]) {
    if (!enabled) await page.route('**/api/v1/simulation/status', (r) => r.fulfill({ json: { enabled: false } }));
    await page.goto('/simulation');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(enabled ? 'Simulation: follow the cost from import to decision' : 'Simulation: see the same costs through three roles');
    await expect(page).toHaveTitle('Simulation · Ratio');
    await expect(badge(page)).toHaveCount(0);
    await expect(page.locator('[data-testid="demo-badge"]')).toHaveCount(0);
    expect((await viewText(page)).match(LABELS)).toBeNull();
    if (!enabled) await expect(page.getByTestId('read-only-line')).toHaveText('Read-only: no sign-in, nothing is sent, and changes are not saved.');
  }
});

test('the Connectors page after importing all three connections still shows no data label', async ({ page }) => {
  await page.goto('/connectors');
  await page.waitForLoadState('networkidle');
  for (const name of ['Public cloud billing API', 'Private cloud usage API', 'On-premises cost allocation API']) {
    await page.getByRole('article', { name }).getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByRole('article', { name }).getByRole('status')).toContainText('Reconciled');
  }
  await page.getByRole('article', { name: 'Private cloud usage API' }).locator('details summary').click();
  expect((await viewText(page)).match(LABELS)).toBeNull();
});

test('the finding calculation states Basis: modeled and Source: Demo dataset, and the card does not', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Cost and value' })).not.toContainText('Basis');
  await page.getByRole('button', { name: 'View calculation' }).click();
  await expect(page.getByText('Basis: modeled.', { exact: false })).toBeVisible();
  await expect(page.getByText('Demo dataset.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Billed cost \(|Effective cost \(/)).toHaveCount(0);
});
