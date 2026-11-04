import { describe, expect, it } from 'vitest';
import { ALERTS } from './alerts';
import { alertMessage } from './alertPresentation';

describe('alert display wording', () => {
  it('shows Value / cost for the fraud alert, keyed by its stable id', () => {
    const a = ALERTS.find((x) => x.id === 'al-002')!;
    expect(alertMessage(a)).toMatch(/^Value \/ cost fell to -0\.2×/);
    expect(a.message).toMatch(/^Value ratio fell/); // the API contract string is untouched
  });
  it('leaves every other alert exactly as the contract has it', () => {
    for (const a of ALERTS.filter((x) => x.id !== 'al-002')) expect(alertMessage(a)).toBe(a.message);
  });
  it('is not a text replacement: a lookalike message with another id is not rewritten', () => {
    const a = { ...ALERTS.find((x) => x.id === 'al-002')!, id: 'al-x' };
    expect(alertMessage(a)).toBe(a.message);
  });
});
