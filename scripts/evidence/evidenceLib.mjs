import { URL } from 'node:url';
import { renderPlatformEvidenceMd } from './platformEvidence.mjs';
// Pure helpers for collect-pr-evidence.mjs: CLI parsing, the gate environment allowlist, migration
// target safety, output parsers, gate / charter status rules, exact-decimal fixture totals (BigInt, any
// scale, independent of app code), redaction and the evidence.md renderer. No I/O here, so it is tested.

export const STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', NOT_RUN: 'NOT RUN', NA: 'N/A', PENDING: 'PENDING (orchestrator)' });
export const EXIT = Object.freeze({ OK: 0, GATE_FAILED: 1, USAGE: 2, REFUSED: 3 });

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
export const stripAnsi = (s) => String(s).replace(ANSI, '');

// --- CLI ---------------------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['base', 'head', 'pr', 'out', 'logs', 'port', 'gate-timeout']);
const BOOL_FLAGS = new Set(['migration-smoke', 'plan-only']);
/** Strict argv parsing: unknown flags, flags without values and a non-positive --pr are usage errors. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) return { error: `unexpected argument: ${a}` };
    const k = a.slice(2);
    if (BOOL_FLAGS.has(k)) { args[k] = true; continue; }
    if (!VALUE_FLAGS.has(k)) return { error: `unknown flag: ${a}` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--') || v === '') return { error: `${a} needs a value` };
    args[k] = v; i++;
  }
  for (const k of ['base', 'head', 'pr']) if (!args[k]) return { error: `--${k} is required` };
  if (!/^[1-9]\d*$/.test(args.pr)) return { error: `--pr must be a positive integer (got ${args.pr})` };
  if (args.port !== undefined && !(/^\d+$/.test(args.port) && Number(args.port) >= 1024 && Number(args.port) < 65535)) return { error: '--port must be 1024-65534' };
  if (args['gate-timeout'] !== undefined && !/^[1-9]\d*$/.test(args['gate-timeout'])) return { error: '--gate-timeout must be a positive number of minutes' };
  return { args };
}

// --- gate environment ---------------------------------------------------------------------------

/** Passed through to gates unchanged; everything else in the caller's environment is dropped. */
export const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'CI',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'ALL_PROXY', 'all_proxy', 'PLAYWRIGHT_BROWSERS_PATH', 'XDG_CACHE_HOME', 'NVM_DIR', 'NVM_BIN', 'VOLTA_HOME', 'FNM_DIR'];
/**
 * npm settings a corporate Mac may need (registry, CA, proxy, TLS). Credentials (_authToken, _auth, password)
 * are never passed. NODE_OPTIONS is deliberately NOT passed: it can preload arbitrary code (--require/--import)
 * or change runtime behavior for every gate, and nothing here needs it.
 */
const NPM_CONFIG = /^npm_config_(registry|cafile|ca|proxy|https_proxy|https-proxy|strict_ssl|strict-ssl|noproxy|no_proxy|no-proxy)$/i;
/** Explicit inputs, renamed for the repo's tests. RATIO_EVIDENCE_SCRATCH_DATABASE_URL is mapped only into migration steps. */
export const MAPPED_ENV = { RATIO_EVIDENCE_TEST_DATABASE_URL: 'RATIO_TEST_DATABASE_URL', RATIO_EVIDENCE_S3_ENDPOINT: 'RATIO_TEST_S3_ENDPOINT', RATIO_EVIDENCE_PG_DUMP: 'RATIO_PG_DUMP', RATIO_EVIDENCE_PSQL: 'RATIO_PSQL' };

/**
 * The environment a gate runs with: the allowlist plus the explicitly mapped evidence inputs plus `extra`.
 * Untrusted PR code (npm lifecycle scripts, tests) never sees the caller's other variables, so no inherited
 * RATIO_*DATABASE_URL, token or secret can reach it.
 */
export function gateEnv(env, extra = {}) {
  const out = { NEXT_TELEMETRY_DISABLED: '1' };
  for (const k of ENV_ALLOWLIST) if (env[k] !== undefined) out[k] = env[k];
  for (const [k, v] of Object.entries(env)) if (NPM_CONFIG.test(k) && v !== undefined) out[k] = v;
  for (const [from, to] of Object.entries(MAPPED_ENV)) if (env[from]) out[to] = env[from];
  return { ...out, ...extra };
}

