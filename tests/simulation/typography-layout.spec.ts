import { expect, test, type Page } from '@playwright/test';

// 130% (the largest size): nothing widens the page, clips its text or sits on other text.
// Scrollable areas (auto/scroll) are not clipping; fix the layout, never hide overflow.
const ROUTES = ['/', '/overview', '/connectors', '/workloads'];

const rootSize = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
const problems = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    type R = [number, number, number, number]; // left, top, right, bottom
    const out: string[] = [];
    const main = document.querySelector('main');
    if (document.documentElement.scrollWidth > innerWidth) out.push('page scrolls horizontally');
    if (main && main.scrollWidth > main.clientWidth + 1) out.push('main scrolls horizontally');
    const label = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}"`;
    const meet = (a: R, b: R): R | null => {
      const r: R = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
      return r[2] - r[0] > 1 && r[3] - r[1] > 1 ? r : null;
    };
    const area = (r: R) => (r[2] - r[0]) * (r[3] - r[1]);
    const clips = (v: string) => v === 'hidden' || v === 'clip';
    const boxes: { el: Element; r: R }[] = [];
    for (const el of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent?.trim());
      if (!own.length || cs.display === 'none' || cs.visibility === 'hidden') continue;
      if ((clips(cs.overflowX) || cs.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1) out.push(`clipped width: ${label(el)}`);
      if (clips(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) out.push(`clipped height: ${label(el)}`);
      for (const n of own) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const q of range.getClientRects()) {
          let r: R | null = [q.left, q.top, q.right, q.bottom];
          // Only the part that scrolling or clipping ancestors show can overlap anything.
          for (let a = el.parentElement; a && r; a = a.parentElement) {
            const o = getComputedStyle(a);
            if (o.overflowX !== 'visible' || o.overflowY !== 'visible') {
              const c = a.getBoundingClientRect();
              r = meet(r, [c.left, c.top, c.right, c.bottom]);
            }
          }
          if (r && r[2] - r[0] > 2 && r[3] - r[1] > 2) boxes.push({ el, r });
        }
      }
    }
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const both = a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el) ? null : meet(a.r, b.r);
        if (both && area(both) / Math.min(area(a.r), area(b.r)) > 0.2) out.push(`overlap: ${label(a.el)} / ${label(b.el)}`);
      }
    }
    return [...new Set(out)];
  });

for (const [width, family] of [[1440, 'default'], [390, 'default'], [1440, 'system-mono'], [390, 'system-mono']] as const) {
  test(`130% text (${family}) has no overflow, clipping or overlap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((f) => localStorage.setItem('ratio.typography', JSON.stringify({ scale: 130, family: f })), family);
    const found: Record<string, string[]> = {};
    for (const route of ROUTES) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      await expect.poll(() => rootSize(page), { message: 'scale applied' }).toBe('20.8px');
      found[route] = await problems(page);
    }
    expect(found).toEqual({ '/': [], '/overview': [], '/connectors': [], '/workloads': [] });
  });
}
