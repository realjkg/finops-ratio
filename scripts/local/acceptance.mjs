// Pure helpers for the Slice 2b acceptance run on the public FOCUS 1.0 Sample
// Data (`npm run local:acceptance`, scripts/local/local.mjs). There is no
// Docker, database or network here; the one fetch takes an injected `fetchFn`.
// Everything is unit-tested in scripts/local/acceptance.test.mjs.
// Design: docs/evidence/slice-2b/DESIGN.md.
//
// - The STAGING CONVERTER (stageFocusSample) turns the upstream sample CSV
//   into what the worker's one real source type delivers: an AWS Data
//   Exports FOCUS 1.0 layout. It makes three changes: the unquoted NULL
//   token becomes an empty field, the rows are split by billing period, and
//   each file is gzipped. It is proven lossless (verifyStagingLossless)
//   before anything is uploaded.
// - The COMPARISONS (compareAcceptance, syncProblems, ...) judge what the
//   real worker and the real API produced against the control totals that
//   scripts/acceptance/focus_control_totals.py computed independently from
//   the upstream file.
// - MUTATIONS change only the staged objects, never the expected side; each
//   one must make the run fail (DESIGN §6).
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { LOCAL_NAMES, localSettings, localTestSettings, withDeadline } from './lib.mjs';

const { TextDecoder, structuredClone } = globalThis;

/** Fixed, non-secret names of the sample source. They say "sample" everywhere. */
export const SAMPLE_NAMES = Object.freeze({
  bucket: LOCAL_NAMES.sourceBucket,
  prefix: 'focus-sample',
  exportName: 'focus-1-0-sample',
  sourceKey: 'focus-sample',
  tenantSlug: 'local-focus-sample',
  displayName: 'FOCUS 1.0 Sample Data (FinOps Foundation, CC BY 4.0) - public sample, not tenant billing data',
});

export const MUTATIONS = Object.freeze([
  'corrupt-billed',
  'corrupt-effective',
  'drop-row',
  'double-ingest',
  'shift-period',
  'swap-billed',
  'skip-null-conversion',
  'skip-period-split',
]);

export const DATASET_KEYS = Object.freeze(['1k', '10k']);

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// --- settings and arguments ------------------------------------------------------

const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Same rule as lib.mjs's (private) port(): 1024..65535, digits only. */
function port(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]{3,4}$/.test(raw)) throw new Error(`${name} must be a port number 1024..65535`);
  const n = Number(raw);
  if (n < 1024 || n > 65535) throw new Error(`${name} must be a port number 1024..65535`);
  return n;
}

/**
 * local:acceptance's OWN project and ports (RATIO_LOCAL_ACCEPTANCE_*). Like
 * local:test it ends with `down -v`, so it refuses any project name or port
 * of the developer stack or of local:test.
 */
export function localAcceptanceSettings(env) {
  const project = env.RATIO_LOCAL_ACCEPTANCE_PROJECT ?? 'ratio-local-acceptance';
  if (!PROJECT_RE.test(project)) throw new Error('RATIO_LOCAL_ACCEPTANCE_PROJECT must be lower-case letters, digits, - or _');
  const acc = {
    project,
    pgPort: port(env, 'RATIO_LOCAL_ACCEPTANCE_PG_PORT', 54349),
    s3Port: port(env, 'RATIO_LOCAL_ACCEPTANCE_S3_PORT', 18363),
    appPort: port(env, 'RATIO_LOCAL_ACCEPTANCE_APP_PORT', 3120),
  };
  const own = [acc.pgPort, acc.s3Port, acc.appPort];
  if (new Set(own).size !== own.length) throw new Error(`local:acceptance ports must be distinct: ${own.join(', ')}`);
  for (const [label, other] of [
    ['developer stack', localSettings(env)],
    ['local:test stack', localTestSettings(env)],
  ]) {
    if (acc.project === other.project) throw new Error(`local:acceptance refuses the ${label}'s project name (${other.project})`);
    for (const p of own) {
      if ([other.pgPort, other.s3Port, other.appPort].includes(p)) throw new Error(`local:acceptance refuses port ${p}: the ${label} uses it`);
    }
  }
  return acc;
}

