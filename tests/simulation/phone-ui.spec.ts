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
    ];
    for (const t of targets) {
      const box = await t.boundingBox();
      expect(box!.height, `${await t.textContent()} height`).toBeGreaterThanOrEqual(43.5);
    }
    // The Estimated value button's hit area is a pseudo-element: points 21px above and below its centre
    // (a 42px-tall zone, within the 44px target) must still land on the button.
    const mark = page.getByRole('button', { name: 'Estimated value' }).first();
    await mark.evaluate((el) => el.scrollIntoView({ block: 'center' })); // keep the probe points inside the viewport
    const b = (await mark.boundingBox())!;
    for (const dy of [-21, 0, 21]) {
      const hit = await page.evaluate(([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('button')?.textContent, [b.x + b.width / 2, b.y + b.height / 2 + dy]);
      expect(hit, `hit at dy=${dy}`).toBe('Estimated value');
    }
  });
}

// #178 review follow-ups: the top bar fits on one row at 320px; the portaled explanation is announced;
// Escape closes it only from the popup or its button, never from inside the Frank panel.
for (const width of [320, 360, 390]) {
  test(`top bar: logo, Demo badge, Display, Text and Ask Frank share one row at ${width}px, with 44px targets`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const route of ROUTES) {
      await page.goto(route);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const items = [
        nav(page).getByText('Ratio', { exact: true }),
        nav(page).getByRole('note', { name: 'Demo environment — figures are illustrative' }),
        nav(page).getByRole('button', { name: 'Display', exact: true }),
        nav(page).getByRole('button', { name: 'Text', exact: true }),
        nav(page).getByRole('button', { name: 'Ask Frank Coster' }),
      ];
      const boxes = await Promise.all(items.map(async (i) => (await i.boundingBox())!));
      const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
      for (const [k, b] of boxes.entries()) {
        expect(Math.abs(mid(b) - mid(boxes[2])), `${route} item ${k} on the first row`).toBeLessThan(6);
        expect(b.x + b.width, `${route} item ${k} inside the viewport`).toBeLessThanOrEqual(width + 0.5);
      }
      for (const b of boxes.slice(2)) {
        expect(b.height, `${route} target height`).toBeGreaterThanOrEqual(43.5);
        expect(b.width, `${route} target width`).toBeGreaterThanOrEqual(43.5);
      }
      // The header is the top row plus the nav strip: about 112px, not ~170px with Ask Frank wrapped to its own row.
      const navBox = (await nav(page).boundingBox())!;
      expect(navBox.height, `${route} nav height`).toBeLessThanOrEqual(120);
      if (width < 400) await expect(nav(page).getByTestId('ask-frank-short')).toBeHidden();
      else await expect(nav(page).getByTestId('ask-frank-short')).toBeVisible();
    }
  });
}

test('Estimated value: opening it describes the button and announces the text; Escape inside the Frank panel leaves it open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const mark = page.getByRole('button', { name: 'Estimated value' }).first();
  await mark.click();
  const note = page.locator('[data-testid="evidence-note"]');
  await expect(note).toBeVisible();
  await expect(mark).toHaveAttribute('aria-describedby', (await note.getAttribute('id'))!);
  await expect(mark).toHaveAccessibleDescription(/stated assumptions/);
  await expect(page.getByTestId('evidence-live').first()).toHaveText(/stated assumptions/);
  // Open Frank from the keyboard (a click would be an outside tap and close the popup), then press Escape in its textbox.
  await nav(page).getByRole('button', { name: 'Ask Frank Coster' }).focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('complementary', { name: 'AI Chat' });
  await expect(panel).toBeVisible();
  await panel.getByRole('textbox').focus();
  await page.keyboard.press('Escape');
  await expect(note, 'Escape in the Frank panel must not close the popup').toBeVisible();
  // From the popup's own button, Escape closes it and focus stays on the button.
  await mark.focus();
  await page.keyboard.press('Escape');
  await expect(note).toHaveCount(0);
  await expect(mark).toBeFocused();
  await expect(page.getByTestId('evidence-live').first()).toHaveText('');
  // Review Low (a): opened from the keyboard, Tab twice to another page control, then Escape still closes it.
  await page.keyboard.press('Escape'); // close Frank if it is still open
  await mark.focus();
  await page.keyboard.press('Enter');
  await expect(note).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('#ai-chat-panel') === null)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(note).toHaveCount(0);
});

// Owner report (iPhone): typing in the Frank panel left the page zoomed in with the panel
// cut off on the right. iOS Safari zooms into a focused text field whose font is below 16px
// and stays zoomed, so on touch screens every text field is at least 16px, whatever the
// Text setting or orientation; desktops keep the compact sizes.
const fontPx = (loc: import('@playwright/test').Locator) => loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

test.describe('touch screens: text fields never trigger iOS zoom', () => {
  for (const [width, height, scale] of [[390, 844, 90], [390, 844, 100], [390, 844, 130], [320, 640, 100], [844, 390, 100]] as const) {
    test(`Frank chat box is at least 16px at ${width}x${height}, ${scale}% text, and the panel fits`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      await page.addInitScript((s) => localStorage.setItem('ratio.typography', JSON.stringify({ scale: s, family: 'default' })), scale);
      await page.goto('/');
      await nav(page).getByRole('button', { name: 'Ask Frank Coster' }).click();
      const box = page.getByRole('textbox', { name: 'Ask about your initiative portfolio' });
      await box.focus();
      expect(await fontPx(box)).toBeGreaterThanOrEqual(16);
      const fit = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(fit.doc).toBeLessThanOrEqual(fit.inner);
      await ctx.close();
    });
  }

  const signIn = async (page: import('@playwright/test').Page) => {
    await page.goto('/simulation');
    await page.getByRole('button', { name: 'Continue as Morgan', exact: true }).click();
    await expect(page.getByText('Signed in as Morgan', { exact: false })).toBeVisible();
  };

  test('the Ask Frank box on Agent workflows is at least 16px on a phone', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await signIn(page);
    await page.goto('/agent-workflows');
    expect(await fontPx(page.getByRole('textbox', { name: 'Ask Frank' }))).toBeGreaterThanOrEqual(16);
    await ctx.close();
  });

  test('a field never grows past its designed size: the workspace select fits at 320px with 130% text', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem('ratio.typography', JSON.stringify({ scale: 130, family: 'default' })));
    await signIn(page);
    await page.goto('/workspace');
    const select = page.getByLabel('Workflow workload');
    const box = await select.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(320 + 0.5);
    expect(await fontPx(select)).toBeGreaterThanOrEqual(16);
    await ctx.close();
  });
});

test('Frank chat box stays compact on a desktop screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await nav(page).getByRole('button', { name: 'Ask Frank Coster' }).click();
  expect(await fontPx(page.getByRole('textbox', { name: 'Ask about your initiative portfolio' }))).toBeLessThan(16);
});
