import { describe, expect, it } from 'vitest';
import { ROLES } from '@/theme/themes';
import { TOKEN_COLOR, budgetColor, ratioColor, tint } from './scales';

describe('accent colors follow the active theme', () => {
  it('every accent is the theme variable of the same name, never a literal', () => {
    for (const [role, value] of Object.entries(TOKEN_COLOR)) {
      expect(ROLES).toContain(role);
      expect(value).toBe(`rgb(var(--c-${role}))`);
    }
  });

  it('rating and budget scales return those variables', () => {
    expect([12, 6, 3, 1].map(ratioColor)).toEqual([TOKEN_COLOR.value, TOKEN_COLOR.unit, TOKEN_COLOR.shape, TOKEN_COLOR.cost]);
    expect([0.5, 0.8, 0.95].map(budgetColor)).toEqual([TOKEN_COLOR.value, TOKEN_COLOR.shape, TOKEN_COLOR.cost]);
  });

  it('tint mixes a color toward transparent (no hex-alpha suffix)', () => {
    expect(tint(TOKEN_COLOR.value)).toBe('color-mix(in srgb, rgb(var(--c-value)) 10%, transparent)');
    expect(tint(TOKEN_COLOR.gate, 25)).toBe('color-mix(in srgb, rgb(var(--c-gate)) 25%, transparent)');
  });
});