/** test:db needs Postgres 16, an S3 endpoint and PG16 client tools (it fails, never skips, without them). */
export function dbTestPlan(env) {
  if (!env.RATIO_EVIDENCE_TEST_DATABASE_URL) return { run: false, reason: 'NOT RUN: no database in this environment (RATIO_EVIDENCE_TEST_DATABASE_URL unset)' };
  const missing = ['RATIO_EVIDENCE_S3_ENDPOINT', 'RATIO_EVIDENCE_PG_DUMP', 'RATIO_EVIDENCE_PSQL'].filter((k) => !env[k]);
  return missing.length ? { run: false, reason: `NOT RUN: database present but ${missing.join(', ')} unset (the suite fails, never skips, without them)` } : { run: true };
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/**
 * Migration steps run down-migrations, so they may only touch a throwaway local database: the URL comes from
 * RATIO_EVIDENCE_SCRATCH_DATABASE_URL only, the host is loopback, the database name is ratio_evidence_*, and the
 * caller is not a production environment (RATIO_ENV or NODE_ENV). Returns { ok } or { ok: false, reason }.
 */
export function migrationTarget(env) {
  const url = (env.RATIO_EVIDENCE_SCRATCH_DATABASE_URL ?? '').trim();
  if (!url) return { ok: false, reason: 'no scratch database (RATIO_EVIDENCE_SCRATCH_DATABASE_URL unset)' };
  for (const k of ['RATIO_ENV', 'NODE_ENV']) if (/^prod(uction)?$/i.test((env[k] ?? '').trim())) return { ok: false, reason: `refused: ${k}=${env[k]} (migration checks never run in a production environment)` };
  let u;
  try { u = new URL(url); } catch { return { ok: false, reason: 'refused: RATIO_EVIDENCE_SCRATCH_DATABASE_URL is not a URL' }; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return { ok: false, reason: 'refused: the scratch database URL is not postgres://' };
  if (!LOCAL_HOSTS.has(u.hostname)) return { ok: false, reason: `refused: scratch database host ${u.hostname} is not 127.0.0.1/localhost` };
  // Connection parameters in the query string override the URL's host/port/database (pg-connection-string).
  const overriding = [...u.searchParams.keys()].filter((k) => /^(host|hostaddr|port|dbname|database|service|user|options)$/i.test(k.trim()));
  if (overriding.length) return { ok: false, reason: `refused: the scratch database URL sets ${overriding.join(', ')} in its query string` };
  let db;
  try { db = decodeURIComponent(u.pathname.replace(/^\//, '')); } catch { return { ok: false, reason: 'refused: the scratch database name is not valid percent-encoding' }; }
  if (!/^ratio_evidence_[a-z0-9_]+$/.test(db)) return { ok: false, reason: `refused: scratch database name "${db}" does not match ^ratio_evidence_[a-z0-9_]+$` };
  return { ok: true, url, db };
}
/** The env for a migration step: down-migrations are allowed only here, only on the vetted scratch URL. */
export function migrationEnv(env) {
  const t = migrationTarget(env);
  if (!t.ok) throw new Error(t.reason);
  return gateEnv(env, { RATIO_MIGRATE_DATABASE_URL: t.url, RATIO_ENV: 'ci', RATIO_ALLOW_DOWN_MIGRATIONS: '1' });
}

/** Browser for the Playwright gates: RATIO_EVIDENCE_CHROMIUM, else Playwright's own installed Chromium. */
export function browserPlan(env, managedPath, exists) {
  const explicit = env.RATIO_EVIDENCE_CHROMIUM;
  if (explicit) return exists(explicit) ? { env: { RATIO_CHROMIUM_PATH: explicit }, source: 'explicit path (RATIO_EVIDENCE_CHROMIUM)' } : { env: null, reason: `NOT RUN: browser not found at ${explicit}` };
  if (managedPath && exists(managedPath)) return { env: {}, source: 'Playwright-managed Chromium' };
  return { env: null, reason: 'NOT RUN: no Chromium (run `npx playwright install chromium`, or set RATIO_EVIDENCE_CHROMIUM)' };
}

// --- redaction ---------------------------------------------------------------------------------

const SECRET_NAME = /(PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|CREDENTIAL|_KEY$|^KEY$|API_?KEY|PRIVATE)/i;
/**
 * A value worth redacting: at least 8 characters and not a number or a boolean-like word. Shorter or
 * structural values (MAX_THINKING_TOKENS=12345, TOKEN_REFRESH_ENABLED=1 or true) would otherwise corrupt
 * numbers and SHAs everywhere in the evidence.
 */
export function isRedactable(v) {
  const s = String(v ?? '');
  return s.length >= 8 && !/^[+-]?\d+(\.\d+)?$/.test(s) && !/^(true|false|yes|no|on|off|null|undefined)$/i.test(s);
}
/** Values to redact: secret-named variables, and passwords inside URL-shaped values (user:pass@ or ?password=). */
export function secretsFromEnv(env) {
  const out = new Set();
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    if (SECRET_NAME.test(k)) out.add(v);
    if (/:\/\//.test(v)) {
      try {
        const u = new URL(v);
        if (u.password) { out.add(u.password); try { out.add(decodeURIComponent(u.password)); } catch { /* not decodable */ } }
        for (const [qk, qv] of u.searchParams) if (/pass|secret|token|key/i.test(qk) && qv) { out.add(qv); out.add(encodeURIComponent(qv)); }
      } catch { /* not a URL */ }
    }
  }
  return [...out].filter(isRedactable).sort((a, b) => b.length - a.length);
}
const jsonInner = (s) => JSON.stringify(s).slice(1, -1);
/** Replaces every form a secret can take in text: raw, JSON-escaped (once and twice) and URL-encoded. */
export function redact(text, secrets) {
  let t = String(text);
  for (const s of secrets) {
    for (const form of new Set([s, jsonInner(s), jsonInner(jsonInner(s)), encodeURIComponent(s)])) if (form) t = t.split(form).join('[redacted]');
  }
  return t;
}
/** Field-by-field redaction of a value BEFORE it is serialized: only strings change; numbers, booleans and keys never do. */
export function redactDeep(value, secrets) {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)]));
  return value;
}
/** The structural fields redaction must never touch; a difference means the evidence would be corrupt. */
export function integrityProblems(original, redacted, serialized) {
  const problems = [];
  try { JSON.parse(serialized); } catch (e) { problems.push(`evidence.json is not valid JSON after redaction: ${e.message}`); }
  for (const p of ['pr', 'head.sha', 'head.tree', 'base.sha', 'base.tree', 'mergeBase.sha', 'mergeBase.tree']) {
    const get = (o) => p.split('.').reduce((x, k) => x?.[k], o);
    if (get(original) !== get(redacted)) problems.push(`redaction changed ${p}`);
  }
  return problems;
}

