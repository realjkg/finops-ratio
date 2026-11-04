// Tests for the persona language map (Ratio v2 Wave 2a). Verifies every persona
// has a complete, distinct vocabulary and that the locked executive wording
// ("Initiative Dashboard", "Cost efficiency", …) matches the approved Wave 2
// design. Pure data — no DOM.
import { describe, it, expect } from 'vitest';
import { LANGUAGE_MAP, languageFor, type LanguageMap } from './languageMap';
import { PERSONAS, type Persona } from './persona';

const KEYS: (keyof LanguageMap)[] = [
  'boardTitle',
  'itemLabel',
  'fuelLabel',
  'trajectoryLabel',
  'gateLabel',
  'adjustmentLabel',
  'valueRatioLabel',
];

describe('language map', () => {
  it('covers all three personas', () => {
    for (const persona of PERSONAS) {
      expect(LANGUAGE_MAP[persona]).toBeDefined();
    }
    expect(Object.keys(LANGUAGE_MAP).sort()).toEqual([...PERSONAS].sort());
  });

  it('defines every key, non-empty, for every persona', () => {
    for (const persona of PERSONAS) {
      const map = LANGUAGE_MAP[persona];
      for (const key of KEYS) {
        expect(typeof map[key]).toBe('string');
        expect(map[key].length).toBeGreaterThan(0);
      }
    }
  });

  it('locks the approved executive vocabulary', () => {
    expect(LANGUAGE_MAP.executive).toEqual({
      boardTitle: 'Initiative Dashboard',
      itemLabel: 'Initiative',
      fuelLabel: 'Budget used',
      trajectoryLabel: 'Forecast',
      gateLabel: 'Approval Required',
      adjustmentLabel: 'Proposed change',
      valueRatioLabel: 'Cost efficiency',
    });
  });

  it('keeps the technical vocabulary as the original Mission Control wording', () => {
    expect(LANGUAGE_MAP.technical.boardTitle).toBe('Mission Board');
    expect(LANGUAGE_MAP.technical.itemLabel).toBe('Mission');
    expect(LANGUAGE_MAP.technical.fuelLabel).toBe('Fuel');
    expect(LANGUAGE_MAP.technical.valueRatioLabel).toBe('Value ratio');
  });

  it('gives procurement its own savings-oriented wording', () => {
    expect(LANGUAGE_MAP.procurement.boardTitle).toBe('Spend Overview');
    expect(LANGUAGE_MAP.procurement.itemLabel).toBe('Cost Center');
    expect(LANGUAGE_MAP.procurement.trajectoryLabel).toBe('Projected savings');
  });

  it('differentiates the board title across personas', () => {
    const titles = (PERSONAS as readonly Persona[]).map((p) => LANGUAGE_MAP[p].boardTitle);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('languageFor returns the matching map', () => {
    for (const persona of PERSONAS) {
      expect(languageFor(persona)).toBe(LANGUAGE_MAP[persona]);
    }
  });
});

