import { describe, expect, it } from 'vitest';
import {
  classifyArtifact,
  dataPrefix,
  listingFingerprint,
  metadataPrefix,
  parseManifest,
  parsePeriodPrefix,
  periodInRange,
  validateLocation,
  type ListingEntry,
} from './layout';

const loc = { bucket: 'cur-bucket', prefix: 'exports/focus', exportName: 'focus-export' };
const P = '2026-07-01';
const DATA = 'exports/focus/focus-export/data/BILLING_PERIOD=2026-07/run-1/';

function listing(keys: string[]): Map<string, ListingEntry> {
  return new Map(keys.map((k, i) => [k, { size: 100 + i, etag: `"etag${i}"` }]));
}
const manifest = (doc: unknown) => Buffer.from(JSON.stringify(doc));

describe('AWS Data Exports layout', () => {
  it('derives metadata and data prefixes', () => {
    expect(metadataPrefix(loc)).toBe('exports/focus/focus-export/metadata/');
    expect(dataPrefix(loc, P)).toBe('exports/focus/focus-export/data/BILLING_PERIOD=2026-07/');
    expect(metadataPrefix({ ...loc, prefix: '' })).toBe('focus-export/metadata/');
  });

  it('parses BILLING_PERIOD=YYYY-MM prefixes and filters by range', () => {
    expect(parsePeriodPrefix('exports/focus/focus-export/metadata/BILLING_PERIOD=2026-07/', loc)).toBe('2026-07-01');
    expect(parsePeriodPrefix('exports/focus/focus-export/metadata/BILLING_PERIOD=2026-13/', loc)).toBeNull();
    expect(parsePeriodPrefix('exports/focus/focus-export/metadata/OTHER/', loc)).toBeNull();
    expect(parsePeriodPrefix('elsewhere/BILLING_PERIOD=2026-07/', loc)).toBeNull();
    expect(periodInRange('2026-07-01', { from: '2026-06-01', to: '2026-07-01' })).toBe(true);
    expect(periodInRange('2026-08-01', { from: '2026-06-01', to: '2026-07-01' })).toBe(false);
    expect(periodInRange('2026-08-01', undefined)).toBe(true);
  });

  it('validates source config (bucket/prefix/exportName), failing closed', () => {
    expect(validateLocation({ layout: 'aws-data-exports', ...loc })).toEqual(loc);
    for (const bad of [
      {},
      { layout: 'aws-data-exports', bucket: 'b', prefix: '', exportName: '' },
      { layout: 'aws-data-exports', bucket: 'Bad_Bucket', prefix: '', exportName: 'x' },
      { layout: 'aws-data-exports', bucket: 'b', prefix: '../up', exportName: 'x' },
      { layout: 'aws-data-exports', bucket: 'b', prefix: '/abs', exportName: 'x' },
      { layout: 'aws-data-exports', bucket: 'b', prefix: 'a', exportName: 'x/y' },
      { layout: 'other', bucket: 'b', prefix: 'a', exportName: 'x' },
    ]) {
      expect(() => validateLocation(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'SOURCE_CONFIG_INVALID' }));
    }
  });

  it('parses dataFiles given as bucket-relative keys, s3 URIs and objects with row counts', () => {
    const keys = [DATA + 'focus-export-00001.csv.gz', DATA + 'focus-export-00002.csv.gz'];
    const r = parseManifest(
      manifest({
        dataFiles: [`s3://cur-bucket/${keys[0]}`, { key: keys[1], rowCount: 5 }],
        billingPeriod: { start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' },
        'x-ratio-control': { rowCount: 12, billedTotal: '123.4500' },
      }),
      { location: loc, billingPeriod: P, listing: listing(keys) },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifacts.map((a) => a.key)).toEqual(keys);
    expect(r.artifacts.map((a) => a.name)).toEqual(['run-1/focus-export-00001.csv.gz', 'run-1/focus-export-00002.csv.gz']);
    expect(r.artifacts[0]).toMatchObject({ byteSize: 100, version: '"etag0"' });
    expect(r.control).toEqual({ rowCount: 12, billedTotal: '123.4500', artifactRowCounts: { 'run-1/focus-export-00002.csv.gz': 5 } });
  });

  it('a manifest without control yields no control', () => {
    const keys = [DATA + 'a.csv.gz'];
    const r = parseManifest(manifest({ dataFiles: keys }), { location: loc, billingPeriod: P, listing: listing(keys) });
    expect(r.ok && r.control).toBeUndefined();
  });

  const refused: Array<[string, unknown, string[]]> = [
    ['not JSON', '{nope', []],
    ['no dataFiles', { files: [] }, []],
    ['another bucket', { dataFiles: [`s3://evil-bucket/${DATA}a.csv.gz`] }, [DATA + 'a.csv.gz']],
    ['path traversal', { dataFiles: [`${DATA}../../../../secret/a.csv.gz`] }, [`${DATA}../../../../secret/a.csv.gz`]],
    ['dot segment', { dataFiles: [`${DATA}./a.csv.gz`] }, [`${DATA}./a.csv.gz`]],
    ['empty segment', { dataFiles: [`${DATA}/a.csv.gz`] }, [`${DATA}/a.csv.gz`]],
    ['query string', { dataFiles: [`${DATA}a.csv.gz?X-Amz-Signature=abc`] }, [`${DATA}a.csv.gz?X-Amz-Signature=abc`]],
    ['other period folder', { dataFiles: ['exports/focus/focus-export/data/BILLING_PERIOD=2026-06/run-1/a.csv.gz'] }, ['exports/focus/focus-export/data/BILLING_PERIOD=2026-06/run-1/a.csv.gz']],
    ['outside the export', { dataFiles: ['exports/focus/other-export/data/BILLING_PERIOD=2026-07/a.csv.gz'] }, ['exports/focus/other-export/data/BILLING_PERIOD=2026-07/a.csv.gz']],
    ['file not in listing', { dataFiles: [DATA + 'missing.csv.gz'] }, []],
    ['billingPeriod mismatch', { dataFiles: [DATA + 'a.csv.gz'], billingPeriod: { start: '2026-06-01T00:00:00Z' } }, [DATA + 'a.csv.gz']],
    ['non-integer control rowCount', { dataFiles: [DATA + 'a.csv.gz'], 'x-ratio-control': { rowCount: 1.5 } }, [DATA + 'a.csv.gz']],
    ['non-decimal control total', { dataFiles: [DATA + 'a.csv.gz'], 'x-ratio-control': { billedTotal: 12.5 } }, [DATA + 'a.csv.gz']],
    ['NaN control total', { dataFiles: [DATA + 'a.csv.gz'], 'x-ratio-control': { billedTotal: 'NaN' } }, [DATA + 'a.csv.gz']],
    ['duplicate data file', { dataFiles: [DATA + 'a.csv.gz', DATA + 'a.csv.gz'] }, [DATA + 'a.csv.gz']],
  ];
  for (const [name, doc, keys] of refused) {
    it(`refuses a manifest with ${name}`, () => {
      const bytes = typeof doc === 'string' ? Buffer.from(doc) : manifest(doc);
      const r = parseManifest(bytes, { location: loc, billingPeriod: P, listing: listing(keys) });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('MANIFEST_INVALID');
        expect(r.message).not.toMatch(/X-Amz-Signature=abc/);
      }
    });
  }

  // Copilot M2 (third review): the artifact name is STORED redacted
  // (ingest_artifacts.artifact_name = redact(name), CHECK length <= 1024
  // characters), so the limit applies to the stored, redacted form.
  describe('artifact name length is bounded by the stored (redacted) length, 1024', () => {
    const nameOf = (len: number, tail = '') => 'run-1/' + 'n'.repeat(len - 6 - tail.length) + tail; // relative to the period's data folder
    const parse = (name: string) => {
      const key = 'exports/focus/focus-export/data/BILLING_PERIOD=2026-07/' + name;
      return parseManifest(manifest({ dataFiles: [key] }), { location: loc, billingPeriod: P, listing: listing([key]) });
    };
    it('1024 characters: accepted', () => {
      const r = parse(nameOf(1024));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.artifacts[0].name).toHaveLength(1024);
    });
    it('1025 characters: MANIFEST_INVALID', () => {
      expect(parse(nameOf(1025))).toMatchObject({ ok: false, code: 'MANIFEST_INVALID' });
    });
    it('1021 raw characters whose REDACTED form (stored) is 1030: MANIFEST_INVALID', () => {
      const name = nameOf(1021, '/token=x');
      expect(name).toHaveLength(1021);
      expect(parse(name)).toMatchObject({ ok: false, code: 'MANIFEST_INVALID' });
    });
  });

  it('listing fingerprint is order-independent and changes with etag, size or manifest bytes', () => {
    const a = { name: 'a', key: 'k/a', byteSize: 1, version: 'e1' };
    const b = { name: 'b', key: 'k/b', byteSize: 2, version: 'e2' };
    const m = Buffer.from('{}');
    const base = listingFingerprint(m, [a, b]);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(listingFingerprint(m, [b, a])).toBe(base);
    expect(listingFingerprint(m, [{ ...a, version: 'e9' }, b])).not.toBe(base);
    expect(listingFingerprint(m, [{ ...a, byteSize: 9 }, b])).not.toBe(base);
    expect(listingFingerprint(Buffer.from('{ }'), [a, b])).not.toBe(base);
  });

  it('classifies artifact formats', () => {
    expect(classifyArtifact('x/part-00001.csv.gz')).toBe('csv.gz');
    expect(classifyArtifact('x/part.CSV.GZ')).toBe('csv.gz');
    expect(classifyArtifact('x/part.csv')).toBe('csv');
    expect(classifyArtifact('x/part-00001.snappy.parquet')).toBe('unsupported');
    expect(classifyArtifact('x/part.json')).toBe('unsupported');
  });
});