/** `[--dataset 1k|10k] [--mutation <kind>]`, each at most once; anything else is refused. */
export function parseAcceptanceArgs(argv) {
  const out = { dataset: '1k', mutation: null };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag !== '--dataset' && flag !== '--mutation') throw new Error(`unknown argument ${JSON.stringify(flag)} (usage: [--dataset 1k|10k] [--mutation <kind>])`);
    if (seen.has(flag)) throw new Error(`${flag} given twice`);
    seen.add(flag);
    const value = argv[i + 1];
    i += 1;
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--dataset') {
      if (!DATASET_KEYS.includes(value)) throw new Error(`--dataset must be one of ${DATASET_KEYS.join(', ')}`);
      out.dataset = value;
    } else {
      if (!MUTATIONS.includes(value)) throw new Error(`--mutation must be one of ${MUTATIONS.join(', ')}`);
      out.mutation = value;
    }
  }
  return out;
}

// --- strict CSV tokenizer -----------------------------------------------------------

/**
 * RFC 4180 with LF record ends. Returns records of fields { raw, value, quoted }:
 * `raw` is the field's exact text (quotes included), so joining a record's raw
 * fields with ',' reproduces it byte for byte. Fails closed on CR, an
 * unterminated quote, bytes after a closing quote, a stray quote, empty input
 * and invalid UTF-8. A BOM is kept (and then fails the header checks).
 */
export function tokenizeCsv(buf) {
  if (!buf || buf.length === 0) throw new Error('CSV: empty input');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new Error('CSV: input is not valid UTF-8');
  }
  const records = [];
  let rec = [];
  let fieldStart = 0;
  let quoted = false;
  let inQuotes = false;
  let afterQuote = false;
  const endField = (end) => {
    const raw = text.slice(fieldStart, end);
    rec.push({ raw, value: quoted ? raw.slice(1, -1).replaceAll('""', '"') : raw, quoted });
    quoted = false;
    afterQuote = false;
  };
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') i += 1;
        else {
          inQuotes = false;
          afterQuote = true;
        }
      }
      continue;
    }
    if (c === ',') {
      endField(i);
      fieldStart = i + 1;
    } else if (c === '\n') {
      endField(i);
      records.push(rec);
      rec = [];
      fieldStart = i + 1;
    } else if (c === '\r') {
      throw new Error(`CSV: carriage return in record ${records.length + 1}`);
    } else if (afterQuote) {
      throw new Error(`CSV: characters after a closing quote in record ${records.length + 1}`);
    } else if (c === '"') {
      if (i !== fieldStart) throw new Error(`CSV: stray quote inside an unquoted field in record ${records.length + 1}`);
      inQuotes = true;
      quoted = true;
    }
  }
  if (inQuotes) throw new Error('CSV: unterminated quoted field at the end of the input');
  if (fieldStart < n || rec.length) {
    endField(n);
    records.push(rec);
  }
  return records;
}

const splitRecord = (line) => tokenizeCsv(Buffer.from(`${line}\n`, 'utf8'))[0];
const joinRecord = (fields) => fields.map((f) => f.raw).join(',');
const isNullToken = (f) => !f.quoted && f.value === 'NULL';

// --- staging converter -----------------------------------------------------------------

const PERIOD_RE = /^([0-9]{4})-(0[1-9]|1[0-2])-01(?:[ T]00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?)?$/;
const DEFAULT_GZIP_LEVEL = 6;

function periodOf(field, recordNo) {
  const m = isNullToken(field) ? null : PERIOD_RE.exec(field.value);
  if (!m) throw new Error(`record ${recordNo}: BillingPeriodStart is not the first of a month at midnight`);
  return `${m[1]}-${m[2]}`;
}

function readHeader(records) {
  const header = records[0];
  const columns = header.map((f) => f.value);
  if (new Set(columns).size !== columns.length) throw new Error('CSV: duplicate column name in the header');
  if (!columns.includes('BillingPeriodStart')) throw new Error('CSV: required column BillingPeriodStart is missing');
  if (records.length < 2) throw new Error('CSV: no data rows');
  for (const [i, rec] of records.entries()) {
    if (rec.length !== header.length) throw new Error(`CSV: record ${i + 1} has ${rec.length} fields, the header has ${header.length}`);
  }
  return { header, columns, iStart: columns.indexOf('BillingPeriodStart') };
}

