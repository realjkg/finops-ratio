import { expect, test, type Page } from '@playwright/test';
import { PREPAINT_SCRIPT } from '../../src/theme/user';

// Real Chromium against the production build: the Content-Security-Policy must
// not break rendering, theming or the data-URL export, must report zero
// violations, and must still allow the one pinned pre-paint inline script.
const ROUTES = ['/', '/overview', '/connectors', '/workloads'];

/** Collects CSP console errors and securitypolicyviolation events for the page. */
async function watch(page: Page) {
  const seen: string[] = [];
  page.on('console', (m) => { if (/content security policy|refused to/i.test(m.text())) seen.push(`console: ${m.text()}`); });
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return async () => [...seen, ...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).map((v) => `event: ${v}`)];
}

for (const route of ROUTES) {
  test(`CSP enforced on ${route}: renders with zero violations`, async ({ page }) => {
    const violations = await watch(page);
    const response = await page.goto(route);
    expect(response?.headers()['content-security-policy'] ?? '').toContain("script-src 'self' 'sha256-");
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await violations()).toEqual([]);
  });
}

test('theme switches and persists under the policy; data-URL export downloads', async ({ page }) => {
  const violations = await watch(page);
  await page.goto('/overview');
  await page.getByRole('combobox', { name: 'Theme' }).selectOption('high-contrast');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
  await page.getByRole('button', { name: 'Customize' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export current theme' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  expect(await violations()).toEqual([]);
});

test('the pre-paint script executes under the policy (no application bundle needed)', async ({ page }) => {
  const violations = await watch(page);
  await page.addInitScript(() => localStorage.setItem('ratio.theme', 'high-contrast'));
  await page.route('**/_next/static/**', (route) => (route.request().resourceType() === 'script' ? route.abort() : route.continue()));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
  expect(await violations()).toEqual([]);
});

test('mutation: an edited inline script is blocked and does not run', async ({ page }) => {
  const violations = await watch(page);
  await page.addInitScript(() => localStorage.setItem('ratio.theme', 'high-contrast'));
  await page.route('**/_next/static/**', (route) => (route.request().resourceType() === 'script' ? route.abort() : route.continue()));
  await page.route((url) => url.pathname === '/', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    const html = await response.text();
    expect(html).toContain(PREPAINT_SCRIPT);
    await route.fulfill({ response, body: html.replace(PREPAINT_SCRIPT, `${PREPAINT_SCRIPT};`) });
  });
  await page.goto('/');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  expect((await violations()).some((v) => v.includes('script-src'))).toBe(true);
});
