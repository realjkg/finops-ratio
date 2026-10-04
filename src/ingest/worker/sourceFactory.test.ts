// Issue #62, orchestrator decision D4 (2026-10-04): the provider check skips
// a source row without a recognised type (providerPolicyFor ⇒ null). That
// path must stay UNREACHABLE from the CLI: the source factory, the only
// production path from a source row to its data, refuses every such row
// before anything is listed or read. This test pins it.
import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { makeSourceFactory } from './sourceFactory';
import { providerPolicyFor } from '../focus/provider';
import type { SourceRow } from './lease';

const row = (kind: string, config: Record<string, unknown>): SourceRow =>
  ({ tenantId: '00000000-0000-4000-8000-000000000001', id: '00000000-0000-4000-8000-000000000002', sourceKey: 'k', kind, enabled: true, config, declaredFocusVersion: '1.0' }) as SourceRow;

const awsLocation = { bucket: 'ratio-bucket', prefix: 'p', exportName: 'focus-export' };
const fakeS3 = () => ({}) as unknown as S3Client;
const TEST_ENV = { NODE_ENV: 'test', RATIO_ALLOW_FAKE_SOURCE: '1' };

const UNRECOGNISED: Array<[string, SourceRow]> = [
  ['focus_file without a layout', row('focus_file', { ...awsLocation })],
  ['focus_file with an empty config', row('focus_file', {})],
  ['focus_file with another layout', row('focus_file', { layout: 'azure-cost-exports', ...awsLocation })],
  ['focus_file with the layout in another case', row('focus_file', { layout: 'AWS-DATA-EXPORTS', ...awsLocation })],
  ['an unknown kind', row('azure_export', { layout: 'aws-data-exports', ...awsLocation })],
  ['an unknown kind without config', row('other', {})],
];

describe('D4 guard: the source factory refuses every source the provider check does not recognise', () => {
  for (const [name, r] of UNRECOGNISED) {
    it(`${name}: providerPolicyFor is null AND the factory refuses it (SOURCE_CONFIG_INVALID)`, () => {
      expect(providerPolicyFor(r, { allowSyntheticProviders: true })).toBeNull();
      for (const env of [{}, TEST_ENV]) {
        expect(() => makeSourceFactory(env, fakeS3)(r)).toThrow(expect.objectContaining({ code: 'SOURCE_CONFIG_INVALID' }));
      }
    });
  }

  it('every row the factory accepts has a provider policy (checked)', () => {
    const accepted: Array<[Record<string, string>, SourceRow]> = [
      [{}, row('focus_file', { layout: 'aws-data-exports', ...awsLocation })],
      [TEST_ENV, row('fake', { fixture: 'synthetic-base' })],
    ];
    for (const [env, r] of accepted) {
      expect(() => makeSourceFactory(env, fakeS3)(r)).not.toThrow();
      expect(providerPolicyFor(r, { allowSyntheticProviders: false })).not.toBeNull();
    }
  });
});