const recordCount = (p) => p.files.reduce((n, f) => n + f.records.length, 0);

/**
 * The staging plan (text level, before gzip). With the defaults: one period per
 * distinct BillingPeriodStart month (ascending), records in upstream order,
 * every UNQUOTED `NULL` field emptied and every other field's raw bytes kept.
 */
export function planStaging(bytes, { nullToEmpty = true, splitByPeriod = true } = {}) {
  const records = tokenizeCsv(bytes);
  const { header, columns, iStart } = readHeader(records);
  const nullTokens = {};
  const byPeriod = new Map();
  for (let r = 1; r < records.length; r += 1) {
    const rec = records[r];
    const ym = periodOf(rec[iStart], r + 1);
    const line = rec
      .map((f, i) => {
        if (nullToEmpty && isNullToken(f)) {
          nullTokens[columns[i]] = (nullTokens[columns[i]] ?? 0) + 1;
          return '';
        }
        return f.raw;
      })
      .join(',');
    if (!byPeriod.has(ym)) byPeriod.set(ym, []);
    byPeriod.get(ym).push({ line, order: r });
  }
  const yms = [...byPeriod.keys()].sort();
  const periods = splitByPeriod
    ? yms.map((ym) => ({ ym, files: [{ records: byPeriod.get(ym).map((x) => x.line), level: DEFAULT_GZIP_LEVEL }] }))
    : [
        {
          ym: yms[0],
          files: [
            {
              records: [...byPeriod.values()]
                .flat()
                .sort((a, b) => a.order - b.order)
                .map((x) => x.line),
              level: DEFAULT_GZIP_LEVEL,
            },
          ],
        },
      ];
  return { header: joinRecord(header), columns, periods, nullTokens, nullToEmpty, splitByPeriod };
}

/**
 * Proves a plan is the upstream file, losslessly: the header is identical
 * and, period by period, the staged records with the null mapping inverted
 * (empty unquoted ⇒ NULL) are exactly upstream's records of that period, in
 * upstream order. The sample has no unquoted empty field, so the inversion
 * is exact. A file that had one would fail here: fail closed. Returns the
 * list of problems.
 */
export function verifyStagingLossless(bytes, plan) {
  const problems = [];
  const records = tokenizeCsv(bytes);
  const { header, iStart } = readHeader(records);
  if (plan.header !== joinRecord(header)) problems.push('the staged header differs from the upstream header');
  const expected = new Map();
  for (let r = 1; r < records.length; r += 1) {
    const ym = plan.splitByPeriod ? periodOf(records[r][iStart], r + 1) : plan.periods[0]?.ym;
    if (!expected.has(ym)) expected.set(ym, []);
    expected.get(ym).push(joinRecord(records[r]));
  }
  const invert = (line) =>
    plan.nullToEmpty
      ? splitRecord(line)
          .map((f) => (!f.quoted && f.value === '' ? 'NULL' : f.raw))
          .join(',')
      : line;
  const seen = new Set();
  for (const p of plan.periods) {
    if (seen.has(p.ym)) problems.push(`period ${p.ym} is staged twice`);
    seen.add(p.ym);
    const got = p.files.flatMap((f) => f.records).map(invert);
    const want = expected.get(p.ym) ?? [];
    if (got.length !== want.length) problems.push(`period ${p.ym}: ${got.length} staged records, upstream has ${want.length}`);
    const first = got.findIndex((l, i) => l !== want[i]);
    if (first >= 0) problems.push(`period ${p.ym}: staged record ${first + 1} differs from upstream`);
  }
  for (const ym of expected.keys()) if (!seen.has(ym)) problems.push(`period ${ym} is missing from the staged plan`);
  return problems;
}

