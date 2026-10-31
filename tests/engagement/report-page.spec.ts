import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { contrastRatio } from '../../src/theme/contrast';

// R2 report page in engagement mode. The report data route is intercepted with a SYNTHETIC model where the test needs
// a filled table (no database in this suite); unintercepted, the route is reached for real and fails closed.
const tokens = () => JSON.parse(readFileSync('.engagement-test-results/tokens.json', 'utf8')) as Record<'viewer' | 'analyst', string>;
const signIn = (page: Page, user: 'viewer' | 'analyst') => page.context().addCookies([{ name: '__Host-ratio_session', value: tokens()[user], domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
const MODEL = { schema: 'ratio.engagement-report/1', title: 'SYNTHETIC engagement report: example', period: '2024-09', generatedAt: '2026-11-01T00:00:00Z',
  sections: [{ id: 'totals', title: 'Totals by currency', columns: ['Currency', 'Rows', 'Billed cost', 'Effective cost'], rows: [['USD', '1000', '12345.67000000000', '12001.00000000000']] },
    { id: 'coverageGaps', title: 'Coverage gaps', columns: ['Code', 'Detail'], rows: [['BATCH_STATUS_NOT_VISIBLE', 'SYNTHETIC: the last published batch is shown as of its publication.']] }] };
const shot = (page: Page, name: string) => page.screenshot({ path: `.engagement-test-results/screens/${name}.png`, fullPage: true });

test('anonymous: 401, no-store, Vary: Cookie, CSP enforced with no violation, only a sign-in link per enabled connection', async ({ page }) => {
  const csp: string[] = [];
  page.on('console', (m) => { if (/content security policy|refused to/i.test(m.text())) csp.push(m.text()); });
  const res = await page.goto('/engagement');
  expect([res?.status(), res?.headers()['cache-control']]).toEqual([401, 'no-store']);
  expect(res?.headers().vary).toMatch(/(^|, )Cookie(,|$)/); // Next adds Accept-Encoding
  expect(res?.headers()['content-security-policy']).toContain("script-src 'self' 'sha256-");
  await page.waitForLoadState('networkidle');
  expect(csp).toEqual([]);
  await expect(page.getByRole('link', { name: 'Sign in with synthetic-idp' })).toHaveAttribute('href', '/api/auth/oidc/start?connection=synthetic-idp');
  await shot(page, 'signin');
});

test('analyst: report table and both exports; the real route is reached with the session (DB absent: fixed unavailable message)', async ({ page }) => {
  await signIn(page, 'analyst');
  await page.goto('/engagement');
  await expect(page.getByRole('status')).toHaveText(/unavailable/); // 500 from the real route: authorized, no database here
  await page.route('**/api/v1/reports/engagement?*format=json', (r) => r.fulfill({ json: MODEL }));
  await page.getByLabel('Billing month').fill('2024-09');
  await page.getByRole('button', { name: 'Load report' }).click();
  await expect(page.getByText('12345.67000000000')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download XLSX' })).toHaveAttribute('href', '/api/v1/reports/engagement?period=2024-09&format=xlsx');
  await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();
  await shot(page, 'analyst');
  const html = await page.content();
  expect(html).not.toContain(tokens().analyst); // the session token never reaches the DOM (HttpOnly)
});

test('viewer: no export links; the export route itself refuses the viewer (403)', async ({ page }) => {
  await signIn(page, 'viewer');
  await page.route('**/api/v1/reports/engagement?*format=json', (r) => r.fulfill({ json: MODEL }));
  await page.goto('/engagement');
  await expect(page.getByText('12345.67000000000')).toBeVisible();
  await expect(page.getByRole('link', { name: /Download/ })).toHaveCount(0);
  expect((await page.request.get('/api/v1/reports/engagement?period=2024-09&format=xlsx')).status()).toBe(403);
});

for (const theme of ['light', 'dark', 'high-contrast']) {
  test(`WCAG AA text contrast on the signed-in page (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('ratio.theme', t), theme);
    await signIn(page, 'analyst');
    await page.route('**/api/v1/reports/engagement?*format=json', (r) => r.fulfill({ json: MODEL }));
    await page.goto('/engagement');
    await expect(page.getByText('12345.67000000000')).toBeVisible();
    await shot(page, `contrast-${theme}`);
    const nodes = await page.evaluate(() => {
      const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
      const out: { text: string; fg: number[]; bg: number[]; large: boolean }[] = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const el = n.parentElement;
        if (!el || !n.textContent?.trim() || !el.checkVisibility()) continue;
        let bg = [255, 255, 255];
        for (let e: Element | null = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c[3] ?? 1) === 1) { bg = c.slice(0, 3); break; } }
        const cs = getComputedStyle(el);
        out.push({ text: n.textContent.trim().slice(0, 30), fg: rgb(cs.color).slice(0, 3), bg, large: parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700) });
      }
      return out;
    });
    const hex = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
    const bad = nodes.filter((x) => contrastRatio(hex(x.fg), hex(x.bg)) < (x.large ? 3 : 4.5));
    expect(nodes.length).toBeGreaterThan(10);
    expect(bad, JSON.stringify(bad.slice(0, 5))).toEqual([]);
  });
}
