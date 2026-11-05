// Display wording for the offline sandbox sources. The API values (name, note, health detail) are a
// public contract and stay unchanged; the UI shows these instead: no "synthetic" or "seed" label, and
// still "offline" and "not a live integration".
import { describe, expect, it } from 'vitest';
import { sourcesForEnv } from './seed';
import { MockCostSourceClient } from './MockCostSourceClient';
import { SOURCE_DISPLAY, displayHealthDetail, displaySourceName, displaySourceNote } from './sourcePresentation';

const SANDBOXES = ['pointfive-sandbox', 'focus-file-sandbox', 'servicenow-sandbox', 'aws-sandbox', 'azure-sandbox', 'gcp-sandbox'];

describe('sandbox source display wording', () => {
  it('covers every offline sandbox, and only those', () => {
    expect(Object.keys(SOURCE_DISPLAY).sort()).toEqual([...SANDBOXES].sort());
    const ids = sourcesForEnv({}).map((s) => s.id);
    for (const id of SANDBOXES) expect(ids, id).toContain(id);
  });

  it('never labels the data synthetic or seeded, and keeps "offline" and "not a live integration"', async () => {
    for (const s of sourcesForEnv({}).filter((x) => SANDBOXES.includes(x.id))) {
      const name = displaySourceName(s);
      const note = displaySourceNote(s);
      const health = await new MockCostSourceClient().healthCheck(s.id);
      const detail = displayHealthDetail(s.id, health.detail, health.reachable);
      expect(`${name} ${note} ${detail}`, s.id).not.toMatch(/synthetic|\bseed|sample/i);
      expect(`${name} ${note}`, s.id).toMatch(/sandbox|offline/i);
      // "live" appears only as a denial ("not a live", "no live") or the future live adapter, never as a claim.
      expect(`${note} ${detail}`.replace(/not a live|no live|the live adapter/gi, ''), s.id).not.toMatch(/\blive\b/i);
      if (s.id !== 'pointfive-sandbox' && s.id !== 'focus-file-sandbox') expect(`${note} ${detail}`, s.id).toMatch(/not a live|no live/);
    }
  });

  it('leaves the API values themselves untouched (contract)', () => {
    const aws = sourcesForEnv({}).find((s) => s.id === 'aws-sandbox')!;
    expect(aws.name).toBe('AWS (synthetic sandbox)');
    expect(displaySourceName(aws)).toBe('AWS (offline sandbox)');
    expect(sourcesForEnv({}).find((s) => s.id === 'servicenow-sandbox')!.name).toBe('ServiceNow (synthetic demo data)');
  });

  it('passes other sources and unreachable health through unchanged', () => {
    expect(displaySourceName({ id: 'aws-data-exports', name: 'AWS Data Exports' })).toBe('AWS Data Exports');
    expect(displaySourceName({ id: 'toString', name: 'x' })).toBe('x');
    expect(displayHealthDetail('aws-sandbox', 'Unknown source', false)).toBe('Unknown source');
    expect(displayHealthDetail('nope', 'detail')).toBe('detail');
  });
});