function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Renders the plan as S3 objects: per period, its data file(s) then its manifest. */
function renderObjects(plan, executionId) {
  const root = `${SAMPLE_NAMES.prefix}/${SAMPLE_NAMES.exportName}`;
  const objects = [];
  for (const p of plan.periods) {
    const dataKeys = [];
    p.files.forEach((f, i) => {
      const key = `${root}/data/BILLING_PERIOD=${p.ym}/${executionId}/${SAMPLE_NAMES.exportName}-${String(i + 1).padStart(5, '0')}.csv.gz`;
      const text = `${plan.header}\n${f.records.map((r) => `${r}\n`).join('')}`;
      const body = zlib.gzipSync(Buffer.from(text, 'utf8'), { level: f.level });
      dataKeys.push(key);
      objects.push({ kind: 'data', key, body, sha256: sha256(body), billingPeriod: `${p.ym}-01`, records: f.records.length });
    });
    // The worker's manifest contract (Slice 1 DESIGN §3), NOT a verified copy
    // of a real AWS manifest. No x-ratio-control: real AWS manifests are not
    // known to carry control totals, so the worker's verdict is 'unverified'.
    const manifest = {
      exportName: SAMPLE_NAMES.exportName,
      executionId,
      billingPeriod: { start: `${p.ym}-01T00:00:00.000Z`, end: `${nextMonth(p.ym)}-01T00:00:00.000Z` },
      dataFiles: dataKeys.map((k) => `s3://${SAMPLE_NAMES.bucket}/${k}`),
    };
    const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    objects.push({ kind: 'manifest', key: `${root}/metadata/BILLING_PERIOD=${p.ym}/${SAMPLE_NAMES.exportName}-Manifest.json`, body, sha256: sha256(body), billingPeriod: `${p.ym}-01` });
  }
  return objects;
}

function bumpLastDigit(field) {
  const d = parseDecimal(field.value);
  const v = formatDecimal({ unscaled: d.unscaled + 1n, scale: d.scale });
  return { ...field, raw: field.quoted ? `"${v}"` : v, value: v };
}

/** Applies one mutation (DESIGN §6) to a deep copy of the clean plan. */
function mutatePlan(bytes, clean, kind) {
  if (kind === 'skip-null-conversion') return planStaging(bytes, { nullToEmpty: false });
  if (kind === 'skip-period-split') return planStaging(bytes, { splitByPeriod: false });
  const plan = structuredClone(clean);
  const colIndex = (name) => {
    const i = plan.columns.indexOf(name);
    if (i < 0) throw new Error(`mutation ${kind}: column ${name} is missing`);
    return i;
  };
  const largest = plan.periods.reduce((a, b) => (recordCount(b) > recordCount(a) ? b : a));
  const recs = largest.files[0].records;
  switch (kind) {
    case 'corrupt-billed':
    case 'corrupt-effective': {
      const i = colIndex(kind === 'corrupt-billed' ? 'BilledCost' : 'EffectiveCost');
      const at = recs.findIndex((l) => {
        const f = splitRecord(l)[i];
        return f.value !== '' && DEC_RE.test(f.value);
      });
      if (at < 0) throw new Error(`mutation ${kind}: no record with a value to corrupt`);
      const fields = splitRecord(recs[at]);
      fields[i] = bumpLastDigit(fields[i]);
      recs[at] = joinRecord(fields);
      break;
    }
    case 'drop-row':
      recs.pop();
      break;
    case 'double-ingest':
      // Same records, different gzip level: different bytes, so the worker
      // does not see a byte-identical duplicate artifact; it loads both.
      largest.files.push({ records: [...recs], level: 1 });
      break;
    case 'shift-period': {
      if (plan.periods.length < 2) throw new Error('mutation shift-period needs at least two periods');
      const earliest = plan.periods[0];
      const latest = plan.periods.at(-1);
      const iStart = colIndex('BillingPeriodStart');
      const iEnd = colIndex('BillingPeriodEnd');
      const template = splitRecord(earliest.files[0].records[0]);
      for (const line of latest.files.flatMap((f) => f.records)) {
        const fields = splitRecord(line);
        fields[iStart] = template[iStart];
        fields[iEnd] = template[iEnd];
        earliest.files[0].records.push(joinRecord(fields));
      }
      plan.periods.pop();
      break;
    }
    case 'swap-billed': {
      const i = colIndex('BilledCost');
      const first = splitRecord(recs[0]);
      const j = recs.findIndex((l, k) => k > 0 && splitRecord(l)[i].raw !== first[i].raw);
      if (j < 0) throw new Error('mutation swap-billed: no two records with different BilledCost');
      const second = splitRecord(recs[j]);
      [first[i], second[i]] = [second[i], first[i]];
      recs[0] = joinRecord(first);
      recs[j] = joinRecord(second);
      break;
    }
    default:
      throw new Error(`unknown mutation ${JSON.stringify(kind)}`);
  }
  return plan;
}

