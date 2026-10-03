// In-memory evidence store for deterministic tests (paired with FakeFocusSource).
import fs from 'fs';
import { Readable } from 'stream';
import { IngestError } from '../errors';
import type { EvidenceStore } from './types';

export class MemoryEvidenceStore implements EvidenceStore {
  readonly objects = new Map<string, Buffer>();

  private store(key: string, bytes: Buffer): 'stored' | 'exists' {
    const existing = this.objects.get(key);
    if (existing) {
      if (existing.length !== bytes.length) throw new IngestError('EVIDENCE_CONFLICT', 'an evidence object with this key but a different size exists');
      return 'exists';
    }
    this.objects.set(key, Buffer.from(bytes));
    return 'stored';
  }

  async put(key: string, filePath: string, info: { sha256: string; byteSize: number }): Promise<'stored' | 'exists'> {
    const bytes = await fs.promises.readFile(filePath);
    if (bytes.length !== info.byteSize) throw new IngestError('EVIDENCE_CONFLICT', 'local file size changed during capture');
    return this.store(key, bytes);
  }

  async putBytes(key: string, bytes: Buffer): Promise<'stored' | 'exists'> {
    return this.store(key, bytes);
  }

  async open(key: string, opts: { signal?: AbortSignal } = {}): Promise<Readable> {
    if (opts.signal?.aborted) throw opts.signal.reason;
    const b = this.objects.get(key);
    if (!b) throw new IngestError('EVIDENCE_MISSING', 'evidence object not found');
    const size = 64 * 1024;
    return Readable.from(
      (function* () {
        for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
      })(),
    );
  }
}
