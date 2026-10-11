// In-memory jti denylist (checklist 1.4): a reference implementation of the
// `isRevoked(jti)` hook the verifier takes. Single process only: a revocation
// recorded here is invisible to other instances, so a multi-instance
// deployment must back the hook with a shared store instead.
//
// Bounded: at most `maxEntries` revocations are held. Each entry carries the
// time until which it matters (the token's expiry plus skew) and is dropped
// once that has passed. When the list is full of live entries, `revoke`
// throws OidcError('capacity') rather than evict a live revocation, because
// evicting one would silently un-revoke a token.

import { OidcError } from './errors';
import { JTI_RE, isEpochSeconds } from './shared';

export const MAX_DENYLIST_ENTRIES = 100_000;

export interface JtiDenylist {
  /** Record a revocation that stays relevant until `retainUntil` (epoch seconds). Throws OidcError. */
  revoke(jti: string, retainUntil: number): void;
  /** The shape the verifier's `isRevoked` hook expects. */
  isRevoked(jti: string): Promise<boolean>;
  readonly size: number;
}

export interface JtiDenylistOptions {
  maxEntries: number;
  /** Epoch seconds. Defaults to the wall clock. */
  clock?: () => number;
}

export function createMemoryJtiDenylist(options: JtiDenylistOptions): JtiDenylist {
  const max = options?.maxEntries;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1 || max > MAX_DENYLIST_ENTRIES) throw new OidcError('invalid_config');
  if (options.clock !== undefined && typeof options.clock !== 'function') throw new OidcError('invalid_config');
  const clock = options.clock ?? ((): number => Math.floor(Date.now() / 1000));
  const entries = new Map<string, number>();

  const purge = (now: number): void => {
    for (const [jti, until] of entries) if (until <= now) entries.delete(jti);
  };

  return {
    revoke(jti: string, retainUntil: number): void {
      if (typeof jti !== 'string' || !JTI_RE.test(jti) || !isEpochSeconds(retainUntil)) throw new OidcError('invalid_input');
      const existing = entries.get(jti);
      if (existing === undefined && entries.size >= max) {
        purge(clock());
        if (entries.size >= max) throw new OidcError('capacity');
      }
      entries.set(jti, existing === undefined ? retainUntil : Math.max(existing, retainUntil));
    },
    async isRevoked(jti: string): Promise<boolean> {
      const until = entries.get(jti);
      return until !== undefined && until > clock();
    },
    get size(): number {
      return entries.size;
    },
  };
}