/**
 * The staging converter. It proves the clean plan lossless (refusing
 * otherwise), applies the optional mutation and renders the S3 objects.
 * Deterministic for given bytes.
 */
export function stageFocusSample(bytes, { mutation = null } = {}) {
  if (mutation !== null && !MUTATIONS.includes(mutation)) throw new Error(`unknown mutation ${JSON.stringify(mutation)}`);
  const clean = planStaging(bytes);
  const problems = verifyStagingLossless(bytes, clean);
  if (problems.length) throw new Error(`staging is not lossless, refusing:\n  ${problems.join('\n  ')}`);
  const plan = mutation ? mutatePlan(bytes, clean, mutation) : clean;
  const executionId = `sample-${sha256(bytes).slice(0, 12)}`;
  return {
    plan,
    objects: renderObjects(plan, executionId),
    periods: plan.periods.map((p) => ({ billingPeriod: `${p.ym}-01`, records: recordCount(p), dataFiles: p.files.length })),
    nullTokensReplaced: plan.nullTokens,
    executionId,
    mutation,
  };
}

// --- exact decimals ------------------------------------------------------------------

const DEC_RE = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;

/** '-12.340' ⇒ { unscaled: -12340n, scale: 3 }. Plain decimals only (the Python calculator's rule). */
export function parseDecimal(text) {
  const m = typeof text === 'string' ? DEC_RE.exec(text) : null;
  if (!m) throw new Error('not a plain decimal string');
  const frac = m[3] ?? '';
  const u = BigInt(m[2] + frac);
  return { unscaled: m[1] ? -u : u, scale: frac.length };
}

export function formatDecimal({ unscaled, scale }) {
  const neg = unscaled < 0n;
  let digits = (neg ? -unscaled : unscaled).toString();
  if (scale === 0) return `${neg ? '-' : ''}${digits}`;
  digits = digits.padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** Exact sum at the largest scale seen: Postgres's sum(numeric) rule. */
export function sumDecimals(values) {
  const parsed = values.map(parseDecimal);
  const scale = parsed.reduce((s, d) => Math.max(s, d.scale), 0);
  const total = parsed.reduce((t, d) => t + d.unscaled * 10n ** BigInt(scale - d.scale), 0n);
  return formatDecimal({ unscaled: total, scale });
}

/** numeric::text form: no leading zeros, no negative zero, scale kept. */
export function canonicalDecimal(text) {
  return formatDecimal(parseDecimal(text));
}

// --- comparisons -----------------------------------------------------------------------

const groupKey = (period, currency) => `${period}|${currency}`;

/**
 * Per (period, currency) over the API rows: count, exact sums of billedCost
 * and effectiveCost, effectiveCost nulls, and the row digest (the Python
 * calculator's definition, over the API's numeric::text values and
 * extraColumns.Id). Throws on a malformed row.
 */
export function aggregateApiRows(rows) {
  const groups = new Map();
  rows.forEach((r, n) => {
    if (typeof r.billedCost !== 'string' || !DEC_RE.test(r.billedCost)) throw new Error(`row ${n}: billedCost is not a decimal string`);
    if (r.effectiveCost !== null && (typeof r.effectiveCost !== 'string' || !DEC_RE.test(r.effectiveCost))) throw new Error(`row ${n}: effectiveCost is neither null nor a decimal string`);
    const id = r.extraColumns?.Id;
    if (typeof id !== 'string' || id === '') throw new Error(`row ${n}: extraColumns.Id is missing`);
    const key = groupKey(r.billingPeriod, r.billingCurrency);
    if (!groups.has(key)) groups.set(key, { rows: 0, billed: [], effective: [], nulls: 0, lines: [] });
    const g = groups.get(key);
    g.rows += 1;
    g.billed.push(r.billedCost);
    if (r.effectiveCost === null) g.nulls += 1;
    else g.effective.push(r.effectiveCost);
    g.lines.push(Buffer.from(`${id}\t${r.billedCost}\t${r.effectiveCost ?? '\\N'}\n`, 'utf8'));
  });
  const out = {};
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key);
    g.lines.sort(Buffer.compare);
    out[key] = {
      rowCount: String(g.rows),
      billedCost: sumDecimals(g.billed),
      effectiveCost: sumDecimals(g.effective),
      effectiveCostNulls: String(g.nulls),
      rowDigest: sha256(Buffer.concat(g.lines)),
    };
  }
  return out;
}

