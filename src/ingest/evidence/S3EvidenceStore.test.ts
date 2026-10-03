// S3EvidenceStore against a fake S3 client (no network): opening an evidence
// object honours the run's abort signal (Copilot M5, third review).
import { describe, expect, it } from 'vitest';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { S3EvidenceStore } from './S3EvidenceStore';

describe('S3EvidenceStore.open is abort-aware', () => {
  it('the GET carries the abort signal; an aborted open rejects with the abort reason', async () => {
    let signalSeen: AbortSignal | undefined;
    const client = {
      async send(cmd: unknown, opts?: { abortSignal?: AbortSignal }) {
        if (!(cmd instanceof GetObjectCommand)) throw new Error('unexpected command');
        signalSeen = opts?.abortSignal;
        return new Promise((_, reject) => {
          opts?.abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })), { once: true });
        });
      },
    } as unknown as S3Client;
    const store = new S3EvidenceStore({ client, bucket: 'ev' });
    const ac = new AbortController();
    const reason = Object.assign(new Error('run exceeded the maximum duration'), { code: 'MAX_RUN_EXCEEDED' });
    const opening = store.open('evidence/x', { signal: ac.signal });
    setTimeout(() => ac.abort(reason), 20);
    await expect(opening).rejects.toBe(reason);
    expect(signalSeen).toBe(ac.signal);
  });
});