// --- parsers and statuses ----------------------------------------------------------------------

/** vitest's summary: the LAST "Test Files" and "Tests" lines (a nested run can print an earlier one). */
export function parseVitestTotals(output) {
  const text = stripAnsi(output);
  const line = (label) => {
    const all = [...text.matchAll(new RegExp(`^\\s*${label}\\s+(.+?)\\s*\\((\\d+)\\)\\s*$`, 'gm'))];
    const m = all.at(-1);
    if (!m) return null;
    const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: Number(m[2]) };
    for (const part of m[1].split('|')) {
      const p = /(\d+)\s+(passed|failed|skipped|todo)/.exec(part);
      if (p) counts[p[2]] = Number(p[1]);
    }
    return counts;
  };
  const files = line('Test Files');
  const tests = line('Tests');
  return files && tests ? { kind: 'vitest', files, tests } : null;
}

/** Playwright's list-reporter summary ("62 passed (6.0m)", "1 failed", "2 skipped", "1 flaky"). */
export function parsePlaywrightTotals(output) {
  const text = stripAnsi(output);
  const counts = { kind: 'playwright', passed: 0, failed: 0, skipped: 0, flaky: 0 };
  let found = false;
  for (const k of ['passed', 'failed', 'skipped', 'flaky']) {
    const all = [...text.matchAll(new RegExp(`^\\s+(\\d+) ${k}\\b`, 'gm'))];
    if (all.length) { counts[k] = Number(all.at(-1)[1]); found = true; }
  }
  return found ? counts : null;
}

/**
 * Status and a note. PASS only when the gate ran, exited 0, did not time out or fail to spawn, and its parsed
 * totals show passes and no failure. Conservative and explicit: all-skipped is FAIL; flaky-only passes are PASS
 * with a note. NOT RUN and N/A are never PASS.
 */
