import { expect, test, type Page } from '@playwright/test';

// 130% (the largest size): nothing widens the page, clips its text or sits on other text. Vertical
// scrollers (<main>, panes, lists) are expanded to their full content first, so text below the
// fold is checked too. Horizontal scrollers are exempt only for what scrolling reaches; text cut by
// hidden/clip or unscrollable ancestors is clipped. Fix the layout, never hide overflow.
const ROUTES = ['/', '/overview', '/connectors', '/workloads'];
const rootSize = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);

const problems = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    type R = [number, number, number, number]; // left, top, right, bottom
    const out: string[] = [];
    const main = document.querySelector('main');
    if (document.documentElement.scrollWidth > innerWidth) out.push('page scrolls horizontally');
    if (main && main.scrollWidth > main.clientWidth + 1) out.push('main scrolls horizontally');
    // Expand every vertical scroller (and its ancestors) to full content so nothing hides below the fold.
    for (const s of document.body.querySelectorAll<HTMLElement>('*')) {
      const o = getComputedStyle(s).overflowY;
      if ((o !== 'auto' && o !== 'scroll') || s.scrollHeight <= s.clientHeight + 1) continue;
      for (let a: HTMLElement | null = s; a; a = a.parentElement) {
        a.style.height = 'auto';
        a.style.maxHeight = 'none';
        a.style.overflow = 'visible';
      }
    }
    const label = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}"`;
    const meet = (a: R, b: R): R | null => {
      const r: R = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
      return r[2] > r[0] && r[3] > r[1] ? r : null;
    };
    const boxes: { el: Element; r: R }[] = [];
    for (const el of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent?.trim());
      if (!own.length || cs.display === 'none' || cs.visibility === 'hidden' || el.closest('.sr-only')) continue;
      for (const n of own) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const q of range.getClientRects()) {
          if (q.width < 2 || q.height < 2) continue;
          let shown: R | null = [q.left, q.top, q.right, q.bottom];
          let vis: R = [q.left, q.top, q.right, q.bottom]; // shown, except for what scrolling can reach
          for (let a: Element | null = el; a && a !== document.body && shown; a = a.parentElement) {
            const o = getComputedStyle(a);
            if (o.overflowX === 'visible' && o.overflowY === 'visible') continue;
            const c = a.getBoundingClientRect();
            const reachX = (o.overflowX === 'auto' || o.overflowX === 'scroll') && a.scrollWidth > a.clientWidth + 1;
            const reachY = (o.overflowY === 'auto' || o.overflowY === 'scroll') && a.scrollHeight > a.clientHeight + 1;
            const cutX = o.overflowX !== 'visible' && !reachX && (vis[0] < c.left - 1 || vis[2] > c.right + 1);
            const cutY = o.overflowY !== 'visible' && !reachY && Math.min(vis[3], c.bottom) - Math.max(vis[1], c.top) < (vis[3] - vis[1]) * 0.8;
            if (cutX || cutY) out.push(`clipped: ${label(el)} by ${a.tagName.toLowerCase()}.${String(a.className).split(' ')[0]}`);
            if (o.overflowX !== 'visible' && reachX) vis = [Math.max(vis[0], c.left), vis[1], Math.min(vis[2], c.right), vis[3]];
            if (o.overflowY !== 'visible' && reachY) vis = [vis[0], Math.max(vis[1], c.top), vis[2], Math.min(vis[3], c.bottom)];
            shown = meet(shown, [c.left, c.top, c.right, c.bottom]);
          }
          if (shown) boxes.push({ el, r: shown });
        }
      }
    }
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const both = meet(a.r, b.r);
        if (both && both[2] - both[0] > 2 && both[3] - both[1] > 2) out.push(`overlap: ${label(a.el)} / ${label(b.el)}`);
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