const GROUP_FIELDS = ['rowCount', 'billedCost', 'effectiveCost', 'effectiveCostNulls', 'rowDigest'];

/**
 * The API read vs the independent control ({ totals: [...] } from the Python
 * calculator). All comparisons are exact strings. Returns the problems.
 */
export function compareAcceptance({ control, apiTotals, rows }) {
  const problems = [];
  const expected = new Map(control.totals.map((t) => [groupKey(t.billingPeriod, t.billingCurrency), t]));
  if (expected.size !== control.totals.length) problems.push('the control has a duplicate (period, currency)');

  if (!Array.isArray(apiTotals)) problems.push('the API returned no totals on page 1');
  else {
    const seen = new Set();
    for (const t of apiTotals) {
      const key = groupKey(t.billingPeriod, t.billingCurrency);
      if (seen.has(key)) {
        problems.push(`API totals ${key}: more than one entry`);
        continue;
      }
      seen.add(key);
      const e = expected.get(key);
      if (!e) {
        problems.push(`API totals ${key}: not in the control`);
        continue;
      }
      if (t.rowCount !== e.rowCount) problems.push(`API totals ${key}: rowCount ${JSON.stringify(t.rowCount)} != control "${e.rowCount}"`);
      if (t.billedCost !== e.billedCost) problems.push(`API totals ${key}: billedCost ${JSON.stringify(t.billedCost)} != control "${e.billedCost}"`);
    }
    for (const key of expected.keys()) if (!seen.has(key)) problems.push(`API totals ${key}: missing`);
  }

  const expectedRows = control.totals.reduce((n, t) => n + BigInt(t.rowCount), 0n);
  const distinct = new Set(rows.map((r) => `${r.batchId}/${r.artifactSha256}/${r.rowOrdinal}`)).size;
  if (BigInt(rows.length) !== expectedRows || BigInt(distinct) !== expectedRows) {
    problems.push(`API rows over all pages: ${rows.length} (${distinct} distinct), control ${expectedRows}`);
  }
  let agg;
  try {
    agg = aggregateApiRows(rows);
  } catch (e) {
    problems.push(`API rows: ${e.message}`);
    return problems;
  }
  for (const [key, e] of expected) {
    const a = agg[key];
    if (!a) {
      problems.push(`API rows ${key}: none`);
      continue;
    }
    for (const f of GROUP_FIELDS) if (a[f] !== e[f]) problems.push(`API rows ${key}: ${f} ${a[f]} != control ${e[f]}`);
  }
  for (const key of Object.keys(agg)) if (!expected.has(key)) problems.push(`API rows ${key}: not in the control`);
  return problems;
}

/** The SHA-256 set of the API rows' artifacts must equal the staged data objects'. */
export function artifactSetProblems(rows, stagedDataSha256s) {
  const got = new Set(rows.map((r) => r.artifactSha256));
  const want = new Set(stagedDataSha256s);
  const problems = [];
  for (const s of want) if (!got.has(s)) problems.push(`staged data object ${s} has no row in the API`);
  for (const s of got) if (!want.has(s)) problems.push(`API rows reference artifact ${s}, which was not staged`);
  return problems;
}

/** Per period: the control's row count and billed total. The worker publishes one currency per batch. */
function controlByPeriod(control, problems) {
  const by = new Map();
  for (const t of control.totals) {
    if (by.has(t.billingPeriod)) {
      problems.push(`control: period ${t.billingPeriod} has more than one currency, the worker publishes one currency per batch`);
      continue;
    }
    by.set(t.billingPeriod, t);
  }
  return by;
}

