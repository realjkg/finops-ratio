// R3: the native-to-FOCUS normalizer seam. Only the FOCUS pass-through exists;
// connector rows register the rest. Pure.
import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { FOCUS_PASSTHROUGH, collect, normalizerFor, registerNormalizer, type NativeNormalizer } from './normalizer';

describe('R3 NativeNormalizer registry', () => {
  it('FOCUS data passes through byte-identical with an empty mapping report', async () => {
    const n = normalizerFor('focus-export', '1.0');
    expect(n).toBe(FOCUS_PASSTHROUGH);
    const { csv, report } = await n.normalize(Readable.from(Buffer.from('a,b\n1,2\n')));
    expect((await collect(csv, 100)).toString()).toBe('a,b\n1,2\n');
    expect(report).toEqual({ normalizer: 'focus-passthrough', sourceKind: 'focus-export', schemaVersion: '*', unmappedColumns: [], defaultedFields: [] });
  });

  it('refuses a native kind with no registered normalizer (never guessed)', () => {
    expect(() => normalizerFor('aws-cur', '2.0')).toThrow(expect.objectContaining({ code: 'NORMALIZER_NOT_FOUND' }));
  });

  it('a registered normalizer is found by exact kind and version; a second registration is refused', () => {
    const fake: NativeNormalizer = { sourceKind: 'test-native', schemaVersion: '9.9', normalize: FOCUS_PASSTHROUGH.normalize };
    registerNormalizer(fake);
    expect(normalizerFor('test-native', '9.9')).toBe(fake);
    expect(() => normalizerFor('test-native', '9.8')).toThrow(expect.objectContaining({ code: 'NORMALIZER_NOT_FOUND' }));
    expect(() => registerNormalizer({ ...fake })).toThrow(expect.objectContaining({ code: 'NORMALIZER_EXISTS' }));
    expect(() => registerNormalizer({ ...FOCUS_PASSTHROUGH })).toThrow(expect.objectContaining({ code: 'NORMALIZER_EXISTS' }));
  });

  it('collect refuses a stream over its byte cap', async () => {
    await expect(collect(Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), 100)).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE' });
  });
});
