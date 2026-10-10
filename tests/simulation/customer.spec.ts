import { test, expect, type Page } from '@playwright/test';
import type { Workspace } from '../../src/simulation/types';
async function login(page: Page, name: string) {
  await page.goto('/simulation');
  await page.getByRole('button', { name: `Continue as ${name}`, exact: true }).click();
  await expect(page.getByText(`Signed in as ${name}`, { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Open customer workflow' }).click();
  await expect(page.getByRole('heading', { name: 'Cost tracking workspace' })).toBeVisible();
}
async function state(page: Page): Promise<Workspace> {
  return page.evaluate(async () => (await fetch('/api/v1/simulation/state')).json());
}
async function saved(page: Page, prior: number) {
  await expect.poll(async () => (await state(page)).revision).toBeGreaterThan(prior);
  await expect(page.getByText('Saving…', { exact: true })).toHaveCount(0);
}
test('all personas: import, investigate, approve, apply, reload, export and sign out', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await login(page, 'Alex');
  let s = await state(page);
  for (const source of ['AWS', 'AZURE', 'GCP']) {
    const prior = s.revision;
    await page.getByRole('button', { name: `Import ${source} fixture`, exact: true }).click(); await saved(page, prior); s = await state(page);
  }
  const cost = s.ledger.reduce((n, r) => n + r.cents, 0);
  expect(cost).toBe(s.workloads.reduce((n, w) => n + Math.round(w.costs.monthly_spend * 100), 0));
  const first = s.workloads[0];
  await page.getByRole('button', { name: 'Request change', exact: true }).first().click(); await saved(page, s.revision);
  await page.reload(); await expect(page.getByText(/SIM-.*requested/).first()).toBeVisible();
  await page.getByRole('link', { name: 'Workloads', exact: true }).first().click();
  for (const tab of ['Budget Profile', 'Multi-Model', 'Governance', 'Demand Shaping', 'Unit Costs', 'Alert History']) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await expect(page.getByRole('button', { name: tab, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await page.getByRole('button', { name: 'Multi-Model', exact: true }).click();
  const alternate = await page.getByLabel('Target model').locator('option').nth(2).getAttribute('value');
  s = await state(page);
  await page.getByLabel('Target model').selectOption(alternate!);
  await page.getByRole('button', { name: 'Simulate model switch', exact: true }).click(); await saved(page, s.revision);
  expect((await state(page)).workloads[0].model).toBe(alternate);
  await page.getByRole('button', { name: 'Ask Frank Coster', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask about your initiative portfolio' }).fill('Summarize the portfolio');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(/Portfolio summary —/)).toBeVisible();
  await page.getByRole('button', { name: 'Close AI chat' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Customer sign-in simulation' })).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/api/v1/simulation/state')).status)).toBe(401);
  await login(page, 'Jordan');
  await page.getByRole('button', { name: 'Approve change', exact: true }).first().click();
  await expect(page.getByText(/SIM-.*approved/).first()).toBeVisible();
  s = await state(page);
  await page.getByRole('spinbutton', { name: 'New monthly budget', exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Save budget', exact: true }).click(); await saved(page, s.revision);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, 'Morgan');
  await expect(page.getByText('$123,456', { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Reports', exact: true }).first().click();
  await page.getByRole('button', { name: 'Snapshot ↓', exact: true }).click();
  const pdf = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download PDF report' }).click();
  expect((await pdf).suggestedFilename()).toMatch(/ratio-simulated-acme.*pdf/);
  await page.getByRole('button', { name: 'Snapshot ↓', exact: true }).click();
  const xlsx = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download Spreadsheet (.xlsx)' }).click();
  expect((await xlsx).suggestedFilename()).toMatch(/ratio-simulated-acme.*xlsx/);
  await page.getByRole('button', { name: 'Simulate email delivery' }).click();
  await expect(page.getByText(/email · simulated/)).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, 'Alex');
  s = await state(page);
  await page.getByRole('button', { name: 'Apply simulated change', exact: true }).first().click(); await saved(page, s.revision);
  s = await state(page);
  expect(s.changes[first.id].status).toBe('applied'); expect(s.workloads[0].demand_shape).toBe('business_hours');
  expect(s.ledger.reduce((n, r) => n + r.cents, 0)).toBe(cost);
  await page.screenshot({ path: '.simulation-test-results/workflow-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('mobile screens, keyboard chat dismissal and tenant separation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page, 'Sam');
  expect((await state(page)).audit).toEqual([]);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  for (const route of ['/demo', '/', '/overview', '/workloads', '/connectors', '/frameworks', '/reports', '/workspace', '/finio', '/finio/demo', '/tokenomics', '/prediction', '/costsource']) {
    await page.goto(route); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), route).toBe(true);
  }
  await page.goto('/workloads');
  const primaryNavTops = await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link').evaluateAll(
    links => links.map(link => Math.round(link.getBoundingClientRect().top)),
  );
  expect(new Set(primaryNavTops).size).toBe(1);
  const detailTabTops = await page.getByRole('navigation', { name: 'Workload detail sections' }).getByRole('button').evaluateAll(
    tabs => tabs.map(tab => Math.round(tab.getBoundingClientRect().top)),
  );
  expect(new Set(detailTabTops).size).toBe(1);
  const workloadListBox = await page.getByRole('complementary', { name: 'Workload list' }).boundingBox();
  expect(workloadListBox?.width).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Demand Shaping', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Demand shape', exact: true })).toBeVisible();
  await page.screenshot({ path: '.simulation-test-results/workloads-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Ask Frank Coster', exact: true }).click();
  await page.keyboard.press('Escape'); await expect(page.getByRole('complementary', { name: 'AI Chat' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('HTTP boundary: forged identities, CSRF, stale revision, live endpoint separation, and expired cookies', async ({ page }) => {
  await login(page, 'Casey');
  const results = await page.evaluate(async () => {
    const session = (await (await fetch('/api/v1/simulation/session')).json()).session;
    const s = await (await fetch('/api/v1/simulation/state')).json();
    const send = (csrf: string, command: object, revision = s.revision) => fetch('/api/v1/simulation/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ratio-CSRF': csrf }, body: JSON.stringify({ id: crypto.randomUUID(), revision, command }) }).then(r => r.status);
    return {
      csrf: await send('bad', { type: 'sync', source: 'aws' }),
      role: await send(session.csrf, { type: 'sync', source: 'aws' }),
      tenant: await send(session.csrf, { type: 'budget', workloadId: 'foreign-workload', amount: 42 }),
      stale: await send(session.csrf, { type: 'simulate-delivery', channel: 'slack' }, s.revision + 1),
      live: await (await fetch('/api/v1/costs/published')).status,
    };
  });
  expect(results).toEqual({ csrf: 403, role: 403, tenant: 404, stale: 409, live: 401 });
  await page.context().clearCookies();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Choose a simulated identity' })).toBeVisible();
});

test('a stale refresh failure cannot revoke the newly selected identity', async ({ page }) => {
  await login(page, 'Alex');
  let captured!: (route: import('@playwright/test').Route) => void;
  const pending = new Promise<import('@playwright/test').Route>(resolve => { captured = resolve; });
  let intercepted = false;
  await page.route('**/api/v1/simulation/state', route => {
    if (intercepted) return route.continue();
    intercepted = true; captured(route);
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const stale = await pending;
  // Client-side back navigation preserves the provider and its pending refresh.
  await page.goBack();
  await page.getByRole('button', { name: 'Continue as Jordan', exact: true }).click();
  await expect(page.getByText('Signed in as Jordan', { exact: false })).toBeVisible();
  const finished = page.waitForResponse(response => response.url().endsWith('/api/v1/simulation/state') && response.status() === 401);
  await stale.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Old identity refresh failed' }) });
  await finished;
  await page.getByRole('link', { name: 'Open customer workflow' }).click();
  await expect(page.getByText('acme · Jordan (simulated)', { exact: false })).toBeVisible();
  await expect(page.getByText('Old identity refresh failed', { exact: true })).toHaveCount(0);
});
