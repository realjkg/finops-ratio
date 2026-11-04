import { describe, expect, it } from 'vitest';
import { placePopup } from './popupPlacement';

const VIEWPORTS = [320, 360, 390, 768, 1440].map((width) => ({ width, height: 640 }));

describe('placePopup', () => {
  it('keeps the popup inside the viewport for an anchor anywhere along the row', () => {
    for (const vp of VIEWPORTS) {
      for (const x of [0, 10, 100, vp.width / 2, vp.width - 80, vp.width - 1]) {
        const p = placePopup({ left: x, right: x + 80, top: 300, bottom: 316 }, 90, vp);
        expect(p.left, `${vp.width}@${x}`).toBeGreaterThanOrEqual(8);
        expect(p.left + p.width, `${vp.width}@${x}`).toBeLessThanOrEqual(vp.width - 8);
      }
    }
  });

  it('shrinks to fit a very narrow viewport', () => {
    expect(placePopup({ left: 0, right: 50, top: 10, bottom: 20 }, 50, { width: 200, height: 400 }).width).toBe(184);
  });

  it('opens below, and flips above only when there is no room below', () => {
    const vp = { width: 390, height: 640 };
    expect(placePopup({ left: 20, right: 100, top: 100, bottom: 116 }, 90, vp).top).toBe(120);
    expect(placePopup({ left: 20, right: 100, top: 580, bottom: 596 }, 90, vp).top).toBe(486);
  });
});
