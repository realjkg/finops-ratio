import { expect, test, type Page } from '@playwright/test';

// Phone usability: the explanation popup stays on screen, the current nav item is fully visible on a
// direct load, the strip is reachable by keyboard, and primary controls have 44px touch targets.
const ROUTES = ['/', '/overview', '/workloads', '/connectors', '/frameworks', '/reports'];
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

async function expectInViewport(page: Page, selector: string, label: string) {
  const vp = page.viewportSize()!;
  const box = await page.locator(selector).boundingBox();
  expect(box, `${label}: popup rendered`).not.toBeNull();
  expect(box!.x, `${label}: left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${label}: right edge`).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box!.y, `${label}: top edge`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${label}: bottom edge`).toBeLessThanOrEqual(vp.height + 0.5);
}

for (const width of [320, 360, 390, 768, 1440]) {
  test(`Estimated value popup stays inside the viewport at ${width}px (finding card and KPI card)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/');
    const mark = page.getByRole('button', { name: 'Estimated value' }).first();
    await mark.scrollIntoViewIfNeeded();
    await mark.click();
    await expectInViewport(page, '[data-testid="evidence-note"]', 'finding card');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="evidence-note"]')).toHaveCount(0);

    await page.goto('/workloads');
    await page.getByText('Fraud Triage Agent').first().click();
    const kpi = page.getByRole('button', { name: 'Estimated value' }).first();
    await kpi.scrollIntoViewIfNeeded();
    await kpi.click();
    await expectInViewport(page, '[data-testid="evidence-note"]', 'KPI card');
    // Not clipped by an overflow container: the popup is a direct child of <body>.
    expect(await page.evaluate(() => document.querySelector('[data-testid="evidence-note"]')!.parentElement === document.body)).toBe(true);
  });
}

for (const [width, scale] of [[320, 100], [360, 100], [390, 100], [320, 130]] as const) {
  test(`current nav item is fully visible on direct load at ${width}px, ${scale}% text`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript((s) => localStorage.setItem('ratio.typography', JSON.stringify({ scale: s, family: 'default' })), scale);
    for (const route of ROUTES) {
      await page.goto(route);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => {
        const strip = document.querySelector('[data-testid="nav-strip"]')!.getBoundingClientRect();
        const cur = document.querySelector('[data-testid="nav-strip"] [aria-current="page"]')!.getBoundingClientRect();
        return { sl: strip.left, sr: strip.right, cl: cur.left, cr: cur.right };
      });
      expect(r.cl, `${route} left`).toBeGreaterThanOrEqual(r.sl - 0.5);
      expect(r.cr, `${route} right`).toBeLessThanOrEqual(r.sr + 0.5);
    }
  });
}

test('the strip is reachable by keyboard: tabbing to the last item brings it fully into view', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  const last = nav(page).getByRole('link', { name: 'Reports' });
  for (let i = 0; i < 12 && !(await last.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(last).toBeFocused();
  const r = await page.evaluate(() => {
    const strip = document.querySelector('[data-testid="nav-strip"]')!.getBoundingClientRect();
    const cur = document.activeElement!.getBoundingClientRect();
    return { sl: strip.left, sr: strip.right, cl: cur.left, cr: cur.right };
  });
  expect(r.cl).toBeGreaterThanOrEqual(r.sl - 0.5);
  expect(r.cr).toBeLessThanOrEqual(r.sr + 0.5);
});

for (const width of [320, 360, 390]) {
  test(`primary controls have 44px touch targets at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    const targets = [
      ...(await nav(page).getByRole('link').all()),
      nav(page).getByRole('button', { name: 'Display', exact: true }),
      nav(page).getByRole('button', { name: 'Text', exact: true }),
      nav(page).getByRole('button', { name: 'Ask Frank Coster' }),
      page.getByRole('button', { name: 'Estimated value' }).first(),
    ];
    for (const t of targets) {
      const box = await t.boundingBox();
      expect(box!.height, `${await t.textContent()} height`).toBeGreaterThanOrEqual(43.5);
    }
  });
}
