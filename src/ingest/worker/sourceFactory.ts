// Resolves the FocusSource for a (RLS-visible) source row. focus_file ⇒ the
// S3 AWS Data Exports source (location from sources.config, connection from
// env). fake ⇒ refused unless NODE_ENV=test AND RATIO_ALLOW_FAKE_SOURCE=1.
import type { S3Client } from '@aws-sdk/client-s3';
import { IngestError } from '../errors';
import { FakeFocusSource, assertFakeSourceAllowed, type FakePeriod } from '../sources/fake/FakeFocusSource';
import { S3FocusExportSource } from '../sources/s3/S3FocusExportSource';
import { dataPrefix, validateLocation } from '../sources/s3/layout';
import { FIXTURE_LOCATION, generateSyntheticExport } from '../fixtures/syntheticFocus';
import type { FocusSource } from '../sources/types';
import type { SourceRow } from './lease';

export function makeSourceFactory(env: Record<string, string | undefined>, s3: () => S3Client): (row: SourceRow) => FocusSource {
  return (row) => {
    if (row.kind === 'fake') {
      assertFakeSourceAllowed(env);
      if (row.config.fixture !== 'synthetic-base') throw new IngestError('SOURCE_CONFIG_INVALID', 'fake source config.fixture must be "synthetic-base"');
      return fakeFromSynthetic();
    }
    if (row.kind === 'focus_file') return new S3FocusExportSource({ client: s3(), location: validateLocation(row.config) });
    throw new IngestError('SOURCE_CONFIG_INVALID', 'unsupported source kind');
  };
}

/** The synthetic base fixture as an in-memory fake source (tests only). */
export function fakeFromSynthetic(): FakeFocusSource {
  const exp = generateSyntheticExport({ variant: 'base' });
  const loc = { bucket: 'unused', ...FIXTURE_LOCATION };
  const periods: FakePeriod[] = Object.entries(exp.totals).map(([period, t]) => {
    const prefix = dataPrefix(loc, period);
    return {
      billingPeriod: period,
      artifacts: exp.objects.filter((o) => o.key.startsWith(prefix)).map((o) => ({ name: o.key.slice(prefix.length), bytes: o.bytes })),
      control: { rowCount: t.rowCount, billedTotal: t.billedTotal },
    };
  });
  return new FakeFocusSource(periods);
}
