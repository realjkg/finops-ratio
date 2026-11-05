// SYNTHETIC stand-in for the C4 detectors (TEST-ONLY): every occurrence of each seeded marker, offsets only.
import type { DlpFinding } from '../../contracts';

export const seeded = (markers: string[]) => (text: string, location: DlpFinding['location']): DlpFinding[] => {
  const out: DlpFinding[] = [];
  for (const m of markers) for (let at = text.indexOf(m); at >= 0; at = text.indexOf(m, at + 1)) {
    out.push({ category: 'payment_card', detectorId: 'seeded-marker', detectorVersion: 1, confidence: 'high', location, start: at, end: at + m.length, normalization: [] });
  }
  return out;
};
