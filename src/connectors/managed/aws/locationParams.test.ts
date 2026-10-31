// Owner-approved schema change (2026-10-30): the prefix rule bounds the COMPLETE object key the AWS
// retriever builds (layout.ts), in UTF-8 bytes, not the configured prefix alone. Startup (R1) and the
// worker check must agree at the boundary. Lives under aws/ because only this subtree may import
// src/ingest (importBoundary.test.ts). SYNTHETIC values only.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { checkEngagementConfig } from '../../../engagement/config';
import { dataPrefix, periodMetadataPrefix, validateLocation } from '../../../ingest/sources/s3/layout';
import { AWS_FILE_PART_RESERVE_BYTES, S3_KEY_MAX_BYTES, engagementProblems } from '../engagementSpec';
import { managedRegistry } from '../registry';

const FIXTURE = path.resolve(__dirname, '../../../../fixtures/engagement/example/engagement.json');
const PERIOD = '2026-01-01';
/** Deterministic generated names (SYNTHETIC): random-looking, as real generated names are, without literal secret-shaped text. */
const generated = (n: number, alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', seed = 7) => {
  let x = seed;
  return Array.from({ length: n }, () => alphabet[(x = (x * 1103515245 + 12345) % 2147483648) % alphabet.length]).join('');
};

/** The longest key the retriever reads under this export: the period's metadata folder plus the reserved file part. */
const longestKeyBytes = (prefix: string, exportName: string) => Buffer.byteLength(periodMetadataPrefix({ bucket: 'b', prefix, exportName }, PERIOD)) + AWS_FILE_PART_RESERVE_BYTES;

/** A multibyte prefix whose longest key is exactly `bytes` long. */
function prefixFor(bytes: number, exportName: string): string {
  const n = bytes - longestKeyBytes('', exportName) - 1; // + '/' between prefix and exportName
  return 'é'.repeat(Math.floor(n / 2)) + (n % 2 ? 'a' : '');
}

function verdicts(prefix: string, exportName: string) {
  const c = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', secretRef: 'aws/focus', params: { bucket: 'export-bucket', prefix, exportName, region: 'us-east-1', table: 'FOCUS_1_2_AWS' } };
  const startup = checkEngagementConfig(c);
  return { startup: startup.ok ? [] : startup.problems, worker: engagementProblems(c, managedRegistry.connectors()) };
}

describe('AWS prefix: complete object key in UTF-8 bytes', () => {
  it('the metadata folder is the longest fixed part the retriever appends', () => {
    const loc = { bucket: 'b', prefix: 'p', exportName: 'e' };
    expect(Buffer.byteLength(periodMetadataPrefix(loc, PERIOD))).toBeGreaterThan(Buffer.byteLength(dataPrefix(loc, PERIOD)));
    expect(periodMetadataPrefix(loc, PERIOD)).toBe('p/e/metadata/BILLING_PERIOD=2026-01/');
  });

  for (const exportName of ['focus', 'E'.repeat(128)]) {
    it(`accepts a key of exactly ${S3_KEY_MAX_BYTES} bytes and refuses ${S3_KEY_MAX_BYTES + 1}, on both sides (exportName of ${exportName.length})`, () => {
      const fits = prefixFor(S3_KEY_MAX_BYTES, exportName);
      const over = prefixFor(S3_KEY_MAX_BYTES + 1, exportName);
      expect(longestKeyBytes(fits, exportName)).toBe(S3_KEY_MAX_BYTES);
      expect(longestKeyBytes(over, exportName)).toBe(S3_KEY_MAX_BYTES + 1);
      expect(fits.length).toBeLessThan(S3_KEY_MAX_BYTES / 2 + 1); // bytes, not characters, hit the limit
      expect(verdicts(fits, exportName)).toEqual({ startup: [], worker: [] });
      const o = verdicts(over, exportName);
      expect(o.startup).toHaveLength(1);
      expect(o.startup[0]).toMatch(/^sources\[0\]\.retrieval\.params\.prefix: with exportName, the longest object key/);
      expect(o.worker).toEqual(o.startup);
      expect(o.startup[0]).not.toContain('é');
    });
  }

  it('an accepted ASCII prefix and exportName also form a location the retriever accepts', () => {
    const prefix = `exports/focus-1-2/${generated(43, undefined, 13)}`;
    const exportName = generated(41, undefined, 11);
    expect(verdicts(prefix, exportName)).toEqual({ startup: [], worker: [] });
    expect(validateLocation({ layout: 'aws-data-exports', bucket: 'export-bucket', prefix, exportName })).toEqual({ bucket: 'export-bucket', prefix, exportName });
  });
});