export function classifyGate(g) {
  if (g.na) return { status: STATUS.NA, note: null };
  if (!g.ran) return { status: STATUS.NOT_RUN, note: null };
  if (g.spawnError) return { status: STATUS.FAIL, note: `could not start: ${g.spawnError}` };
  if (g.timedOut) return { status: STATUS.FAIL, note: `timed out after ${g.timeoutMin} min` };
  if (g.signal) return { status: STATUS.FAIL, note: `killed by ${g.signal}` };
  if (g.exitCode !== 0) return { status: STATUS.FAIL, note: null };
  if (g.expectTotals && !g.totals) return { status: STATUS.FAIL, note: 'exit 0 but no test summary in the output' };
  const t = g.totals?.kind === 'vitest' ? g.totals.tests : g.totals;
  if (t) {
    if (t.failed > 0) return { status: STATUS.FAIL, note: `${t.failed} failed` };
    if (t.passed === 0 && (t.flaky ?? 0) === 0) return { status: STATUS.FAIL, note: t.skipped > 0 ? `all ${t.skipped} tests skipped` : 'no test passed' };
    if ((t.flaky ?? 0) > 0) return { status: STATUS.PASS, note: `${t.flaky} flaky (passed on retry)` };
  }
  return { status: STATUS.PASS, note: null };
}

/** Charter item 1: FAIL if any gate fails, NOT RUN if any is not run (never PASS with a gap), else PASS. */
export function gatesItemStatus(statuses) {
  if (statuses.includes(STATUS.FAIL)) return STATUS.FAIL;
  if (statuses.includes(STATUS.NOT_RUN)) return STATUS.NOT_RUN;
  return STATUS.PASS;
}
/** Determinism: the generator ran clean, the tracked diff is empty (or .gz-only with identical content), nothing untracked. */
export function determinismStatus({ gate, trackedDiff, untracked }) {
  return gate === STATUS.PASS && !trackedDiff && !untracked ? STATUS.PASS : STATUS.FAIL;
}
/** Rollback: the reverse-applied tree must equal the base tree AND every gate on it must pass. */
export function rollbackStatus({ tree, baseTree, gates }) {
  return tree && tree === baseTree && gates.length > 0 && gates.every((s) => s === STATUS.PASS) ? STATUS.PASS : STATUS.FAIL;
}

// --- exact decimals (any scale) ----------------------------------------------------------------

