import { test, expect, type Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { contrastRatio } from '../../src/theme/contrast';

// Rendered WCAG AA audit of every visible text node on the key pages, per built-in theme:
// computed foreground and effective (ancestor-composited, opacity-aware) background.
// Failures are open defects: MAX only ratchets DOWN as migration slices land; nothing is
// exempted and the threshold is never lowered. AUDIT_OUT=<file> appends the table,
// AUDIT_DUMP=<file> appends the failing nodes (JSON lines); delete both files before a run.
export const MAX: Record<string, number> = { light: 0, 'high-contrast': 0, dark: 346 };
const PAGES = ['/', '/overview', '/connectors', '/workloads'];

type Raw = { text: string; el: string; fg: number[]; size: number; bold: boolean; layers: { c: number[]; a: number; o?: number }[]; img: boolean; op: number };
const collect = (page: Page) => page.evaluate((): Raw[] => {
  const rgba = (s: string) => {
    const n = (s.match(/[\d.]+/g) ?? ['0', '0', '0', '1']).map(Number);
    const k = s.startsWith('color(srgb') ? 255 : 1; // color-mix() computes to color(srgb r g b / a), channels 0..1
    return [n[0] * k, n[1] * k, n[2] * k, s.includes('/') || n.length > 3 ? n[3] : 1];
  };
  const out: Raw[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || !node.textContent?.trim() || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue; // sr-only
    const chain: Element[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
    let op = 1;
    let img = false;
    const layers = chain.map((e) => {
      const cs = getComputedStyle(e);
      op *= Number(cs.opacity);
      img ||= cs.backgroundImage !== 'none';
      const [r0, g0, b0, a0] = rgba(cs.backgroundColor);
      return { c: [r0, g0, b0], a: a0 * op };
    });
    const cs = getComputedStyle(el);
    // SVG text is painted with fill (and fill-opacity), not CSS color.
    const svg = el instanceof SVGElement;
    const fill = svg ? rgba(cs.fill) : rgba(cs.color);
    if (svg) fill[3] *= Number(cs.fillOpacity);
    out.push({ text: node.textContent.trim().slice(0, 40), el: `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') ?? '').split(/\s+/).slice(0, 3).join('.')}`,
      fg: fill, size: parseFloat(cs.fontSize), bold: Number(cs.fontWeight) >= 700, layers, img, op });
  }
  return out;
});

const hex = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
/** Effective colors of one node, then its ratio against the AA requirement. */
export function evaluate(n: Raw) {
  let bg = [255, 255, 255];
  for (const l of n.layers) bg = bg.map((v, i) => l.c[i] * l.a + v * (1 - l.a));
  const a = n.fg[3] * n.op;
  const fg = n.fg.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a));
  const large = n.size >= 24 || (n.size >= 18.66 && n.bold);
  return { ratio: contrastRatio(hex(fg), hex(bg)), need: large ? 3 : 4.5, fg: hex(fg), bg: hex(bg) };
}

for (const theme of Object.keys(MAX)) {
  test(`rendered contrast audit: ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('ratio.theme', t), theme);
    let failing = 0;
    const rows: string[] = [];
    const dump: unknown[] = [];
    for (const route of PAGES) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const nodes = await collect(page);
      const bad = nodes.map((n) => ({ n, ...evaluate(n) })).filter((x) => x.ratio < x.need - 1e-9);
      failing += bad.length;
      rows.push(`${theme.padEnd(14)} ${route.padEnd(12)} ${String(bad.length).padStart(4)} / ${nodes.length}  (background images: ${nodes.filter((x) => x.img).length})`);
      for (const x of bad) dump.push({ theme, route, el: x.n.el, text: x.n.text, fg: x.fg, bg: x.bg, ratio: +x.ratio.toFixed(2), need: x.need });
    }
    rows.push(`${theme.padEnd(14)} TOTAL        ${String(failing).padStart(4)} (max ${MAX[theme]})`);
    if (process.env.AUDIT_OUT) appendFileSync(process.env.AUDIT_OUT, rows.join('\n') + '\n');
    if (process.env.AUDIT_DUMP) appendFileSync(process.env.AUDIT_DUMP, dump.map((d) => JSON.stringify(d)).join('\n') + '\n');
    expect(failing, `${theme}: failing text nodes (ratchet: may only go down)`).toBeLessThanOrEqual(MAX[theme]);
  });
}

// CSS opacity composites an element and its descendants as one group. Layers are listed
// outermost first: own background (c, a), own opacity (o); fg is the text color with alpha.
const L = (c: number[], a: number, o = 1) => ({ c, a, o });
const node = (layers: ReturnType<typeof L>[], fg: number[]): Raw => ({ text: '', el: '', fg, size: 16, bold: false, layers, img: false, op: 1 });
test.describe('opacity group compositing', () => {
  test('black text on an opaque white child at opacity .5 over black paints black on gray', () => {
    const r = evaluate(node([L([0, 0, 0], 1), L([255, 255, 255], 1, 0.5)], [0, 0, 0, 1]));
    expect([r.fg, r.bg]).toEqual(['#000000', '#808080']);
    expect(r.ratio).toBeCloseTo(contrastRatio('#000000', '#808080'), 5);
  });
  test('nested opacities multiply on the text and leave the background alone', () => {
    const r = evaluate(node([L([0, 0, 0], 0, 0.5), L([0, 0, 0], 0, 0.5)], [0, 0, 0, 1]));
    expect([r.fg, r.bg]).toEqual(['#bfbfbf', '#ffffff']);
  });
  test('background alpha and fill-opacity composite over the canvas', () => {
    expect(evaluate(node([L([0, 0, 0], 0.5)], [255, 255, 255, 1]))).toMatchObject({ fg: '#ffffff', bg: '#808080' });
    expect(evaluate(node([L([255, 255, 255], 1)], [0, 0, 0, 0.5]))).toMatchObject({ fg: '#808080', bg: '#ffffff' });
  });
  test('a translucent child fades its text and background together over the parent', () => {
    const r = evaluate(node([L([0, 0, 255], 1), L([255, 0, 0], 1, 0.5)], [255, 255, 255, 1]));
    expect([r.fg, r.bg]).toEqual(['#8080ff', '#800080']);
  });
});
