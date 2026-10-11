// WCAG 2.x contrast (relative luminance and contrast ratio as defined in WCAG 2.1) and a
// minimal lightness adjustment for colors that fall short. Pure; '#rrggbb' only.

type Rgb = [number, number, number];
const HEX = /^#[0-9a-f]{6}$/i;

export function hexToRgb(hex: string): Rgb {
  if (!HEX.test(hex)) throw new Error(`Malformed color ${JSON.stringify(hex)}: expected #rrggbb`);
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

const toHex = (rgb: Rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` at `alpha` (0..1) over opaque `bg`, as Tailwind renders bg-<color>/<n>. */
export function composite(fg: string, alpha: number, bg: string): string {
  const [a, b] = [hexToRgb(fg), hexToRgb(bg)];
  return toHex([0, 1, 2].map((i) => a[i] * alpha + b[i] * (1 - alpha)) as Rgb);
}

/** Black or white, whichever reads better on `bg`. */
export function onColor(bg: string): '#000000' | '#ffffff' {
  return contrastRatio('#000000', bg) >= contrastRatio('#ffffff', bg) ? '#000000' : '#ffffff';
}

function toHsl([r, g, b]: Rgb): Rgb {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

function fromHsl([h, s, l]: Rgb): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b]: Rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * Returns `fg` if it already meets `min` against `bg`; otherwise the color with the
 * same hue and saturation whose HSL lightness is closest to fg's (0.5% steps, in
 * either direction) that meets it. If no lightness reaches `min`, returns
 * onColor(bg) with `ok: false`: callers must treat that as "target unreachable".
 */
export function ensureContrast(fg: string, bg: string, min: number): { color: string; ok: boolean } {
  const start = toHex(hexToRgb(fg));
  if (contrastRatio(start, bg) >= min) return { color: start, ok: true };
  const [h, s, l] = toHsl(hexToRgb(fg));
  for (let step = 1; step <= 200; step++) {
    for (const dir of [1, -1]) {
      const lightness = Math.min(1, Math.max(0, l + dir * step * 0.005));
      const candidate = toHex(fromHsl([h, s, lightness]));
      if (contrastRatio(candidate, bg) >= min) return { color: candidate, ok: true };
    }
  }
  const color = onColor(bg);
  return { color, ok: contrastRatio(color, bg) >= min };
}