/** A plain decimal string as { int: BigInt, scale } with no precision limit. Throws on anything else. */
export function parseDecimal(v) {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(String(v).trim());
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`not a plain decimal: ${v}`);
  const frac = m[3] ?? '';
  const n = BigInt((m[2] || '0') + frac);
  return { int: m[1] === '-' ? -n : n, scale: frac.length };
}
const rescale = (d, scale) => d.int * 10n ** BigInt(scale - d.scale);
export function formatDecimal({ int, scale }) {
  const neg = int < 0n;
  const a = (neg ? -int : int).toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${scale ? `${a.slice(0, -scale)}.${a.slice(-scale)}` : a}`;
}
/** Exact sum of decimal strings at the largest scale seen. */
export function sumDecimals(values) {
  const ds = values.map(parseDecimal);
  const scale = ds.reduce((s, d) => Math.max(s, d.scale), 0);
  return { int: ds.reduce((s, d) => s + rescale(d, scale), 0n), scale };
}
/** Numeric equality of two decimal strings regardless of scale ("1.50" equals "1.5000000000"). */
export function decimalsEqual(a, b) {
  const x = parseDecimal(a), y = parseDecimal(b);
  const s = Math.max(x.scale, y.scale);
  return rescale(x, s) === rescale(y, s);
}

/** Per currency: rows, exact BilledCost / EffectiveCost sums (null when every row is empty) and N/A counts. Empty is N/A, never 0. */
export function totalsByCurrency(rows) {
  const acc = {};
  for (const r of rows) {
    const cur = r.BillingCurrency || '(none)';
    const t = (acc[cur] ??= { rows: 0, billed: [], effective: [], naBilled: 0, naEffective: 0 });
    t.rows++;
    if (r.BilledCost === undefined || r.BilledCost === null || r.BilledCost === '') t.naBilled++; else t.billed.push(r.BilledCost);
    if (r.EffectiveCost === undefined || r.EffectiveCost === null || r.EffectiveCost === '') t.naEffective++; else t.effective.push(r.EffectiveCost);
  }
  return Object.fromEntries(Object.entries(acc).map(([k, t]) => [k, {
    rows: t.rows, naBilled: t.naBilled, naEffective: t.naEffective,
    billed: t.billed.length ? formatDecimal(sumDecimals(t.billed)) : null,
    effective: t.effective.length ? formatDecimal(sumDecimals(t.effective)) : null,
  }]));
}
/** Stated vs recomputed: same rows and numerically equal sums per currency. */
export function totalsMatch(stated, computed) {
  return Object.entries(stated).every(([c, s]) => {
    const t = computed[c];
    const eq = (a, b) => ((a ?? null) === null || (b ?? null) === null ? (a ?? null) === (b ?? null) : decimalsEqual(a, b));
    return t && s.rows === t.rows && eq(s.billed, t.billed) && eq(s.effective, t.effective);
  });
}

/** Minimal RFC 4180 CSV reader (quotes, doubled quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [header = [], ...body] = rows.filter((r) => r.length > 1 || r[0] !== '');
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** Rows of a fixture: the demo dataset JSON shape ({columns, rows}) or CSV (already decompressed). Null when not tabular. */
export function fixtureRows(path, text) {
  const p = path.replace(/\.gz$/, '');
  if (p.endsWith('.json')) {
    const d = JSON.parse(text);
    if (Array.isArray(d?.columns) && Array.isArray(d?.rows)) return d.rows.map((r) => Object.fromEntries(d.columns.map((c, i) => [c, r[i]])));
    return null;
  }
  if (p.endsWith('.csv')) return parseCsv(text);
  return null;
}
/**
 * The synthetic FOCUS export (fixtures/focus-1.0-synthetic/<variant>/.../BILLING_PERIOD=YYYY-MM/...csv.gz):
 * per variant and billing period, the row count and exact BilledCost total over ALL of that period's files,
 * in the shape of its control-totals.json.
 */
export function syntheticExportTotals(files) {
  const acc = {};
  for (const { path: p, text } of files) {
    const m = /focus-1\.0-synthetic\/([^/]+)\/.*BILLING_PERIOD=(\d{4}-\d{2})\//.exec(p);
    if (!m) continue;
    const key = `${m[2]}-01`;
    const t = ((acc[m[1]] ??= {})[key] ??= { rows: 0, billed: [] });
    for (const r of parseCsv(text)) { t.rows++; if (r.BilledCost !== '') t.billed.push(r.BilledCost); }
  }
  return Object.fromEntries(Object.entries(acc).map(([v, ps]) => [v, Object.fromEntries(Object.entries(ps).map(([k, t]) => [k, { rowCount: t.rows, billedTotal: formatDecimal(sumDecimals(t.billed)) }]))]));
}
/** Differences between recomputed synthetic export totals and control-totals.json (empty when they agree). */
export function compareControlTotals(computed, stated) {
  const out = [];
  for (const [v, ps] of Object.entries(stated)) for (const [k, s] of Object.entries(ps)) {
    const c = computed[v]?.[k];
    if (!c) out.push(`${v} ${k}: no files`);
    else if (c.rowCount !== s.rowCount || !decimalsEqual(c.billedTotal, s.billedTotal)) out.push(`${v} ${k}: recomputed ${c.rowCount} rows / ${c.billedTotal}, stated ${s.rowCount} / ${s.billedTotal}`);
  }
  for (const [v, ps] of Object.entries(computed)) for (const k of Object.keys(ps)) if (!stated[v]?.[k]) out.push(`${v} ${k}: not in control-totals.json`);
  return out;
}

/** Stated control totals in a demo dataset's meta. */
export function statedTotals(path, text) {
  if (!path.endsWith('.json')) return null;
  const d = JSON.parse(text);
  return d?.meta?.controlTotals ?? null;
}

// --- report ------------------------------------------------------------------------------------

/** A Markdown table cell: backslashes first, then pipes, then newlines (no partial escaping). */
export const cell = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
/** A fenced block that its content cannot close: the fence is longer than any backtick run inside. */
export function fence(text) {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}\n${text}\n${f}`;
}
const money = (v, na, rows) => (v === null ? `N/A (all ${rows} rows)` : `${v}${na ? ` (+${na} N/A)` : ''}`);
export function totalsText(totals) {
  return Object.entries(totals).map(([c, t]) => `${c}: ${t.rows} rows, billed ${money(t.billed, t.naBilled, t.rows)}, effective ${money(t.effective, t.naEffective, t.rows)}`).join('; ');
}

