// Deterministic in-memory FOCUS source for TESTS ONLY. The CLI refuses it
// unless RATIO_ALLOW_FAKE_SOURCE=1 AND NODE_ENV=test. Never present its data
// as a real-source result.
import crypto from 'crypto';
import { Readable } from 'stream';
import { IngestError } from '../../errors';
import { testSwitchesPermitted } from '../../config';
import type { ArtifactRef, ArtifactSetControl, FocusSource, PeriodListing, PeriodRange } from '../types';
import { listingFingerprint, periodInRange } from '../s3/layout';

export interface FakePeriod {
  billingPeriod: string;
  artifacts?: Array<{ name: string; bytes: Buffer }>;
  control?: ArtifactSetControl;
  /** Simulates a period whose listing/manifest is invalid. */
  error?: { code: string; message: string };
}

export interface FakeOptions {
  /** Return an error to fail this open call (`call` is 1-based per artifact name). */
  openFailure?: (name: string, call: number) => Error | undefined;
}

export function assertFakeSourceAllowed(env: Record<string, string | undefined>): void {
  if (!(testSwitchesPermitted(env) && env.RATIO_ALLOW_FAKE_SOURCE === '1')) {
    throw new IngestError('FAKE_SOURCE_NOT_ALLOWED', 'the fake source is test-only (needs NODE_ENV=test, RATIO_ALLOW_FAKE_SOURCE=1, and RATIO_ENV not staging/production)');
  }
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

export class FakeFocusSource implements FocusSource {
  readonly kind = 'fake' as const;
  /** Names of every openArtifact call, in order (including failed ones). */
  readonly opened: string[] = [];
  private periods: FakePeriod[];
  private readonly calls = new Map<string, number>();

  constructor(
    periods: FakePeriod[],
    private readonly opts: FakeOptions = {},
  ) {
    this.periods = periods;
  }

  setPeriods(periods: FakePeriod[]): void {
    this.periods = periods;
  }

  async listPeriods(range?: PeriodRange): Promise<PeriodListing[]> {
    return [...this.periods]
      .filter((p) => periodInRange(p.billingPeriod, range))
      .sort((a, b) => (a.billingPeriod < b.billingPeriod ? -1 : 1))
      .map((p): PeriodListing => {
        if (p.error) return { ok: false, billingPeriod: p.billingPeriod, code: p.error.code, message: p.error.message };
        const artifacts: ArtifactRef[] = (p.artifacts ?? []).map((a) => ({ name: a.name, key: a.name, byteSize: a.bytes.length, version: sha(a.bytes) }));
        const controlBytes = Buffer.from(JSON.stringify(p.control ?? null));
        return {
          ok: true,
          set: {
            billingPeriod: p.billingPeriod,
            artifacts,
            ...(p.control ? { control: p.control } : {}),
            listingFingerprint: listingFingerprint(controlBytes, artifacts),
          },
        };
      });
  }

  async openArtifact(ref: ArtifactRef): Promise<Readable> {
    this.opened.push(ref.name);
    const call = (this.calls.get(ref.name) ?? 0) + 1;
    this.calls.set(ref.name, call);
    const failure = this.opts.openFailure?.(ref.name, call);
    if (failure) throw failure;
    for (const p of this.periods) {
      const a = p.artifacts?.find((x) => x.name === ref.name);
      if (a) return Readable.from(chunks(a.bytes));
    }
    throw new IngestError('SOURCE_READ_FAILED', `fake artifact ${ref.name} not found`);
  }
}

function* chunks(b: Buffer, size = 64 * 1024): Generator<Buffer> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}
