// S3EvidenceStore against a fake S3 client (no network): opening an evidence
// object honours the run's abort signal (Copilot M5, third review).
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
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

describe('S3EvidenceStore uploads are abort-aware', () => {
  /** HeadObject answers 404 (not stored yet) unless `headHangs`; PutObject never answers; both honour the abort signal. */
  function client(seen: Array<{ cmd: string; signal?: AbortSignal }>, headHangs: boolean): S3Client {
    return {
      async send(cmd: unknown, opts?: { abortSignal?: AbortSignal }) {
        const name = cmd instanceof HeadObjectCommand ? 'head' : cmd instanceof PutObjectCommand ? 'put' : 'other';
        seen.push({ cmd: name, signal: opts?.abortSignal });
        if (name === 'head' && !headHangs) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        return new Promise((_, reject) => {
          opts?.abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })), { once: true });
        });
      },
    } as unknown as S3Client;
  }
  const reason = Object.assign(new Error('run exceeded the maximum duration'), { code: 'MAX_RUN_EXCEEDED' });

  for (const [what, headHangs] of [
    ['put (HeadObject answers, PutObject hangs)', false],
    ['put (HeadObject hangs)', true],
  ] as const) {
    it(`${what}: every request carries the signal; an abort rejects with its reason`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-ev-'));
      try {
        const file = path.join(dir, 'f');
        fs.writeFileSync(file, 'abc');
        const seen: Array<{ cmd: string; signal?: AbortSignal }> = [];
        const store = new S3EvidenceStore({ client: client(seen, headHangs), bucket: 'ev' });
        const ac = new AbortController();
        const p = store.put('evidence/k', file, { sha256: 'x', byteSize: 3 }, { signal: ac.signal });
        setTimeout(() => ac.abort(reason), 20);
        await expect(p).rejects.toBe(reason);
        expect(seen.length).toBeGreaterThan(0);
        for (const s of seen) expect(s.signal, s.cmd).toBe(ac.signal);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('putBytes: HeadObject and PutObject carry the signal; an abort rejects with its reason', async () => {
    const seen: Array<{ cmd: string; signal?: AbortSignal }> = [];
    const store = new S3EvidenceStore({ client: client(seen, false), bucket: 'ev' });
    const ac = new AbortController();
    const p = store.putBytes('evidence/k', Buffer.from('abc'), { signal: ac.signal });
    setTimeout(() => ac.abort(reason), 20);
    await expect(p).rejects.toBe(reason);
    expect(seen.map((s) => s.cmd)).toEqual(['head', 'put']);
    for (const s of seen) expect(s.signal, s.cmd).toBe(ac.signal);
  });
});

