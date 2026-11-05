import { URL } from 'node:url';
// Pure helpers for collect-pr-evidence.mjs: output parsers, gate status classification, fixture totals
// (BigInt, independent of app code) and the evidence.md renderer. No I/O here, so it is unit-tested.

export const STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', NOT_RUN: 'NOT RUN', NA: 'N/A', PENDING: 'PENDING (orchestrator)' });

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
export const stripAnsi = (s) => String(s).replace(ANSI, '');

/** Parses vitest's summary lines: " Test Files  296 passed (296)" and "      Tests  1 failed | 5006 passed (5007)". */
export function parseVitestTotals(output) {
  const text = stripAnsi(output);
  const line = (label) => {
    const m = new RegExp(`^\\s*${label}\\s+(.+?)\\s*\\((\\d+)\\)\\s*$`, 'm').exec(text);
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
  return files && tests ? { files, tests } : null;
}

/** Parses Playwright's list-reporter summary ("62 passed (6.0m)", "1 failed", "2 skipped", "1 flaky"). */
export function parsePlaywrightTotals(output) {
  const text = stripAnsi(output);
  const counts = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  let found = false;
  for (const k of Object.keys(counts)) {
    const m = new RegExp(`^\\s+(\\d+) ${k}\\b`, 'm').exec(text);
    if (m) { counts[k] = Number(m[1]); found = true; }
  }
  return found ? counts : null;
}

/**
 * A gate is PASS only when it ran, exited 0 and its parsed totals (if any) show no failure. A gate that
 * did not run is NOT RUN (with its reason) or N/A, never PASS.
 */
export function classifyGate(g) {
  if (g.na) return STATUS.NA;
  if (!g.ran) return STATUS.NOT_RUN;
  if (g.exitCode !== 0) return STATUS.FAIL;
  if (g.expectTotals && !g.totals) return STATUS.FAIL; // exit 0 but no summary: not evidence of a pass
  const t = g.totals?.tests ?? g.totals;
  if (t && (t.failed > 0 || t.passed === 0)) return STATUS.FAIL;
  return STATUS.PASS;
}

/** Charter item 1: FAIL if any gate fails, NOT RUN if any is not run (never PASS with a gap), else PASS. */
export function gatesItemStatus(statuses) {
  if (statuses.includes(STATUS.FAIL)) return STATUS.FAIL;
  if (statuses.includes(STATUS.NOT_RUN)) return STATUS.NOT_RUN;
  return STATUS.PASS;
}

// --- environment plans ---------------------------------------------------------------------

/** Passwords in the environment (*_PASSWORD, and inside *_URL connection strings): never in a log, a tail or the report. */
export function secretsFromEnv(env) {
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (/PASSWORD$/.test(k) && v) { out.push(v); continue; }
    if (!/_URL$/.test(k) || !v) continue;
    try { const u = new URL(v); if (u.password) out.push(u.password, decodeURIComponent(u.password)); } catch { /* not a URL */ }
  }
  return [...new Set(out.filter((s) => s.length >= 4))];
}
export function redact(text, secrets) {
  let t = String(text);
  for (const s of secrets) t = t.split(s).join('[redacted]');
  return t;
}

/** test:db needs Postgres 16, an S3 endpoint and PG16 client tools (it fails, never skips, without them). */
export function dbTestPlan(env) {
  if (!env.RATIO_TEST_DATABASE_URL) return { run: false, reason: 'NOT RUN: no database in this environment (RATIO_TEST_DATABASE_URL unset)' };
  const missing = ['RATIO_TEST_S3_ENDPOINT', 'RATIO_PG_DUMP', 'RATIO_PSQL'].filter((k) => !env[k]);
  return missing.length ? { run: false, reason: `NOT RUN: database present but ${missing.join(', ')} unset (the suite fails, never skips, without them)` } : { run: true };
}

/**
 * Browser for the Playwright gates: an explicit path (RATIO_EVIDENCE_CHROMIUM, then RATIO_CHROMIUM_PATH, the
 * repo's own variable) or Playwright's own installed Chromium. Null with an instruction when neither exists.
 */
export function browserPlan(env, managedPath, exists) {
  const explicit = env.RATIO_EVIDENCE_CHROMIUM || env.RATIO_CHROMIUM_PATH;
  if (explicit) return exists(explicit) ? { env: { RATIO_CHROMIUM_PATH: explicit }, source: 'explicit path' } : { env: null, reason: `NOT RUN: browser not found at ${explicit}` };
  if (managedPath && exists(managedPath)) return { env: {}, source: 'Playwright-managed Chromium' };
  return { env: null, reason: 'NOT RUN: no Chromium (run `npx playwright install chromium`, or set RATIO_EVIDENCE_CHROMIUM)' };
}

// --- fixture totals ------------------------------------------------------------------------

const U = 10n ** 10n;
/** Exact decimal (up to 10 places) to 1e-10 units. Throws on anything else. */
export function parseUnits(v) {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(String(v).trim());
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`not a plain decimal: ${v}`);
  if ((m[3] ?? '').length > 10) throw new Error(`more than 10 decimal places: ${v}`);
  const n = BigInt((m[2] || '0') + (m[3] ?? '').padEnd(10, '0'));
  return m[1] === '-' ? -n : n;
}
export function formatUnits(u) {
  const neg = u < 0n;
  const a = neg ? -u : u;
  return `${neg ? '-' : ''}${a / U}.${(a % U).toString().padStart(10, '0')}`;
}