function periodsOf(record, what, problems) {
  if (record?.pass !== true) problems.push(`${what}: the evidence record does not pass`);
  const periods = record?.results?.periods;
  if (!Array.isArray(periods)) {
    problems.push(`${what}: no periods in the evidence record`);
    return [];
  }
  return periods;
}

/** First sync: every control period `published` with the control's count and billed total, `unverified`; nothing else. */
export function syncProblems(record, control) {
  const problems = [];
  const expected = controlByPeriod(control, problems);
  const seen = new Set();
  for (const p of periodsOf(record, 'sync', problems)) {
    const e = expected.get(p.billingPeriod);
    if (!e || seen.has(p.billingPeriod)) {
      problems.push(`sync: unexpected period ${p.billingPeriod} (${p.outcome})`);
      continue;
    }
    seen.add(p.billingPeriod);
    if (p.outcome !== 'published') problems.push(`sync ${p.billingPeriod}: ${p.outcome}${p.code ? ` ${p.code}` : ''}${p.message ? `: ${p.message}` : ''}`);
    if (p.rowCount !== e.rowCount) problems.push(`sync ${p.billingPeriod}: rowCount ${JSON.stringify(p.rowCount)} != control "${e.rowCount}"`);
    if (p.billedTotal !== e.billedCost) problems.push(`sync ${p.billingPeriod}: billedTotal ${JSON.stringify(p.billedTotal)} != control "${e.billedCost}"`);
    if (p.reconciliation !== 'unverified') problems.push(`sync ${p.billingPeriod}: reconciliation ${JSON.stringify(p.reconciliation)}, expected "unverified" (no control totals in the manifest)`);
  }
  for (const period of expected.keys()) if (!seen.has(period)) problems.push(`sync: control period ${period} was not synced`);
  return problems;
}

/** Second sync: every control period `skipped_unchanged`; nothing else. */
export function resyncProblems(record, control) {
  const problems = [];
  const expected = controlByPeriod(control, problems);
  const seen = new Set();
  for (const p of periodsOf(record, 'second sync', problems)) {
    if (!expected.has(p.billingPeriod) || seen.has(p.billingPeriod)) problems.push(`second sync: unexpected period ${p.billingPeriod} (${p.outcome})`);
    else if (p.outcome !== 'skipped_unchanged') problems.push(`second sync ${p.billingPeriod}: ${p.outcome}, expected skipped_unchanged`);
    seen.add(p.billingPeriod);
  }
  for (const period of expected.keys()) if (!seen.has(period)) problems.push(`second sync: control period ${period} missing`);
  return problems;
}

/**
 * Catalog (ratio.ingest_batches of the sample tenant): exactly one batch per
 * control period, published, unverified, not provisional, with the control's
 * count and billed total; no other batch at all.
 */
export function batchProblems(batches, control) {
  const problems = [];
  const expected = controlByPeriod(control, problems);
  const byPeriod = new Map();
  for (const b of batches) {
    if (!byPeriod.has(b.billing_period)) byPeriod.set(b.billing_period, []);
    byPeriod.get(b.billing_period).push(b);
  }
  for (const [period, list] of byPeriod) {
    if (!expected.has(period)) problems.push(`catalog: unexpected batch(es) for ${period}: ${list.map((b) => b.status).join(', ')}`);
  }
  for (const [period, e] of expected) {
    const list = byPeriod.get(period) ?? [];
    if (list.length !== 1) {
      problems.push(`catalog ${period}: ${list.length} batches (${list.map((b) => b.status).join(', ')}), expected exactly 1`);
      continue;
    }
    const [b] = list;
    if (b.status !== 'published') problems.push(`catalog ${period}: status ${b.status}`);
    if (b.reconciliation !== 'unverified') problems.push(`catalog ${period}: reconciliation ${b.reconciliation}`);
    if (b.is_provisional !== false) problems.push(`catalog ${period}: is_provisional ${b.is_provisional}`);
    if (b.row_count !== e.rowCount) problems.push(`catalog ${period}: row_count ${b.row_count} != control ${e.rowCount}`);
    if (b.loaded_billed_total !== e.billedCost) problems.push(`catalog ${period}: loaded_billed_total ${b.loaded_billed_total} != control ${e.billedCost}`);
  }
  return problems;
}

