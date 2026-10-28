// M0b: provider ORIGINALS (objects or API/query pages) are stored unmodified,
// content-addressed, with their identity; page sequences report completion;
// version facts are separate fields and never invented. SYNTHETIC inputs.
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { PageSequence, captureOriginal, observeSchema, originalKey, versionFacts, type OriginalsStore } from './capture';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function memoryStore(): OriginalsStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async putBytes(key, bytes) {
      if (objects.has(key)) return 'exists';
      objects.set(key, Buffer.from(bytes));
      return 'stored';
    },
  };
}

describe('captureOriginal', () => {
  it('stores the unmodified bytes; the stored sha256 equals the received sha256', async () => {
    const store = memoryStore();
    const bytes = Buffer.from('{"data":[{"amount":"1.23"}],"next_page":null}\n');
    const at = new Date('2026-10-28T12:00:00Z');
    const c = await captureOriginal(store, { tenantId: TENANT, sourceId: SOURCE }, bytes, { kind: 'page', endpoint: 'https://api.example.test/v1/costs', method: 'GET', params: { start: '2026-09-01' }, pageIndex: 0, requestId: 'req-1' }, at);
    expect(c).toMatchObject({ sha256: sha(bytes), byteSize: bytes.length, key: originalKey(TENANT, SOURCE, sha(bytes)), retrievedAt: '2026-10-28T12:00:00.000Z', stored: 'stored' });
    expect(sha(store.objects.get(c.key)!)).toBe(sha(bytes));
    const again = await captureOriginal(store, { tenantId: TENANT, sourceId: SOURCE }, bytes, { kind: 'object', bucket: 'b', key: 'k', etag: 'e' }, at);
    expect(again.stored).toBe('exists');
  });

  it('redacts credential-looking identity parameters and refuses a bad key input', async () => {
    const store = memoryStore();
    const c = await captureOriginal(store, { tenantId: TENANT, sourceId: SOURCE }, Buffer.from('x'), {
      kind: 'page', endpoint: 'https://api.example.test/v1/usage?api_key=abc', method: 'GET', params: { limit: '10', api_key: 'sk-SYNTHETIC', Authorization: 'Bearer SYNTHETIC', signature: 'zzz' }, pageIndex: 0,
    });
    expect(c.identity).toEqual({ kind: 'page', endpoint: 'https://api.example.test/v1/usage', method: 'GET', params: { limit: '10', api_key: '[redacted]', Authorization: '[redacted]', signature: '[redacted]' }, pageIndex: 0 });
    expect(JSON.stringify(c)).not.toMatch(/SYNTHETIC|abc|zzz/);
    await expect(captureOriginal(store, { tenantId: 'not-a-uuid', sourceId: SOURCE }, Buffer.from('x'), { kind: 'object', bucket: 'b', key: 'k' })).rejects.toThrow(/uuid/);
  });
});

describe('PageSequence', () => {
  it('is complete only when indices are contiguous from 0 and the last page has no next token', () => {
    const s = new PageSequence();
    s.add({ pageIndex: 0, nextPageToken: 't1' });
    s.add({ pageIndex: 1, nextPageToken: 't2' });
    expect(s.completion()).toBe('incomplete'); // no terminal page
    s.add({ pageIndex: 2 });
    expect(s.completion()).toBe('complete');
    expect(s.pages).toBe(3);
  });

  it('a gap, a repeated index or a page after the terminal page is incomplete', () => {
    const gap = new PageSequence();
    gap.add({ pageIndex: 0, nextPageToken: 'a' });
    gap.add({ pageIndex: 2 });
    expect(gap.completion()).toBe('incomplete');
    const rep = new PageSequence();
    rep.add({ pageIndex: 0, nextPageToken: 'a' });
    rep.add({ pageIndex: 0 });
    expect(rep.completion()).toBe('incomplete');
    const after = new PageSequence();
    after.add({ pageIndex: 0 });
    after.add({ pageIndex: 1 });
    expect(after.completion()).toBe('incomplete');
    expect(new PageSequence().completion()).toBe('incomplete');
  });
});

describe('version facts', () => {
  it('keeps every version as its own field, unknown when not stated, never invented', () => {
    const snap = observeSchema(['BilledCost', 'BillingCurrency', 'ChargePeriodStart']);
    expect(snap).toEqual({ columns: ['BilledCost', 'BillingCurrency', 'ChargePeriodStart'], sha256: sha(Buffer.from('BilledCost\nBillingCurrency\nChargePeriodStart')) });
    const v = versionFacts({ provider: 'AWS', dataset: 'FOCUS 1.2 export', observedSchema: snap, mappingVersion: 'focus-passthrough', canonicalModelVersion: 'ratio-focus-1.0' });
    expect(v).toEqual({
      provider: 'AWS', dataset: 'FOCUS 1.2 export', apiVersion: 'unknown', exportSchemaVersion: 'unknown', observedSchema: snap, sourceFocusVersion: 'unknown', mappingVersion: 'focus-passthrough', canonicalModelVersion: 'ratio-focus-1.0',
    });
    expect(() => versionFacts({ provider: '', dataset: 'x', mappingVersion: 'm', canonicalModelVersion: 'c' })).toThrow(/provider/);
    expect(() => versionFacts({ provider: 'AWS', dataset: 'x', mappingVersion: 'm', canonicalModelVersion: 'c', observedSchema: { columns: ['a'], sha256: 'f'.repeat(64) } })).toThrow(/observedSchema/);
  });
});