/** Rows as objects, per currency: row count and BigInt sums of BilledCost / EffectiveCost (empty = N/A, not 0). */
export function totalsByCurrency(rows) {
  const out = {};
  for (const r of rows) {
    const cur = r.BillingCurrency || '(none)';
    const t = (out[cur] ??= { rows: 0, billed: 0n, effective: 0n, naBilled: 0, naEffective: 0 });
    t.rows++;
    if (r.BilledCost === undefined || r.BilledCost === '') t.naBilled++; else t.billed += parseUnits(r.BilledCost);
    if (r.EffectiveCost === undefined || r.EffectiveCost === '') t.naEffective++; else t.effective += parseUnits(r.EffectiveCost);
  }
  return Object.fromEntries(Object.entries(out).map(([k, t]) => [k, { ...t, billed: formatUnits(t.billed), effective: formatUnits(t.effective) }]));
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

/** Rows of a fixture file: the demo dataset JSON shape ({columns, rows}) or CSV. Null when not tabular. */
export function fixtureRows(path, text) {
  if (path.endsWith('.json')) {
    const d = JSON.parse(text);
    if (Array.isArray(d?.columns) && Array.isArray(d?.rows)) return d.rows.map((r) => Object.fromEntries(d.columns.map((c, i) => [c, r[i]])));
    return null;
  }
  if (path.endsWith('.csv')) return parseCsv(text);
  return null;
}

/** Stated control totals in a demo dataset's meta, for comparison with the recomputed ones. */
export function statedTotals(path, text) {
  if (!path.endsWith('.json')) return null;
  const d = JSON.parse(text);
  return d?.meta?.controlTotals ?? null;
}

// --- report ---------------------------------------------------------------------------------

/** A Markdown table cell: backslashes first, then pipes, then newlines (no partial escaping). */
export const cell = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderEvidenceMd(e) {
  const L = [];
  L.push(`# Merge evidence: PR #${e.pr}`, '');
  L.push(`Attests code SHA \`${e.head.sha}\` (tree \`${e.head.tree}\`) against base \`${e.base.sha}\` (tree \`${e.base.tree}\`), merge-base \`${e.mergeBase}\`.`);
  L.push(`Generated ${e.generatedAt} by \`${e.command}\`. Node ${e.env.node}, npm ${e.env.npm}, ${e.env.os}.`);
  if (e.evidenceCommitNote) L.push('', e.evidenceCommitNote);
  L.push('', '## Charter', '', '| # | Item | Status | Evidence |', '|---|---|---|---|');
  for (const c of e.charter) L.push(`| ${c.id} | ${cell(c.item)} | **${c.status}** | ${cell(c.evidence)} |`);
  L.push('', '## Gates', '', '| Gate | Command | Status | Exit | Duration | Result | Log sha256 |', '|---|---|---|---|---|---|---|');
  for (const g of e.gates) L.push(`| ${cell(g.name)} | \`${cell(g.command)}\` | **${g.status}** | ${g.exitCode ?? '—'} | ${g.durationSec != null ? `${g.durationSec}s` : '—'} | ${cell(g.summary)} | ${g.logSha256 ? `\`${g.logSha256.slice(0, 16)}…\`` : '—'} |`);
  if (e.informational?.length) {
    L.push('', '### Informational (not a charter gate)', '', '| Check | Command | Status | Result |', '|---|---|---|---|');
    for (const g of e.informational) L.push(`| ${cell(g.name)} | \`${cell(g.command)}\` | **${g.status}** | ${cell(g.summary)} |`);
  }
  L.push('', '## Fixture provenance', '');
  if (!e.fixtures.files.length) L.push('No fixture files changed.');
  else {
    L.push('| Path | sha256 base | sha256 head | Rows base → head | Recomputed totals (head, BigInt) | Matches stated | Numbers unchanged |', '|---|---|---|---|---|---|---|');
    for (const f of e.fixtures.files) {
      const tot = f.headTotals ? Object.entries(f.headTotals).map(([c, t]) => `${c}: ${t.rows} rows, billed ${t.billed}, effective ${t.effective}`).join('; ') : '—';
      L.push(`| \`${f.path}\` | \`${(f.baseSha256 ?? '—').slice(0, 12)}\` | \`${(f.headSha256 ?? '—').slice(0, 12)}\` | ${f.baseRows ?? '—'} → ${f.headRows ?? '—'} | ${cell(tot)} | ${f.matchesStated ?? '—'} | ${f.totalsUnchanged ?? '—'} |`);
    }
    L.push('', `Determinism: ${e.fixtures.determinism.map((d) => `\`${d.command}\` then \`git diff --exit-code\`: **${d.status}**`).join('; ') || 'no generator applies'}.`);
  }
  L.push('', '## Rollback in test', '', e.rollback.procedure, '', `Result: **${e.rollback.status}**. ${e.rollback.detail}`, '');
  L.push('Production rollback: ' + e.rollback.production, '');
  L.push('## Known gaps', '');
  for (const k of e.knownGaps.length ? e.knownGaps : ['None recorded.']) L.push(`- ${k}`);
  L.push('', '## Gate log tails', '');
  for (const g of e.gates.filter((x) => x.tail)) L.push(`<details><summary>${cell(g.name)} (last 40 lines)</summary>`, '', '```', g.tail, '```', '', '</details>', '');
  return L.join('\n') + '\n';
}
