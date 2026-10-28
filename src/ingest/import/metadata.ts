// R3 part 3: the per-source implementation-metadata record (the owner's
// template), accepted as `--metadata <file.json>` by `source add` and
// `import-file`. A small hand-written guard: exactly these fields, unknown keys
// rejected by KEY name, values never echoed. 'unknown' and 'not_available' are
// explicit values where listed; a blank is never defaulted into a fact. The
// record travels verbatim with the batch (staged manifest, captured as evidence).
// R1 defines the same block in the engagement config; this guard mirrors it
// until a later row connects the two.
import crypto from 'crypto';
import { IngestError } from '../errors';
import { KNOWN_FILE_DROP_PROVIDERS } from '../focus/provider';

type Spec =
  | { t: 'enum'; values: readonly string[] }
  | { t: 'text'; max: number }
  | { t: 'date' }
  | { t: 'tz' }
  | { t: 'key' | 'keyOrNull' }
  | { t: 'list'; of: Spec; orUnknown?: boolean }
  | { t: 'money'; or: readonly string[] }
  | { t: 'obj'; fields: Record<string, Spec> };

const text = (max: number): Spec => ({ t: 'text', max });
const oneOf = (...values: string[]): Spec => ({ t: 'enum', values });
const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const PLAIN_DECIMAL_RE = /^-?[0-9]{1,30}(?:\.[0-9]{1,30})?$/;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const SCHEMA: Spec = {
  t: 'obj',
  fields: {
    provider: { t: 'enum', values: KNOWN_FILE_DROP_PROVIDERS },
    source_kind: oneOf('focus-export', 'native-export', 'api'),
    schema_version: text(20),
    provenance: oneOf('authorized-real-export', 'official-example'),
    sanitization: text(500),
    cost_basis: oneOf('billed', 'effective', 'actual', 'amortized', 'focus-native', 'unknown'),
    dataset: text(200),
    scope: {
      t: 'obj',
      fields: {
        accounts: { t: 'list', of: text(200), orUnknown: true },
        period_start: { t: 'date' },
        period_end: { t: 'date' },
        period_end_semantics: oneOf('inclusive', 'exclusive'),
        timezone: { t: 'tz' },
        completeness: oneOf('full-period', 'explicit-subset'),
      },
    },
    delivery: { t: 'obj', fields: { format: text(40), compression: text(40), manifest: text(200), refresh_behavior: text(500) } },
    financial: {
      t: 'obj',
      fields: {
        currencies: { t: 'list', of: { t: 'enum', values: [] } },
        billed_cost_total: { t: 'money', or: ['unknown'] },
        effective_cost_total: { t: 'money', or: ['not_available', 'unknown'] },
        credits_coverage: text(500),
        tax_coverage: oneOf('included', 'excluded', 'unknown'),
        control_total_source: oneOf('export-query', 'console', 'invoice'),
        known_differences: text(2000),
      },
    },
    overlap: { t: 'obj', fields: { also_present_in_other_source: oneOf('yes', 'no', 'unknown'), related_source: { t: 'keyOrNull' } } },
  },
};

export interface ImportMetadata {
  provider: string;
  scope: { period_start: string; period_end: string; period_end_semantics: 'inclusive' | 'exclusive'; timezone: string; completeness: string } & Record<string, unknown>;
  financial: { billed_cost_total: Record<string, string> | 'unknown'; control_total_source: string } & Record<string, unknown>;
  overlap: { also_present_in_other_source: 'yes' | 'no' | 'unknown'; related_source: string | null };
  [k: string]: unknown;
}

const bad = (at: string, why: string): never => {
  throw new IngestError('METADATA_INVALID', `metadata ${at}: ${why}`);
};

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz.length <= 64;
  } catch {
    return false;
  }
}

