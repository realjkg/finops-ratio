import { expect, test, type Page } from '@playwright/test';
import { PREPAINT_SCRIPT } from '../../src/theme/user';

// Production build in Chromium: zero CSP violations; only the pinned pre-paint script may run inline.
// Chromium logs each violation to the console as "Refused to ... Content Security Policy directive ...".
function watch(page: Page) {
  const seen: string[] = [];
  page.on('console', (m) => { if (/content security policy|refused to/i.test(m.text())) seen.push(m.text()); });
  return seen;
}

test('enforced on /, /overview, /connectors, /workloads: renders with zero violations', async ({ page }) => {
  const violations = watch(page);
  for (const route of ['/', '/overview', '/connectors', '/workloads']) {
    const res = await page.goto(route);
    expect(res?.headers()['content-security-policy'], route).toContain("script-src 'self' 'sha256-");
    await expect(page.getByRole('navigation', { name: 'Main navigation' }), route).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(violations, route).toEqual([]);
  }
});

test('theme switches and persists; the data-URL export downloads', async ({ page }) => {
  const violations = watch(page);
  await page.goto('/overview');
  await page.getByRole('combobox', { name: 'Theme' }).selectOption('high-contrast');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
  await page.getByRole('button', { name: 'Customize' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export current theme' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
  expect(violations).toEqual([]);
});

// Without the bundle only the inline script can set the theme; an edited copy must be blocked.
for (const edited of [false, true]) {
  test(`pre-paint script ${edited ? 'mutation: an edited copy is blocked and does not run' : 'executes under the policy'}`, async ({ page }) => {
    const violations = watch(page);
    await page.addInitScript(() => localStorage.setItem('ratio.theme', 'high-contrast'));
    await page.route('**/_next/static/**', (r) => (r.request().resourceType() === 'script' ? r.abort() : r.continue()));
    await page.route((url) => url.pathname === '/', async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue();
      const response = await route.fetch();
      const html = await response.text();
      expect(html).toContain(PREPAINT_SCRIPT);
      await route.fulfill({ response, body: edited ? html.replace(PREPAINT_SCRIPT, `${PREPAINT_SCRIPT};`) : html });
    });
    await page.goto('/');
    expect(await page.locator('html').getAttribute('data-theme')).toBe(edited ? null : 'high-contrast');
    expect(violations.some((v) => v.includes('script-src'))).toBe(edited);
    if (!edited) expect(violations).toEqual([]);
  });
}
