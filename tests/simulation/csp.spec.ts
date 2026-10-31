import { expect, test, type Page } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PREPAINT_SCRIPT } from '../../src/theme/user';

// Production build in Chromium: zero CSP violations; only the pinned pre-paint script may run inline.
type W = { __csp?: string[] };
/** Every securitypolicyviolation event and CSP console error on the page, so far. */
async function watch(page: Page) {
  const seen: string[] = [];
  page.on('console', (m) => { if (/content security policy|refused to/i.test(m.text())) seen.push(m.text()); });
  await page.addInitScript(() => {
    (window as W).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as W).__csp?.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return async () => [...seen, ...(await page.evaluate(() => (window as W).__csp ?? []))];
}

/** Every static page route, read from pages/ (API routes, _app/_document/_error and dynamic [param] routes excluded). */
function pageRoutes(dir = 'pages', prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'api' || e.name.startsWith('_') || e.name.includes('[')) return [];
    if (e.isDirectory()) return pageRoutes(join(dir, e.name), `${prefix}/${e.name}`);
    const name = e.name.replace(/\.tsx?$/, '');
    return /\.tsx?$/.test(e.name) ? [name === 'index' ? prefix || '/' : `${prefix}/${name}`] : [];
  });
}

// pages/_error.tsx is the app's own page, so even the 404 is scanned with no allowlist.
const NEXT_404 = '/__csp-unknown-route';
// Engagement-mode-only pages answer 404 on this simulation server; tests/engagement/report-page.spec.ts scans them there.
const ENGAGEMENT_ONLY = ['/engagement'];
const scan = async (page: Page, route: string) => {
  const violations = await watch(page);
  const res = await page.goto(route);
  await page.waitForLoadState('networkidle');
  const found = await violations();
  return { status: res?.status() ?? 0, header: res?.headers()['content-security-policy'] ?? '', found };
};

test('every page route is enforced, renders and reports zero violations', async ({ context }) => {
  const routes = pageRoutes();
  expect(routes).toEqual(expect.arrayContaining(['/', '/overview', '/connectors', '/workloads', '/finio/demo']));
  for (const route of [...routes, NEXT_404]) {
    const page = await context.newPage();
    const { status, header, found } = await scan(page, route);
    expect(status, route).toBe(route === NEXT_404 || ENGAGEMENT_ONLY.includes(route) ? 404 : 200);
    expect(header, route).toContain("script-src 'self' 'sha256-");
    if (route !== NEXT_404) await expect(page.locator('#__next > *').first(), route).toBeAttached();
    expect(found, route).toEqual([]);
    await page.close();
  }
});

test('mutation: an injected inline script on one route is caught by the scan', async ({ page }) => {
  await page.route((url) => url.pathname === '/tokenomics', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('</body>', '<script>window.x=1</script></body>') });
  });
  expect((await scan(page, '/tokenomics')).found.some((v) => v.includes('script-src'))).toBe(true);
});

test('theme switches and persists; the data-URL export downloads', async ({ page }) => {
  const violations = await watch(page);
  await page.goto('/overview');
  await page.getByRole('combobox', { name: 'Appearance' }).selectOption('high-contrast');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
  await page.getByRole('button', { name: 'Appearance options' }).click();
  await page.getByText('Developer: contrast audit', { exact: true }).click(); // the export link sits behind the closed disclosure
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export current theme' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
  expect(await violations()).toEqual([]);
});

// Without the bundle only the inline script can set the theme; an edited copy must be blocked.
for (const edited of [false, true]) {
  test(`pre-paint script ${edited ? 'mutation: an edited copy is blocked and does not run' : 'executes under the policy'}`, async ({ page }) => {
    const violations = await watch(page);
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
    expect((await violations()).some((v) => v.includes('script-src'))).toBe(edited);
    if (!edited) expect(await violations()).toEqual([]);
  });
}
