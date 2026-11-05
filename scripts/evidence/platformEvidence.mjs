import path from 'node:path';
// Platform capability evidence (ADR-0001 §14, slice A0). Pure: validates the evidence manifest, indexes a vitest JSON
// report and derives a per-capability status for collect-pr-evidence.mjs. NON-GATING: nothing here changes a gate,
// the charter or the exit code. The highest status is "pre-release validated" (live verification is a signed record,
// never this report); a missing, failing or skipped test is NOT VALIDATED; nothing is ever PASS.

export const PLATFORM_MANIFEST = 'docs/evidence/platform/manifest.json';
export const STATUS_CEILING = 'implemented and pre-release validated; live verification scheduled';
export const CAP = Object.freeze({ NOT_STARTED: 'NOT STARTED', PLANNED: 'PLANNED', IN_PROGRESS: 'IN PROGRESS', NOT_RUN: 'NOT RUN', NOT_VALIDATED: 'NOT VALIDATED', PRE_RELEASE: 'PRE-RELEASE VALIDATED' });
export const ITEM = Object.freeze({ PLANNED: 'PLANNED', NOT_RUN: 'NOT RUN', MISSING: 'MISSING', FAILED: 'FAILED', SKIPPED: 'SKIPPED', PASSED: 'PASSED' });

const DECLARED = ['not started', 'planned', 'in progress'];
const RELEASES = ['1.1', '1.2', '1.3', '1.3/2.0', '2.0'];
const KINDS = ['test', 'fixture', 'report', 'document'];
const TEST_FILE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+\.test\.(ts|tsx|mjs)$/;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim() !== '';

/** Every problem with the manifest, by key path (never a value). Empty when valid. */
export function manifestProblems(m) {
  if (!isObj(m)) return ['manifest: must be a JSON object'];
  const p = [];
  const keys = (o, at, allowed) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) p.push(`${at}${at ? '.' : ''}${k}: unknown key`); };
  const need = (o, at, k) => { if (!text(o[k])) p.push(`${at}.${k}: non-empty text`); };
  keys(m, '', ['$comment', 'schema', 'statusCeiling', 'capabilities']);
  if (m.schema !== 'ratio.platform-evidence-manifest/1') p.push('schema: must be ratio.platform-evidence-manifest/1');
  if (m.statusCeiling !== STATUS_CEILING) p.push('statusCeiling: must be the ADR-0001 status ceiling');
  const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
  if (caps.length !== 8) return [...p, 'capabilities: exactly 8 (ids 1-8 in order)'];
  const ids = new Set();
  caps.forEach((c, i) => {
    const at = `capabilities[${i}]`;
    if (!isObj(c)) return void p.push(`${at}: object`);
    keys(c, at, ['id', 'name', 'release', 'stream', 'evidenceRequired', 'status', 'evidence', 'reportArtifact', 'liveVerification']);
    if (c.id !== i + 1) p.push(`${at}.id: must be ${i + 1}`);
    for (const k of ['name', 'stream', 'evidenceRequired', 'reportArtifact']) need(c, at, k);
    if (!RELEASES.includes(c.release)) p.push(`${at}.release: one of ${RELEASES.join('|')}`);
    if (!DECLARED.includes(c.status)) p.push(`${at}.status: one of ${DECLARED.join('|')}`);
    const live = isObj(c.liveVerification) ? c.liveVerification : {};
    keys(live, `${at}.liveVerification`, ['description', 'status']);
    need(live, `${at}.liveVerification`, 'description');
    if (live.status !== 'scheduled') p.push(`${at}.liveVerification.status: scheduled (live evidence is a signed record, never this manifest)`);
    if (!Array.isArray(c.evidence) || c.evidence.length === 0) return void p.push(`${at}.evidence: at least one item`);
    c.evidence.forEach((e, j) => {
      const ea = `${at}.evidence[${j}]`;
      if (!isObj(e)) return void p.push(`${ea}: object`);
      keys(e, ea, ['id', 'slice', 'kind', 'description', 'status', 'tests']);
      for (const k of ['id', 'slice', 'description']) need(e, ea, k);
      if (text(e.id) && ids.has(e.id)) p.push(`${ea}.id: duplicate item id`);
      ids.add(e.id);
      if (!KINDS.includes(e.kind)) p.push(`${ea}.kind: one of ${KINDS.join('|')}`);
      if (e.status === 'planned') { if (e.tests !== undefined) p.push(`${ea}.tests: a planned item names no test yet`); return; }
      if (e.status !== 'implemented') return void p.push(`${ea}.status: one of planned|implemented`);
      if (!Array.isArray(e.tests) || e.tests.length === 0) return void p.push(`${ea}.tests: an implemented item names at least one test`);
      e.tests.forEach((t, k) => {
        const ta = `${ea}.tests[${k}]`;
        if (!isObj(t)) return void p.push(`${ta}: object`);
        keys(t, ta, ['file', 'suite', 'title']);
        if (!(typeof t.file === 'string' && TEST_FILE.test(t.file))) p.push(`${ta}.file: a repository-relative *.test.{ts,tsx,mjs} path`);
        need(t, ta, 'suite');
        need(t, ta, 'title');
      });
    });
  });
  return p;
}