function check(v: unknown, s: Spec, at: string): void {
  switch (s.t) {
    case 'obj': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return bad(at || 'record', 'must be an object');
      for (const k of Object.keys(v)) if (!Object.prototype.hasOwnProperty.call(s.fields, k)) bad(at ? `${at}.${k}` : k, 'is not a known field');
      for (const [k, spec] of Object.entries(s.fields)) {
        const p = at ? `${at}.${k}` : k;
        if (!Object.prototype.hasOwnProperty.call(v, k)) bad(p, 'is required');
        check((v as Record<string, unknown>)[k], spec, p);
      }
      return;
    }
    case 'enum':
      if (typeof v !== 'string' || !(s.values.length ? s.values.includes(v) : CURRENCY_RE.test(v))) bad(at, s.values.length ? `must be one of ${s.values.join(', ')}` : 'must be an ISO 4217 code');
      return;
    case 'text':
      if (typeof v !== 'string' || v.trim() === '' || v.length > s.max) bad(at, `must be non-blank text of at most ${s.max} characters`);
      return;
    case 'date': {
      const m = typeof v === 'string' ? DATE_RE.exec(v) : null;
      if (!m || new Date(`${v}T00:00:00Z`).getUTCDate() !== Number(m[3])) bad(at, 'must be a calendar date YYYY-MM-DD');
      return;
    }
    case 'tz':
      if (typeof v !== 'string' || !validTz(v)) bad(at, 'must be an IANA time zone (e.g. UTC)');
      return;
    case 'key':
    case 'keyOrNull':
      if (!(v === null && s.t === 'keyOrNull') && (typeof v !== 'string' || !KEY_RE.test(v))) bad(at, 'must be a source key or null');
      return;
    case 'list':
      if (s.orUnknown && v === 'unknown') return;
      if (!Array.isArray(v) || v.length === 0 || new Set(v).size !== v.length) return bad(at, `must be a non-empty list without duplicates${s.orUnknown ? " or 'unknown'" : ''}`);
      v.forEach((x, i) => check(x, s.of, `${at}[${i}]`));
      return;
    case 'money':
      if (typeof v === 'string' && s.or.includes(v)) return;
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length === 0) return bad(at, `must map currency codes to decimals, or be ${s.or.join(' / ')}`);
      for (const [c, d] of Object.entries(v)) if (!CURRENCY_RE.test(c) || typeof d !== 'string' || !PLAIN_DECIMAL_RE.test(d)) bad(at, 'must map ISO 4217 codes to plain decimal strings');
  }
}

/** Validates a metadata file's bytes; returns the record verbatim plus the sha256 of the bytes. */
export function parseImportMetadata(bytes: Buffer): { metadata: ImportMetadata; sha256: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch {
    bad('file', 'is not valid JSON');
  }
  const metadata = checkImportMetadata(doc);
  return { metadata, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export function checkImportMetadata(doc: unknown): ImportMetadata {
  check(doc, SCHEMA, '');
  const m = doc as ImportMetadata;
  if (m.overlap.also_present_in_other_source === 'yes' && m.overlap.related_source === null) bad('overlap.related_source', "is required when also_present_in_other_source is 'yes'");
  const w = scopeWindow(m.scope);
  if (w.endMs <= w.startMs) bad('scope.period_end', 'must be after scope.period_start');
  return m;
}

/** UTC instant of local midnight of `date` in `tz`. */
function zonedMidnight(date: string, tz: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const offsetAt = (ms: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - ms;
  };
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

/** The declared scope as a half-open UTC window [startMs, endMs). */
export function scopeWindow(scope: ImportMetadata['scope']): { startMs: number; endMs: number } {
  const endDate = scope.period_end_semantics === 'inclusive' ? new Date(Date.parse(`${scope.period_end}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : scope.period_end;
  return { startMs: zonedMidnight(scope.period_start, scope.timezone), endMs: zonedMidnight(endDate, scope.timezone) };
}

/** Exact equality of two plain decimal strings ('18.0066386184' equals '18.00663861840'). */
export function sameDecimal(a: string, b: string): boolean {
  const norm = (x: string) => {
    if (!PLAIN_DECIMAL_RE.test(x)) return null;
    const [i, f = ''] = x.replace(/^-/, '').split('.');
    const digits = `${i}${f}`.replace(/^0+/, '');
    const v = BigInt(digits === '' ? '0' : digits) * BigInt(10) ** BigInt(30 - f.length);
    return x.startsWith('-') ? -v : v;
  };
  const x = norm(a);
  return x !== null && x === norm(b);
}