// --- pinned dataset files ----------------------------------------------------------------

export const DATASET_FILE = path.join('fixtures', 'focus-1.0-sample', 'dataset.json');
export const CONTROL_TOTALS_FILE = path.join('fixtures', 'focus-1.0-sample', 'control-totals.json');

/** fixtures/focus-1.0-sample/dataset.json, shape-checked. */
export function readDataset(root) {
  const ds = JSON.parse(fs.readFileSync(path.join(root, DATASET_FILE), 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(ds.commit ?? '')) throw new Error('dataset.json: commit must be a full git SHA');
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ds.repository ?? '')) throw new Error('dataset.json: repository must be a github.com URL');
  for (const key of DATASET_KEYS) {
    const f = ds.files?.[key];
    if (!f || !/^[0-9a-f]{64}$/.test(f.sha256 ?? '') || !Number.isSafeInteger(f.bytes) || f.bytes <= 0 || typeof f.localPath !== 'string' || typeof f.upstreamPath !== 'string') {
      throw new Error(`dataset.json: files.${key} is incomplete`);
    }
    if (path.isAbsolute(f.localPath) || f.localPath.split('/').includes('..')) throw new Error(`dataset.json: files.${key}.localPath must stay inside the repository`);
  }
  return ds;
}

/** The raw URL of a pinned file at the pinned commit. */
export function pinnedUrl(ds, key) {
  const f = ds.files?.[key];
  if (!DATASET_KEYS.includes(key) || !f) throw new Error(`unknown dataset ${JSON.stringify(key)}`);
  const [, owner, repo] = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(ds.repository);
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ds.commit}/${f.upstreamPath}`;
}

/** Size and SHA-256 against the pin. Returns the problems (empty = verified). */
export function verifyDatasetBytes(bytes, pin) {
  const problems = [];
  if (bytes.length !== pin.bytes) problems.push(`size ${bytes.length} bytes != pinned ${pin.bytes}`);
  const actual = sha256(bytes);
  if (actual !== pin.sha256) problems.push(`SHA-256 ${actual} != pinned ${pin.sha256}`);
  return problems;
}

function alreadyPresent(dest, pin) {
  try {
    return verifyDatasetBytes(fs.readFileSync(dest), pin).length === 0;
  } catch {
    return false;
  }
}

/** Writes verified bytes atomically: temp file in the same directory, then rename. */
function writeAtomically(dest, bytes) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx' });
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Downloads a pinned file under a HARD deadline (withDeadline: the signal is
 * aborted and the promise rejects even if fetchFn ignores it). The body is
 * capped at the pinned size, and size and SHA-256 are verified BEFORE
 * anything is written. Returns 'already-present' (a verified copy exists)
 * or 'fetched'.
 */
export async function fetchPinnedFile({ url, pin, dest, timeoutMs, fetchFn = globalThis.fetch }) {
  if (alreadyPresent(dest, pin)) return 'already-present';
  const bytes = await withDeadline(
    async (signal) => {
      const r = await fetchFn(url, { signal, redirect: 'error' });
      if (!r.ok) throw new Error(`GET ${url} answered ${r.status}`);
      const chunks = [];
      let n = 0;
      for await (const chunk of r.body) {
        n += chunk.length;
        if (n > pin.bytes) throw new Error(`refused: the body exceeds the pinned size of ${pin.bytes} bytes`);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
    timeoutMs,
    `fetch ${path.basename(dest)}`,
  );
  const problems = verifyDatasetBytes(bytes, pin);
  if (problems.length) throw new Error(`refused ${url}: ${problems.join('; ')}`);
  writeAtomically(dest, bytes);
  return 'fetched';
}

/** Copies a pinned file from a local clone with the same checks. Returns 'already-present' or 'copied'. */
export async function copyPinnedFile({ src, pin, dest }) {
  if (alreadyPresent(dest, pin)) return 'already-present';
  const bytes = fs.readFileSync(src);
  const problems = verifyDatasetBytes(bytes, pin);
  if (problems.length) throw new Error(`refused ${src}: ${problems.join('; ')}`);
  writeAtomically(dest, bytes);
  return 'copied';
}