export function renderEvidenceMd(e) {
  const L = [];
  L.push(`# Merge evidence: PR #${e.pr}`, '');
  L.push(`Attests code SHA \`${e.head.sha}\` (tree \`${e.head.tree}\`) against merge-base \`${e.mergeBase.sha}\` (tree \`${e.mergeBase.tree}\`); requested base \`${e.base.ref}\` = \`${e.base.sha}\`.`);
  if (e.base.sha !== e.mergeBase.sha) L.push('', `Note: the requested base is not the merge-base; every diff, fixture, migration and rollback check uses the merge-base \`${e.mergeBase.sha}\`.`);
  L.push(`Generated ${e.generatedAt} by \`${e.command}\`. Node ${e.env.node}, npm ${e.env.npm}, ${e.env.os}.`);
  if (e.collector) L.push(`Collector: commit \`${e.collector.commit ?? 'not a git checkout'}\`, script sha256 \`${e.collector.script.slice(0, 16)}…\`, lib sha256 \`${e.collector.lib.slice(0, 16)}…\`${e.collector.platformLib ? `, platform lib sha256 \`${e.collector.platformLib.slice(0, 16)}…\`` : ''}.`);
  if (e.evidenceCommitNote) L.push('', e.evidenceCommitNote);
  L.push('', '## Charter', '', '| # | Item | Status | Evidence |', '|---|---|---|---|');
  for (const c of e.charter) L.push(`| ${c.id} | ${cell(c.item)} | **${c.status}** | ${cell(c.evidence)} |`);
  L.push('', '## Gates', '', '| Gate | Command | Status | Exit | Duration | Result | Log sha256 |', '|---|---|---|---|---|---|---|');
  const row = (g) => `| ${cell(g.name)} | \`${cell(g.command)}\` | **${g.status}** | ${g.exitCode ?? '—'} | ${g.durationSec != null ? `${g.durationSec}s` : '—'} | ${cell([g.summary, g.note].filter(Boolean).join('; '))} | ${g.logSha256 ? `\`${g.logSha256.slice(0, 16)}…\`` : '—'} |`;
  for (const g of e.gates) L.push(row(g));
  if (e.informational?.length) {
    L.push('', '### Informational (not a charter gate)', '', '| Check | Command | Status | Exit | Duration | Result | Log sha256 |', '|---|---|---|---|---|---|---|');
    for (const g of e.informational) L.push(row(g));
  }
  L.push('', '## Fixture provenance', '');
  if (!e.fixtures.files.length) L.push('No fixture files changed.');
  else {
    L.push('| Path | sha256 base | sha256 head | Rows base → head | Recomputed totals (head, BigInt) | Matches stated | Numbers unchanged | Error |', '|---|---|---|---|---|---|---|---|');
    for (const f of e.fixtures.files) {
      L.push(`| \`${cell(f.path)}\` | \`${(f.baseSha256 ?? '—').slice(0, 12)}\` | \`${(f.headSha256 ?? '—').slice(0, 12)}\` | ${f.baseRows ?? '—'} → ${f.headRows ?? '—'} | ${cell(f.headTotals ? totalsText(f.headTotals) : f.tabular === false ? 'not tabular (hash only)' : '—')} | ${f.matchesStated ?? '—'} | ${f.totalsUnchanged ?? '—'} | ${cell(f.error ?? '')} |`);
    }
    if (e.fixtures.controlTotals) L.push('', `Synthetic export control totals (${cell(e.fixtures.controlTotals.file)}): **${e.fixtures.controlTotals.status}**${e.fixtures.controlTotals.problems.length ? ` — ${cell(e.fixtures.controlTotals.problems.join('; '))}` : ` (${cell(e.fixtures.controlTotals.summary)})`}.`);
    L.push('', `Determinism: ${e.fixtures.determinism.map((d) => `\`${cell(d.command)}\`: **${d.status}**${d.detail ? ` (${cell(d.detail)})` : ''}`).join('; ') || 'no generator applies'}.`);
  }
  L.push('', '## Rollback in test', '', e.rollback.procedure, '', `Result: **${e.rollback.status}**. ${e.rollback.detail}`, '');
  L.push('Production rollback: ' + e.rollback.production, '');
  if (e.platform) L.push(renderPlatformEvidenceMd(e.platform));
  L.push('## Known gaps', '');
  for (const k of e.knownGaps.length ? e.knownGaps : ['None recorded.']) L.push(`- ${k}`);
  L.push('', '## Gate log tails', '');
  for (const g of [...e.gates, ...(e.informational ?? [])].filter((x) => x.tail)) L.push(`<details><summary>${cell(g.name)} (last 40 lines)</summary>`, '', fence(g.tail), '', '</details>', '');
  return L.join('\n') + '\n';
}
