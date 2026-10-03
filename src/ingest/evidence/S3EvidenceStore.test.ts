// S3EvidenceStore against a fake S3 client (no network): opening an evidence
// object honours the run's abort signal (Copilot M5, third review).
import crypto from 'crypto';
import { Readable } from 'stream';
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

describe('S3EvidenceStore: an existing object is verified by its sha256, not its size (PR #54 fourth review M1)', () => {
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  /** An evidence bucket that already holds `stored` under every key. */
  function seeded(stored: Buffer, puts: string[]): S3Client {
    return {
      async send(cmd: unknown) {
        if (cmd instanceof HeadObjectCommand) return { ContentLength: stored.length };
        if (cmd instanceof GetObjectCommand) return { Body: Readable.from([stored]), ContentLength: stored.length };
        if (cmd instanceof PutObjectCommand) {
          puts.push(String(cmd.input.Key));
          return {};
        }
        throw new Error('unexpected command');
      },
    } as unknown as S3Client;
  }
  const good = Buffer.from('the real evidence bytes');
  const forged = Buffer.from('the FAKE evidence bytes'); // same length, different bytes
  expect(forged.length).toBe(good.length);

  it('put: same size, same bytes => exists; same size, different bytes => EVIDENCE_INTEGRITY_MISMATCH, nothing overwritten', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-ev-'));
    try {
      const file = path.join(dir, 'f');
      fs.writeFileSync(file, good);
      const puts: string[] = [];
      expect(await new S3EvidenceStore({ client: seeded(good, puts), bucket: 'ev' }).put('evidence/k', file, { sha256: sha(good), byteSize: good.length })).toBe('exists');
      await expect(new S3EvidenceStore({ client: seeded(forged, puts), bucket: 'ev' }).put('evidence/k', file, { sha256: sha(good), byteSize: good.length })).rejects.toMatchObject({
        code: 'EVIDENCE_INTEGRITY_MISMATCH',
        retryable: false,
      });
      expect(puts).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('putBytes (manifests): the same check', async () => {
    const puts: string[] = [];
    expect(await new S3EvidenceStore({ client: seeded(good, puts), bucket: 'ev' }).putBytes('evidence/k', good)).toBe('exists');
    await expect(new S3EvidenceStore({ client: seeded(forged, puts), bucket: 'ev' }).putBytes('evidence/k', good)).rejects.toMatchObject({ code: 'EVIDENCE_INTEGRITY_MISMATCH' });
    expect(puts).toEqual([]);
  });
});

describe('S3EvidenceStore HEAD-metadata fast path (challenger round 3 L2)', () => {
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  const good = Buffer.from('the real evidence bytes');
  function client(stored: Buffer, meta: Record<string, string> | undefined, calls: string[], puts: Array<Record<string, string> | undefined>): S3Client {
    return {
      async send(cmd: unknown) {
        if (cmd instanceof HeadObjectCommand) {
          calls.push('head');
          if (!stored.length) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
          return { ContentLength: stored.length, ...(meta ? { Metadata: meta } : {}) };
        }
        if (cmd instanceof GetObjectCommand) {
          calls.push('get');
          return { Body: Readable.from([stored]), ContentLength: stored.length };
        }
        if (cmd instanceof PutObjectCommand) {
          calls.push('put');
          puts.push(cmd.input.Metadata);
          return {};
        }
        throw new Error('unexpected command');
      },
    } as unknown as S3Client;
  }
  const withFile = async <T>(fn: (file: string) => Promise<T>): Promise<T> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-ev-'));
    try {
      const file = path.join(dir, 'f');
      fs.writeFileSync(file, good);
      return await fn(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('put stores ratio-sha256 as user metadata; putBytes too', async () => {
    const calls: string[] = [];
    const puts: Array<Record<string, string> | undefined> = [];
    await withFile((file) => new S3EvidenceStore({ client: client(Buffer.alloc(0), undefined, calls, puts), bucket: 'ev' }).put('evidence/k', file, { sha256: sha(good), byteSize: good.length }));
    await new S3EvidenceStore({ client: client(Buffer.alloc(0), undefined, calls, puts), bucket: 'ev' }).putBytes('evidence/k', good);
    expect(puts).toEqual([{ 'ratio-sha256': sha(good) }, { 'ratio-sha256': sha(good) }]);
  });

  it('artifact (put): matching size AND matching ratio-sha256 => exists without reading the object', async () => {
    const calls: string[] = [];
    const r = await withFile((file) => new S3EvidenceStore({ client: client(good, { 'ratio-sha256': sha(good) }, calls, []), bucket: 'ev' }).put('evidence/k', file, { sha256: sha(good), byteSize: good.length }));
    expect(r).toBe('exists');
    expect(calls).toEqual(['head']);
  });

  for (const [what, meta] of [
    ['no metadata', undefined],
    ['a different ratio-sha256', { 'ratio-sha256': '0'.repeat(64) }],
  ] as const) {
    it(`artifact (put) with ${what}: the full re-hash runs`, async () => {
      const calls: string[] = [];
      const r = await withFile((file) => new S3EvidenceStore({ client: client(good, meta, calls, []), bucket: 'ev' }).put('evidence/k', file, { sha256: sha(good), byteSize: good.length }));
      expect(r).toBe('exists');
      expect(calls).toEqual(['head', 'get']);
    });
  }

  it('manifest (putBytes): never the fast path — manifest evidence is not re-read at load, so it is always re-hashed here', async () => {
    const calls: string[] = [];
    const forged = Buffer.from('the FAKE evidence bytes');
    await expect(new S3EvidenceStore({ client: client(forged, { 'ratio-sha256': sha(good) }, calls, []), bucket: 'ev' }).putBytes('evidence/k', good)).rejects.toMatchObject({
      code: 'EVIDENCE_INTEGRITY_MISMATCH',
    });
    expect(calls).toEqual(['head', 'get']);
  });
});

describe('S3EvidenceStore.put never leaves its file stream behind', () => {
  // capture() deletes the temp file right after put() returns: a body stream
  // the SDK never consumed (a PutObject that fails, or a fake that ignores the
  // body) would open the deleted file later and emit an UNHANDLED ENOENT.
  for (const [what, outcome] of [
    ['a PutObject that fails before reading the body', 'reject'],
    ['a PutObject that returns without reading the body', 'resolve'],
  ] as const) {
    it(`${what}: the body stream is destroyed when put() settles`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-ev-'));
      let body: fs.ReadStream | undefined;
      try {
        const file = path.join(dir, 'f');
        fs.writeFileSync(file, 'abc');
        const client = {
          async send(cmd: unknown) {
            if (cmd instanceof HeadObjectCommand) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
            if (cmd instanceof PutObjectCommand) {
              body = cmd.input.Body as fs.ReadStream;
              if (outcome === 'reject') throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
              return {};
            }
            throw new Error('unexpected command');
          },
        } as unknown as S3Client;
        const p = new S3EvidenceStore({ client, bucket: 'ev' }).put('evidence/k', file, { sha256: 'x', byteSize: 3 });
        if (outcome === 'reject') await expect(p).rejects.toMatchObject({ code: 'EVIDENCE_STORE_FAILED' });
        else await p;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true }); // exactly what capture() does next
      }
      expect(body).toBeDefined();
      expect(body!.destroyed).toBe(true);
      await new Promise((r) => setTimeout(r, 50)); // an unhandled ENOENT would surface here and fail the run
    });
  }
});

describe('S3EvidenceStore creates objects conditionally (If-None-Match: *) — sixth review High', () => {
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  const good = Buffer.from('the real evidence bytes');
  /** HEAD says absent; between HEAD and PUT another writer creates the key with `winner`. */
  function racing(winner: Buffer | null, seen: Array<{ cmd: string; ifNoneMatch?: string }>): S3Client {
    let created: Buffer | null = null;
    return {
      async send(cmd: unknown) {
        if (cmd instanceof HeadObjectCommand) {
          seen.push({ cmd: 'head' });
          created = winner; // the competitor writes right after our HEAD
          throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        }
        if (cmd instanceof PutObjectCommand) {
          seen.push({ cmd: 'put', ifNoneMatch: cmd.input.IfNoneMatch });
          if (cmd.input.IfNoneMatch === '*' && created) {
            throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
          }
          return {};
        }
        if (cmd instanceof GetObjectCommand) {
          seen.push({ cmd: 'get' });
          return { Body: Readable.from([created ?? Buffer.alloc(0)]), ContentLength: created?.length ?? 0 };
        }
        throw new Error('unexpected command');
      },
    } as unknown as S3Client;
  }
  const withFile = async <T>(fn: (file: string) => Promise<T>): Promise<T> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-ev-'));
    try {
      const file = path.join(dir, 'f');
      fs.writeFileSync(file, good);
      return await fn(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('no race: every PUT (artifact and manifest) is a conditional create', async () => {
    const seen: Array<{ cmd: string; ifNoneMatch?: string }> = [];
    expect(await withFile((file) => new S3EvidenceStore({ client: racing(null, seen), bucket: 'ev' }).put('evidence/k', file, { sha256: sha(good), byteSize: good.length }))).toBe('stored');
    expect(await new S3EvidenceStore({ client: racing(null, seen), bucket: 'ev' }).putBytes('evidence/k', good)).toBe('stored');
    expect(seen.filter((x) => x.cmd === 'put').map((x) => x.ifNoneMatch)).toEqual(['*', '*']);
  });

  for (const [what, op] of [
    ['artifact (put)', 'put'],
    ['manifest (putBytes)', 'putBytes'],
  ] as const) {
    it(`${what}: a competitor creates the same genuine bytes between HEAD and PUT => 412, verified, 'exists'`, async () => {
      const seen: Array<{ cmd: string; ifNoneMatch?: string }> = [];
      const store = new S3EvidenceStore({ client: racing(good, seen), bucket: 'ev' });
      const r = op === 'put' ? await withFile((file) => store.put('evidence/k', file, { sha256: sha(good), byteSize: good.length })) : await store.putBytes('evidence/k', good);
      expect(r).toBe('exists');
      expect(seen.map((x) => x.cmd)).toEqual(['head', 'put', 'get']);
    });

    it(`${what}: a competitor creates DIFFERENT bytes between HEAD and PUT => EVIDENCE_INTEGRITY_MISMATCH, nothing overwritten`, async () => {
      const seen: Array<{ cmd: string; ifNoneMatch?: string }> = [];
      const store = new S3EvidenceStore({ client: racing(Buffer.from('the FAKE evidence bytes'), seen), bucket: 'ev' });
      const p = op === 'put' ? withFile((file) => store.put('evidence/k', file, { sha256: sha(good), byteSize: good.length })) : store.putBytes('evidence/k', good);
      await expect(p).rejects.toMatchObject({ code: 'EVIDENCE_INTEGRITY_MISMATCH' });
      expect(seen.filter((x) => x.cmd === 'put')).toEqual([{ cmd: 'put', ifNoneMatch: '*' }]);
    });
  }
});

describe('S3EvidenceStore: a 409 ConditionalRequestConflict on the conditional create (challenger round 4 L1)', () => {
  // S3 answers 409 (not 412) when a concurrent conditional write to the same key
  // is in flight. Only the status is set here (no error name), so the status
  // alone must route it to verification.
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  const good = Buffer.from('the real evidence bytes');
  function conflicting(existing: Buffer, seen: string[]): S3Client {
    return {
      async send(cmd: unknown) {
        if (cmd instanceof HeadObjectCommand) {
          seen.push('head');
          throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        }
        if (cmd instanceof PutObjectCommand) {
          seen.push('put');
          throw Object.assign(new Error('conflict'), { $metadata: { httpStatusCode: 409 } });
        }
        if (cmd instanceof GetObjectCommand) {
          seen.push('get');
          return { Body: Readable.from([existing]), ContentLength: existing.length };
        }
        throw new Error('unexpected command');
      },
    } as unknown as S3Client;
  }
  const withFile = async <T>(fn: (file: string) => Promise<T>): Promise<T> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-ev-'));
    try {
      const file = path.join(dir, 'f');
      fs.writeFileSync(file, good);
      return await fn(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  for (const [what, op] of [
    ['artifact (put)', 'put'],
    ['manifest (putBytes)', 'putBytes'],
  ] as const) {
    it(`${what}: 409 with the genuine bytes in place => verified (GET), 'exists'`, async () => {
      const seen: string[] = [];
      const store = new S3EvidenceStore({ client: conflicting(good, seen), bucket: 'ev' });
      const r = op === 'put' ? await withFile((file) => store.put('evidence/k', file, { sha256: sha(good), byteSize: good.length })) : await store.putBytes('evidence/k', good);
      expect(r).toBe('exists');
      expect(seen).toEqual(['head', 'put', 'get']);
    });

    it(`${what}: 409 with different bytes in place => EVIDENCE_INTEGRITY_MISMATCH (never EVIDENCE_STORE_FAILED, never overwritten)`, async () => {
      const seen: string[] = [];
      const store = new S3EvidenceStore({ client: conflicting(Buffer.from('the FAKE evidence bytes'), seen), bucket: 'ev' });
      const p = op === 'put' ? withFile((file) => store.put('evidence/k', file, { sha256: sha(good), byteSize: good.length })) : store.putBytes('evidence/k', good);
      await expect(p).rejects.toMatchObject({ code: 'EVIDENCE_INTEGRITY_MISMATCH' });
      expect(seen).toEqual(['head', 'put', 'get']);
    });
  }
});

