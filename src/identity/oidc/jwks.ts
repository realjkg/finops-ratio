// JWKS cache (checklist 1.2). Trust boundary: the key set is fetched over the
// network, so it is the one place an outage, a hostile response or a flood of
// bad tokens can hurt. The network call is injected (`fetchJwks`), as is the
// clock, so every test is offline and deterministic.
//
// Behavior:
//   - bounded: a document over `maxBytes` or listing over `maxKeys` entries is
//     refused before it is trusted; a document with a duplicate kid, no usable
//     key, or bad JSON is refused whole;
//   - TTL: a set is fresh for `ttlSeconds`; after that the next lookup refreshes;
//   - unknown kid: one forced refresh, at most one network attempt per
//     `refreshCooldownSeconds` no matter how many tokens or kids arrive, so a
//     flood of random kids cannot become a flood of fetches;
//   - single flight: concurrent misses join one in-flight fetch;
//   - stale-if-error: when a refresh fails (or is held back by the cooldown
//     after a failure) the previous set keeps serving known kids until
//     ttl + staleIfErrorSeconds, a hard ceiling, after which every lookup
//     fails closed with jwks_unavailable;
//   - a successful refresh replaces the whole set, so a rotated-out kid stops
//     verifying at the next refresh.
// A backwards clock step makes the set count as expired (never as extra fresh).

import { OidcError } from './errors';
import { importJwk, type VerificationKey } from './jwk';
import { isPlainObject, type OidcAlg } from './shared';
import type { ResolvedJwksOptions } from './config';

export interface FetchJwksOptions {
  /** The cache refuses any response longer than this; a fetcher should stop reading at it. */
  maxBytes: number;
  /** Aborts when the fetch deadline passes; a fetcher should honor it. */
  signal: AbortSignal;
}

/**
 * Network seam. Returns the raw response body of a GET to `url`. It must
 * apply its own egress rules (https, no private targets, DNS pinning); this
 * module only ever passes the configured URL.
 */
export type FetchJwks = (url: string, opts: FetchJwksOptions) => Promise<string | Uint8Array>;

export interface JwksCacheDeps {
  fetchJwks: FetchJwks;
  /** Epoch seconds. Defaults to the wall clock. */
  clock?: () => number;
  /** Deadline signal factory. Defaults to AbortSignal.timeout. */
  createSignal?: (timeoutMs: number) => AbortSignal;
}

type Outcome = 'ok' | 'failed' | 'skipped';

const wallClock = (): number => Math.floor(Date.now() / 1000);

function decodeBody(body: unknown, maxBytes: number): string | null {
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8') <= maxBytes ? body : null;
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) return null;
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      return null;
    }
  }
  return null;
}

/** Parse a key-set document into usable keys; null when the document as a whole must be refused. */
export function parseJwks(body: unknown, opts: Pick<ResolvedJwksOptions, 'maxBytes' | 'maxKeys'>, allowed: ReadonlySet<OidcAlg>): Map<string, VerificationKey> | null {
  const text = decodeBody(body, opts.maxBytes);
  if (text === null) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(doc) || !Object.hasOwn(doc, 'keys')) return null;
  const entries = doc.keys;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > opts.maxKeys) return null;

  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isPlainObject(entry)) return null;
    if (typeof entry.kid === 'string') {
      if (seen.has(entry.kid)) return null; // an ambiguous kid: refuse the whole document
      seen.add(entry.kid);
    }
  }
  const keys = new Map<string, VerificationKey>();
  for (const entry of entries) {
    const vk = importJwk(entry, allowed);
    if (vk) keys.set(vk.kid, vk);
  }
  return keys.size > 0 ? keys : null;
}

export class JwksCache {
  private keys: Map<string, VerificationKey> | null = null;
  private fetchedAt = 0;
  private lastAttemptAt: number | null = null;
  private inflight: Promise<Outcome> | null = null;
  private readonly clock: () => number;
  private readonly createSignal: (timeoutMs: number) => AbortSignal;

  constructor(
    private readonly jwksUri: string,
    private readonly allowed: ReadonlySet<OidcAlg>,
    private readonly opts: ResolvedJwksOptions,
    private readonly deps: JwksCacheDeps,
  ) {
    if (typeof deps !== 'object' || deps === null || typeof deps.fetchJwks !== 'function') throw new OidcError('invalid_config');
    if (deps.clock !== undefined && typeof deps.clock !== 'function') throw new OidcError('invalid_config');
    if (deps.createSignal !== undefined && typeof deps.createSignal !== 'function') throw new OidcError('invalid_config');
    this.clock = deps.clock ?? wallClock;
    this.createSignal = deps.createSignal ?? ((ms) => AbortSignal.timeout(ms));
  }

  /** Age in seconds of the current set, or Infinity when there is none or the clock moved backwards. */
  private age(now: number): number {
    if (this.keys === null) return Infinity;
    const a = now - this.fetchedAt;
    return a < 0 ? Infinity : a;
  }

  private isFresh(now: number): boolean {
    return this.age(now) < this.opts.ttlSeconds;
  }

  /** Whether the set may still serve when a refresh could not be completed. */
  private withinCeiling(now: number): boolean {
    return this.age(now) <= this.opts.ttlSeconds + this.opts.staleIfErrorSeconds;
  }

  /**
   * The verification key for a kid. Throws OidcError('unknown_kid') when the
   * (possibly just refreshed) set lacks it, or OidcError('jwks_unavailable')
   * when no usable set exists or a needed refresh failed.
   */
  async getKey(kid: string): Promise<VerificationKey> {
    let now = this.clock();
    let outcome: Outcome = 'skipped';
    if (!this.isFresh(now)) outcome = await this.refresh();

    now = this.clock();
    if (this.keys === null || !this.withinCeiling(now)) throw new OidcError('jwks_unavailable');
    const hit = this.keys.get(kid);
    if (hit) return hit;

    // Unknown kid: one forced refresh, held back by the cooldown.
    if (outcome === 'skipped') outcome = await this.refresh();
    now = this.clock();
    if (this.keys === null || !this.withinCeiling(now)) throw new OidcError('jwks_unavailable');
    const after = this.keys.get(kid);
    if (after) return after;
    throw new OidcError(outcome === 'failed' ? 'jwks_unavailable' : 'unknown_kid');
  }

  /** Join the in-flight fetch, or start one if the cooldown allows. Never rejects. */
  private refresh(): Promise<Outcome> {
    if (this.inflight) return this.inflight;
    const now = this.clock();
    if (this.lastAttemptAt !== null) {
      const since = now - this.lastAttemptAt;
      if (since >= 0 && since < this.opts.refreshCooldownSeconds) return Promise.resolve('skipped');
    }
    this.lastAttemptAt = now;
    const p: Promise<Outcome> = this.fetchOnce().finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async fetchOnce(): Promise<Outcome> {
    let cleanup = (): void => undefined;
    try {
      const signal = this.createSignal(this.opts.fetchTimeoutMs);
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        const onAbort = (): void => reject(new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        cleanup = () => signal.removeEventListener('abort', onAbort);
      });
      aborted.catch(() => undefined); // never an unhandled rejection, whichever side wins
      const body = await Promise.race([this.deps.fetchJwks(this.jwksUri, { maxBytes: this.opts.maxBytes, signal }), aborted]);
      const parsed = parseJwks(body, this.opts, this.allowed);
      if (parsed === null) return 'failed';
      const at = this.clock();
      this.keys = parsed;
      this.fetchedAt = at;
      return 'ok';
    } catch {
      return 'failed';
    } finally {
      cleanup();
    }
  }
}
