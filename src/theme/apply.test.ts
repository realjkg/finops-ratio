// @vitest-environment happy-dom
// applyTheme against a real DOM: variables, color-scheme and data-theme on <html>.
import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme } from './apply';
import { hexToRgb } from './contrast';
import { BUILT_IN_THEMES, ROLES } from './themes';

const root = () => document.documentElement;
beforeEach(() => {
  root().removeAttribute('data-theme');
  root().removeAttribute('style');
});

describe('applyTheme', () => {
  it('sets data-theme, color-scheme and every --c-* channel triplet', () => {
    expect(applyTheme('dark')).toEqual([]);
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(root().style.getPropertyValue('color-scheme')).toBe('dark');
    for (const role of ROLES) {
      expect(root().style.getPropertyValue(`--c-${role}`), role).toBe(hexToRgb(BUILT_IN_THEMES.dark.colors[role]).join(' '));
    }
  });

  it('applies a valid custom theme under its own name', () => {
    expect(applyTheme({ ...BUILT_IN_THEMES.light, name: 'mine' })).toEqual([]);
    expect(root().getAttribute('data-theme')).toBe('mine');
  });

  it('refuses invalid or unknown themes without touching the document', () => {
    const bad = { ...BUILT_IN_THEMES.light, name: 'mine', colors: { ...BUILT_IN_THEMES.light.colors, txt: '#eeeeee' } };
    expect(applyTheme(bad).length).toBeGreaterThan(0);
    expect(applyTheme('__proto__' as never).map((v) => v.code)).toEqual(['unknown-theme']);
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(root().getAttribute('style')).toBeNull();
  });

  it('is a no-op with an explicitly absent document even when one exists', () => {
    expect(applyTheme('light', null)).toEqual([]);
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(root().getAttribute('style')).toBeNull();
  });
});