const implemented = (m) => m.capabilities.flatMap((c) => c.evidence).filter((e) => e.status === 'implemented');
/** The test files the implemented items name, sorted and unique (the targeted vitest run's file filters). */
export const manifestTestFiles = (m) => [...new Set(implemented(m).flatMap((e) => e.tests.map((t) => t.file)))].sort();
const key = (file, suite, title) => `${file}\u0000${suite}\u0000${title}`;

/**
 * vitest's JSON report as file + suite path (" > ") + title -> every status reported under that name. `roots` are
 * the checkout's path spellings (cwd and its realpath); a file outside them is ignored. Null in, null out.
 */
export function indexVitestJson(json, roots) {
  if (!isObj(json)) return null;
  const idx = new Map();
  for (const f of Array.isArray(json.testResults) ? json.testResults : []) {
    const rel = roots.map((r) => path.relative(r, String(f.name ?? ''))).find((x) => x && !x.startsWith('..') && !path.isAbsolute(x));
    if (!rel) continue;
    for (const a of Array.isArray(f.assertionResults) ? f.assertionResults : []) {
      const k = key(rel.split(path.sep).join('/'), (a.ancestorTitles ?? []).join(' > '), a.title);
      idx.set(k, [...(idx.get(k) ?? []), a.status]);
    }
  }
  return idx;
}

function testStatus(index, t) {
  if (!index) return ITEM.NOT_RUN;
  const s = index.get(key(t.file, t.suite, t.title)) ?? [];
  if (s.length === 0) return ITEM.MISSING;
  if (s.includes('failed')) return ITEM.FAILED;
  return s.every((x) => x === 'passed') ? ITEM.PASSED : ITEM.SKIPPED;
}
const ORDER = [ITEM.FAILED, ITEM.MISSING, ITEM.SKIPPED, ITEM.NOT_RUN, ITEM.PASSED];
const worst = (xs) => ORDER.find((s) => xs.includes(s)) ?? ITEM.PASSED;

/** Per capability: each item's status and the capability's, never above "pre-release validated". */
export function capabilityEvidence(m, index, reason = null) {
  const capabilities = m.capabilities.map((c) => {
    const items = c.evidence.map((e) => {
      if (e.status === 'planned') return { id: e.id, slice: e.slice, kind: e.kind, description: e.description, status: ITEM.PLANNED };
      const tests = e.tests.map((t) => ({ ...t, status: testStatus(index, t) }));
      return { id: e.id, slice: e.slice, kind: e.kind, description: e.description, status: worst(tests.map((t) => t.status)), tests };
    });
    const st = items.map((i) => i.status);
    const passing = st.filter((s) => s === ITEM.PASSED).length;
    const planned = st.filter((s) => s === ITEM.PLANNED).length;
    const status = st.some((s) => [ITEM.FAILED, ITEM.MISSING, ITEM.SKIPPED].includes(s)) ? CAP.NOT_VALIDATED
      : st.includes(ITEM.NOT_RUN) ? CAP.NOT_RUN
        : planned > 0 ? CAP[c.status.replace(' ', '_').toUpperCase()]
          : CAP.PRE_RELEASE;
    return {
      id: c.id, name: c.name, release: c.release, evidenceRequired: c.evidenceRequired, declared: c.status, status, items,
      detail: `${passing} of ${items.length} evidence items implemented and passing; ${planned} planned; live verification scheduled (not run by this collector)`,
      reportArtifact: c.reportArtifact, liveVerification: c.liveVerification.description,
    };
  });
  return { ceiling: STATUS_CEILING, run: index ? { available: true } : { available: false, reason }, problems: [], capabilities };
}

const cell = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
/** The evidence.md section (Markdown), from the record the collector stores as `ev.platform`. */
export function renderPlatformEvidenceMd(pe) {
  const L = ['## Platform capability evidence (non-gating)', ''];
  L.push(`Informational only: it never changes a gate, the charter or the exit code. Highest status: "${STATUS_CEILING}". Live verification needs the owner's environment and a signed evidence record.`, '');
  if (!pe.manifest) return [...L, `No ${PLATFORM_MANIFEST} in this checkout.`].join('\n') + '\n';
  if (pe.problems?.length) return [...L, `Manifest invalid (not evaluated): ${cell(pe.problems.join('; '))}`].join('\n') + '\n';
  L.push(`Manifest: \`${pe.manifest}\`. Test results: ${pe.run?.available ? 'the vitest JSON report of the informational check "platform capability tests".' : `${cell(pe.run?.reason ?? 'not available')}.`}`, '');
  L.push('| # | Capability | Release | Owner\'s evidence required | Status | Detail | Live verification |', '|---|---|---|---|---|---|---|');
  for (const c of pe.capabilities) L.push(`| ${c.id} | ${cell(c.name)} | ${c.release} | ${cell(c.evidenceRequired)} | **${c.status}** | ${cell(c.detail)} | ${cell(c.liveVerification)} (scheduled) |`);
  const impl = pe.capabilities.flatMap((c) => c.items.filter((i) => i.tests).map((i) => `- Cap ${c.id} \`${i.id}\` (${i.slice}): ${i.status} — ${i.tests.map((t) => `${cell(t.file)} › ${cell(t.suite)} › ${cell(t.title)}: ${t.status}`).join('; ')}`));
  if (impl.length) L.push('', 'Implemented evidence tests:', '', ...impl);
  return L.join('\n') + '\n';
}
