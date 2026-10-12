import { expect, test, type Page } from '@playwright/test';

// The largest supported text size (130%) on the key pages: nothing may widen the page,
// clip its own text, or sit on top of other text. Scrollers the user can scroll (auto/scroll)
// are not clipping. Failures are fixed in the shared layout, never hidden with overflow.
const ROUTES = ['/', '/overview', '/connectors', '/workloads'];

async function problems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const main = document.querySelector('main');
    if (document.documentElement.scrollWidth > innerWidth) out.push('page scrolls horizontally');
    if (main && main.scrollWidth > main.clientWidth + 1) out.push('main scrolls horizontally');
    const label = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}"`;
    const boxes: { el: Element; r: DOMRect }[] = [];
    for (const el of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.display === 'contents') continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent?.trim());
      if (!own.length) continue;
      const clip = (v: string) => v === 'hidden' || v === 'clip';
      if ((clip(cs.overflowX) || cs.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1) out.push(`clipped width: ${label(el)}`);
      if (clip(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) out.push(`clipped height: ${label(el)}`);
      const range = document.createRange();
      for (const n of own) {
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.width > 2 && r.height > 2) boxes.push({ el, r });
      }
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 1 && h > 1 && (w * h) / Math.min(a.r.width * a.r.height, b.r.width * b.r.height) > 0.2) out.push(`overlap: ${label(a.el)} / ${label(b.el)}`);
      }
    }
    return [...new Set(out)];
  });
}

for (const width of [1440, 390]) {
  test(`130% text has no overflow, clipping or overlap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem('ratio.typography', JSON.stringify({ scale: 130, family: 'default' })));
    for (const route of ROUTES) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), 'scale applied').toBe('20.8px');
      expect(await problems(page), route).toEqual([]);
    }
  });
}

test('the Text control changes size from the keyboard and survives a reload', async ({ page }) => {
  await page.goto('/overview');
  await page.getByRole('button', { name: 'Text', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Text size').selectOption('115');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('18.4px');
  await page.reload();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('18.4px');
});
