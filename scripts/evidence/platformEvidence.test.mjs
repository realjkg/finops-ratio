// Platform capability evidence (ADR-0001 §14, slice A0): the manifest's shape and its tie to the owner's evidence
// cells, and the per-capability status rules. Non-gating: a status can only go as high as "pre-release validated",
// a missing, failing or skipped test makes its capability NOT VALIDATED, and nothing here is ever PASS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderEvidenceMd, STATUS } from './evidenceLib.mjs';
import {
  CAP, ITEM, PLATFORM_MANIFEST, STATUS_CEILING, capabilityEvidence, indexVitestJson, manifestProblems, manifestTestFiles, renderPlatformEvidenceMd,
} from './platformEvidence.mjs';
import { SCHEMA_VERSIONS } from '../../src/platform/contracts/versions';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const manifest = () => JSON.parse(read(PLATFORM_MANIFEST));
const clone = (x) => JSON.parse(JSON.stringify(x));

/** The owner's table in ADR-0001 §1.1: | # | Capability | Build next | Evidence required … |. */
function ownerCells() {
  const rows = [...read('docs/adr/ADR-0001-ai-usage-and-gateway-platform.md').matchAll(/^\| ([1-8]) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)];
  return rows.map((m) => ({ id: Number(m[1]), name: m[2].trim(), evidenceRequired: m[4].trim() }));
}

/** ADR-0001 §14: | Cap | Owner's cell | Pre-release tests and fixtures | Report | Live |, split into its fragments. */
function adr14() {
  const sec = read('docs/adr/ADR-0001-ai-usage-and-gateway-platform.md').split('## 14. Evidence plan per capability')[1].split('## 15.')[0];
  return Object.fromEntries([...sec.matchAll(/^\| ([1-8]) \| [^|]+ \| ([^|]+) \|/gm)].map((m) => [Number(m[1]), m[2].trim().split('; ')]));
}

/** A manifest whose capability 1 and 4 each have one implemented test, for the status rules. */
function small() {
  const m = clone(manifest());
  m.capabilities.forEach((c) => { c.evidence = [{ id: `c${c.id}-planned`, slice: 'A2', kind: 'test', description: 'later', status: 'planned' }]; });
  m.capabilities[0].evidence.push({ id: 'c1-impl', slice: 'W0', kind: 'test', description: 'now', status: 'implemented', tests: [{ file: 'src/a.test.ts', suite: 'S', title: 't1' }] });
  m.capabilities[3].status = 'in progress';
  m.capabilities[3].evidence = [{ id: 'c4-impl', slice: 'W0', kind: 'test', description: 'now', status: 'implemented', tests: [{ file: 'src/a.test.ts', suite: 'S', title: 't2' }, { file: 'src/b.test.ts', suite: 'S > inner', title: 't3' }] }];
  return m;
}
const vitestJson = (results) => ({ testResults: Object.entries(results).map(([file, cases]) => ({ name: `/repo/${file}`, assertionResults: cases.map(([anc, title, status]) => ({ ancestorTitles: anc, title, status })) })) });
const byId = (p) => Object.fromEntries(p.capabilities.map((c) => [c.id, c]));

describe('the repository evidence manifest', () => {
  it('is valid and maps capabilities 1-8, in order, to the owner\'s evidence cell verbatim (ADR-0001 §1.1)', () => {
    const m = manifest();
    expect(manifestProblems(m)).toEqual([]);
    expect(m.statusCeiling).toBe(STATUS_CEILING);
    const cells = ownerCells();
    expect(cells.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(m.capabilities.map((c) => ({ id: c.id, name: c.name, evidenceRequired: c.evidenceRequired }))).toEqual(cells);
  });
  it('names each capability\'s release and current status; nothing is validated, supported or live yet', () => {
    const m = manifest();
    expect(m.capabilities.map((c) => [c.id, c.release, c.status])).toEqual([
      [1, '1.1', 'planned'], [2, '1.2', 'not started'], [3, '1.2', 'not started'], [4, '1.1', 'planned'],
      [5, '1.3/2.0', 'not started'], [6, '1.3/2.0', 'not started'], [7, '1.3/2.0', 'not started'], [8, '1.3/2.0', 'not started'],
    ]);
    for (const c of m.capabilities) {
      expect(c.liveVerification.status, `cap ${c.id}`).toBe('scheduled');
      expect(c.evidence.some((e) => e.status === 'planned'), `cap ${c.id} has planned evidence`).toBe(true);
      expect(c.reportArtifact.length, `cap ${c.id}`).toBeGreaterThan(0);
    }
  });
  it('every implemented evidence test exists: its file is in the repository and declares the suite and the test title', () => {
    const tests = manifest().capabilities.flatMap((c) => c.evidence.filter((e) => e.status === 'implemented').flatMap((e) => e.tests));
    expect(tests.length).toBeGreaterThan(0);
    for (const t of tests) {
      const src = read(t.file);
      // Names are matched literally, so they may not contain a quote, a backtick or a backslash (no escaping needed).
      for (const name of [t.title, ...t.suite.split(' > ')]) expect(name, `${t.file}: ${name}`).not.toMatch(/['"`\\]/);
      // Literal, or the golden-corpus template it(`${v}: …`) for one supported schema version.
      const [ver, ...rest] = t.title.split(': ');
      const templated = SCHEMA_VERSIONS.includes(ver) && src.includes(`it(\`\${v}: ${rest.join(': ')}\``);
      expect(src.includes(`it('${t.title}'`) || templated, `${t.file}: ${t.title}`).toBe(true);
      for (const s of t.suite.split(' > ')) expect(src, `${t.file}: ${s}`).toContain(`describe('${s}'`);
    }
    expect(manifestTestFiles(manifest())).toEqual([...new Set(tests.map((t) => t.file))].sort());
  });
  it('pins the ADR-0001 §14 pre-release evidence per capability: every fragment is covered, nothing else is claimed', () => {
    const cells = adr14();
    expect(Object.keys(cells).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const c of manifest().capabilities) {
      const covers = c.evidence.map((e) => e.covers).filter((x) => x !== null);
      expect([...new Set(covers)].sort(), `cap ${c.id}`).toEqual([...cells[c.id]].sort());
      // "(this PR)" fragments are the wave-0 contract tests: implemented now, on slice W0; everything else is planned.
      for (const e of c.evidence.filter((x) => x.covers !== null)) expect([e.covers, e.status, e.slice === 'W0'], e.id).toEqual([e.covers, e.covers.endsWith('(this PR)') ? 'implemented' : 'planned', e.covers.endsWith('(this PR)')]);
    }
  });
});

describe('manifest rules', () => {
  const problem = (edit) => { const m = clone(manifest()); edit(m); return manifestProblems(m); };
  it('a capability may only be planned, not started or in progress: no claim beyond that is accepted', () => {
    for (const s of ['validated', 'pre-release validated', 'enterprise supported', 'connected', 'live verified', 'protected', 'PASS']) {
      expect(problem((m) => { m.capabilities[0].status = s; }), s).toEqual(['capabilities[0].status: one of not started|planned|in progress']);
    }
    expect(problem((m) => { m.capabilities[0].liveVerification.status = 'verified'; })).toEqual(['capabilities[0].liveVerification.status: scheduled (live evidence is a signed record, never this manifest)']);
    expect(problem((m) => { m.statusCeiling = 'enterprise supported'; })).toEqual(['statusCeiling: must be the ADR-0001 status ceiling']);
  });
  it('exactly capabilities 1-8 in order, each with its owner cell, release and evidence', () => {
    expect(problem((m) => { m.capabilities.pop(); })).toEqual(['capabilities: exactly 8 (ids 1-8 in order)']);
    expect(problem((m) => { m.capabilities[1].id = 3; })).toEqual(['capabilities[1].id: must be 2']);
    expect(problem((m) => { m.capabilities[2].evidenceRequired = ''; })).toEqual(['capabilities[2].evidenceRequired: non-empty text']);
    expect(problem((m) => { m.capabilities[2].release = '1.0'; })).toEqual(['capabilities[2].release: one of 1.1|1.2|1.3|1.3/2.0|2.0']);
    expect(problem((m) => { m.capabilities[0].evidence = []; })).toEqual(['capabilities[0].evidence: at least one item']);
    expect(problem((m) => { m.capabilities[0].extra = 1; })).toEqual(['capabilities[0].extra: unknown key']);
    expect(problem((m) => { delete m.schema; })).toEqual(['schema: must be ratio.platform-evidence-manifest/1']);
  });
  it('an implemented item names real test files; a planned item names none; item ids are unique', () => {
    const item = (m) => m.capabilities[0].evidence[0];
    expect(problem((m) => { Object.assign(item(m), { status: 'implemented' }); delete item(m).tests; })).toEqual(['capabilities[0].evidence[0].tests: an implemented item names at least one test']);
    expect(problem((m) => { Object.assign(item(m), { status: 'planned', tests: [{ file: 'src/a.test.ts', suite: 'S', title: 't' }] }); })).toEqual(['capabilities[0].evidence[0].tests: a planned item names no test yet']);
    // Option-like and hidden paths too (review M1): '--update.test.ts' would make vitest rewrite snapshots.
    for (const file of ['../etc/a.test.ts', '/abs/a.test.ts', 'src/a.ts', 'src/a b.test.ts', '-u.test.ts', '--update.test.ts', '--watch.test.ts', '-w.test.ts',
      '--root.test.ts', '--config=x.test.ts', 'src/x/-u.test.ts', '.test.ts', './.test.ts', 'src//a.test.ts', 'src/./a.test.ts', 'node_modules/x/a.test.ts', '.git/hooks/a.test.mjs', 'src/a.test.ts/']) {
      expect(problem((m) => { Object.assign(item(m), { status: 'implemented', tests: [{ file, suite: 'S', title: 't' }] }); }), file).toEqual(['capabilities[0].evidence[0].tests[0].file: a repository-relative *.test.{ts,tsx,mjs} path whose segments start with a letter, digit or underscore']);
    }
    expect(problem((m) => { Object.assign(item(m), { status: 'implemented', tests: [{ file: 'src/a.test.ts', suite: '', title: 't' }] }); })).toEqual(['capabilities[0].evidence[0].tests[0].suite: non-empty text']);
    expect(problem((m) => { m.capabilities[1].evidence[0].id = item(m).id; })).toEqual(['capabilities[1].evidence[0].id: duplicate item id']);
    expect(problem((m) => { item(m).status = 'done'; })).toEqual(['capabilities[0].evidence[0].status: one of planned|implemented']);
    expect(problem((m) => { item(m).kind = 'vibe'; })).toEqual(['capabilities[0].evidence[0].kind: one of test|fixture|report|document']);
  });
  it('free text carries no line breaks, control characters or status words, so it can never read as a result (review L1)', () => {
    for (const bad of ['**PASS**', 'PASS', 'PASSED', 'NOT VALIDATED', 'PRE-RELEASE VALIDATED', 'LIVE VERIFIED', 'Enterprise Supported', 'enterprise-supported', 'a\r\n## Charter', 'x\ty', '__bold__']) {
      expect(problem((m) => { m.capabilities[1].evidence[0].description = bad; }), bad).toEqual(['capabilities[1].evidence[0].description: plain text without line breaks, control characters, emphasis markers or status words']);
      expect(problem((m) => { m.capabilities[0].evidence[0].tests[0].title = bad; }), bad).toEqual(['capabilities[0].evidence[0].tests[0].title: plain text without line breaks, control characters, emphasis markers or status words']);
    }
    expect(problem((m) => { m.capabilities[4].name = 'Inspect prompts — ENTERPRISE SUPPORTED'; })).toEqual(['capabilities[4].name: plain text without line breaks, control characters, emphasis markers or status words']);
    // The owner's own wording stays valid ("in supported scenarios", "passed", lower case).
    expect(problem((m) => { m.capabilities[0].evidence[0].description = 'checks run in supported scenarios and passed'; })).toEqual([]);
  });
  it('a non-object manifest is one problem, not a crash', () => {
    expect(manifestProblems(null)).toEqual(['manifest: must be a JSON object']);
    expect(manifestProblems([])).toEqual(['manifest: must be a JSON object']);
  });
});

describe('vitest JSON index', () => {
  it('keys each result by repository-relative file, suite path (" > ") and title; files outside the checkout are ignored', () => {
    const idx = indexVitestJson({ testResults: [
      { name: '/repo/src/a.test.ts', assertionResults: [{ ancestorTitles: ['S'], title: 't1', status: 'passed' }, { ancestorTitles: ['S'], title: 't1', status: 'failed' }] },
      { name: '/real/repo/src/b.test.ts', assertionResults: [{ ancestorTitles: ['S', 'inner'], title: 't3', status: 'passed' }] },
      { name: '/elsewhere/src/a.test.ts', assertionResults: [{ ancestorTitles: ['S'], title: 't9', status: 'passed' }] },
    ] }, ['/repo', '/real/repo']);
    expect([...idx.entries()]).toEqual([
      ['src/a.test.ts\u0000S\u0000t1', ['passed', 'failed']],
      ['src/b.test.ts\u0000S > inner\u0000t3', ['passed']],
    ]);
    expect(indexVitestJson({}, ['/repo']).size).toBe(0);
    expect(indexVitestJson(null, ['/repo'])).toBe(null);
  });
});

describe('capability status rules', () => {
  it('without test results, implemented items are NOT RUN and planned-only capabilities keep their declared status', () => {
    const p = capabilityEvidence(small(), null, 'no vitest JSON (the run did not happen)');
    const c = byId(p);
    expect(c[1].status).toBe(CAP.NOT_RUN);
    expect(c[1].items.map((i) => i.status)).toEqual([ITEM.PLANNED, ITEM.NOT_RUN]);
    expect(c[2].status).toBe(CAP.NOT_STARTED);
    expect(c[4].status).toBe(CAP.NOT_RUN);
    expect(p.run).toEqual({ available: false, reason: 'no vitest JSON (the run did not happen)' });
  });
  it('a missing, failing or skipped test makes its capability NOT VALIDATED', () => {
    const ok = { 'src/a.test.ts': [[['S'], 't1', 'passed'], [['S'], 't2', 'passed']], 'src/b.test.ts': [[['S', 'inner'], 't3', 'passed']] };
    const run = (r) => byId(capabilityEvidence(small(), indexVitestJson(vitestJson(r), ['/repo'])));
    expect(run(ok)[4].status).toBe(CAP.PRE_RELEASE);
    const missing = run({ ...ok, 'src/b.test.ts': [] })[4];
    expect([missing.status, missing.items[0].status, missing.items[0].tests[1].status]).toEqual([CAP.NOT_VALIDATED, ITEM.MISSING, ITEM.MISSING]);
    const failing = run({ ...ok, 'src/a.test.ts': [[['S'], 't1', 'passed'], [['S'], 't2', 'failed']] })[4];
    expect([failing.status, failing.items[0].status]).toEqual([CAP.NOT_VALIDATED, ITEM.FAILED]);
    for (const s of ['skipped', 'pending', 'todo']) {
      const skipped = run({ ...ok, 'src/b.test.ts': [[['S', 'inner'], 't3', s]] })[4];
      expect([skipped.status, skipped.items[0].status], s).toEqual([CAP.NOT_VALIDATED, ITEM.SKIPPED]);
    }
    const dup = run({ ...ok, 'src/a.test.ts': [[['S'], 't1', 'passed'], [['S'], 't2', 'passed'], [['S'], 't2', 'failed']] })[4];
    expect([dup.status, dup.items[0].status, dup.items[0].tests[0].status]).toEqual([CAP.NOT_VALIDATED, ITEM.FAILED, ITEM.FAILED]); // one failing attempt is FAILED (review L3, M2)
    const mixed = run({ ...ok, 'src/a.test.ts': [[['S'], 't1', 'passed'], [['S'], 't2', 'skipped'], [['S'], 't2', 'failed']] })[4];
    expect(mixed.items[0].tests[0].status).toBe(ITEM.FAILED);
    const wrongSuite = run({ ...ok, 'src/b.test.ts': [[['S'], 't3', 'passed']] })[4];
    expect(wrongSuite.status).toBe(CAP.NOT_VALIDATED);
    expect(run({ ...ok, 'src/a.test.ts': [[['S'], 't1', 'failed'], [['S'], 't2', 'passed']] })[1].status).toBe(CAP.NOT_VALIDATED);
  });
  it('passing tests with planned evidence left keep the declared status; only complete, passing evidence reaches the ceiling', () => {
    const p = capabilityEvidence(small(), indexVitestJson(vitestJson({ 'src/a.test.ts': [[['S'], 't1', 'passed'], [['S'], 't2', 'passed']], 'src/b.test.ts': [[['S', 'inner'], 't3', 'passed']] }), ['/repo']));
    const c = byId(p);
    expect(c[1].status).toBe(CAP.PLANNED);
    expect(c[1].detail).toBe('1 of 2 evidence items implemented and passing; 1 planned; live verification scheduled (not run by this collector)');
    expect(c[4].status).toBe(CAP.PRE_RELEASE);
    expect(c[4].detail).toBe('1 of 1 evidence items implemented and passing; 0 planned; live verification scheduled (not run by this collector)');
    const computed = JSON.stringify(p.capabilities.map((x) => [x.status, x.detail, x.items.map((i) => [i.status, (i.tests ?? []).map((t) => t.status)])]));
    expect(computed).not.toMatch(/"PASS"|enterprise|supported|live verified|connected/i);
    expect(p.ceiling).toBe(STATUS_CEILING);
  });
  it('the declared status is a cap: complete, passing evidence reaches the ceiling only when the manifest says "in progress" (review L2)', () => {
    const m = small();
    m.capabilities[3].status = 'planned';
    const all = vitestJson({ 'src/a.test.ts': [[['S'], 't1', 'passed'], [['S'], 't2', 'passed']], 'src/b.test.ts': [[['S', 'inner'], 't3', 'passed']] });
    expect(byId(capabilityEvidence(m, indexVitestJson(all, ['/repo'])))[4].status).toBe(CAP.PLANNED);
    m.capabilities[3].status = 'not started';
    expect(byId(capabilityEvidence(m, indexVitestJson(all, ['/repo'])))[4].status).toBe(CAP.NOT_STARTED);
    m.capabilities[3].status = 'in progress';
    expect(byId(capabilityEvidence(m, indexVitestJson(all, ['/repo'])))[4].status).toBe(CAP.PRE_RELEASE);
  });
  it('a malformed vitest report is indexed defensively: odd entries are skipped, never a crash', () => {
    for (const j of [{ testResults: [null] }, { testResults: [{ name: '/repo/a.test.ts', assertionResults: [null] }] }, { testResults: 'x' }, { testResults: [{ name: {}, assertionResults: [] }] },
      { testResults: [{ name: '/repo/src/a.test.ts', assertionResults: [{ ancestorTitles: 'S', title: 't', status: 'passed' }, { ancestorTitles: ['S'], title: { toString: () => 't' }, status: 'passed' }, { ancestorTitles: ['S'], title: 't', status: 7 }] }] }]) {
      expect(() => indexVitestJson(j, ['/repo']), JSON.stringify(j)).not.toThrow();
      expect(indexVitestJson(j, ['/repo']).size, JSON.stringify(j)).toBe(0);
    }
  });
  it('the repository manifest today: no capability is above its declared status', () => {
    const files = manifestTestFiles(manifest());
    const passing = { testResults: files.map((f) => ({ name: path.join(ROOT, f), assertionResults: manifest().capabilities.flatMap((c) => c.evidence).filter((e) => e.status === 'implemented').flatMap((e) => e.tests).filter((t) => t.file === f).map((t) => ({ ancestorTitles: t.suite.split(' > '), title: t.title, status: 'passed' })) })) };
    const p = capabilityEvidence(manifest(), indexVitestJson(passing, [ROOT]));
    expect(p.capabilities.map((c) => c.status)).toEqual([CAP.PLANNED, CAP.NOT_STARTED, CAP.NOT_STARTED, CAP.PLANNED, CAP.NOT_STARTED, CAP.NOT_STARTED, CAP.NOT_STARTED, CAP.NOT_STARTED]);
  });
});

describe('report section', () => {
  const evidence = () => capabilityEvidence(small(), null, 'NOT RUN: reason');
  it('renders one row per capability with the owner cell and the status, marked non-gating, never PASS', () => {
    const md = renderPlatformEvidenceMd({ manifest: PLATFORM_MANIFEST, ...evidence() });
    expect(md).toMatch(/^## Platform capability evidence \(non-gating\)$/m);
    expect(md).toContain(STATUS_CEILING);
    expect(md).toContain('Test results: NOT RUN: reason.');
    expect(md).toMatch(/^\| 1 \| Track model spending \| 1\.1 \| Approved-source imports reconcile; unmatched charges and allocation gaps remain visible \| \*\*NOT RUN\*\* \|/m);
    expect(md).toMatch(/^\| 2 \| Measure adoption \| 1\.2 \| .* \| \*\*NOT STARTED\*\* \|/m);
    expect(md).not.toMatch(/\*\*PASS\*\*/);
    expect(md).toContain('`c4-impl` (W0): NOT RUN');
  });
  it('untrusted text is escaped: a crafted name or title cannot render bold, a heading, a table row or a raw tag (review L1)', () => {
    const m = small();
    m.capabilities[1].name = 'a*b*c_d_ <b>x</b> [l](u) `c` | e & f';
    const md = renderPlatformEvidenceMd({ manifest: PLATFORM_MANIFEST, ...capabilityEvidence(m, null, 'r') });
    const row = md.split('\n').find((l) => l.startsWith('| 2 |'));
    expect(row).toContain('a\\*b\\*c\\_d\\_ \\<b\\>x\\</b\\> \\[l\\](u) \\`c\\` \\| e \\& f');
    expect(row.split(' | ').length).toBe(7);
  });
  it('an invalid or absent manifest is reported as such', () => {
    expect(renderPlatformEvidenceMd({ manifest: PLATFORM_MANIFEST, problems: ['schema: x'], capabilities: [] })).toContain('Manifest invalid (not evaluated): schema: x');
    expect(renderPlatformEvidenceMd({ manifest: null, problems: [], capabilities: [] })).toContain(`No ${PLATFORM_MANIFEST} in this checkout.`);
  });
  it('evidence.md carries the section when the collector recorded it, and is unchanged without it', () => {
    const ev = {
      pr: 1, command: 'c', generatedAt: 'T', head: { sha: 'h'.repeat(40), tree: 't' }, base: { ref: 'main', sha: 'm'.repeat(40), tree: 't' }, mergeBase: { sha: 'm'.repeat(40), tree: 't' },
      env: { node: 'v22', npm: '10', os: 'linux' }, charter: [], gates: [], fixtures: { files: [], determinism: [] },
      rollback: { status: STATUS.PASS, procedure: 'p', detail: 'd', production: 'r' }, knownGaps: [],
    };
    expect(renderEvidenceMd(ev)).not.toContain('Platform capability evidence');
    const md = renderEvidenceMd({ ...ev, platform: { manifest: PLATFORM_MANIFEST, ...evidence() } });
    expect(md).toContain('## Platform capability evidence (non-gating)');
    expect(md.indexOf('## Platform capability evidence')).toBeLessThan(md.indexOf('## Known gaps'));
  });
  it('evidence.md ends with exactly one newline, so the committed evidence passes git diff --check', () => {
    const ev = {
      pr: 1, command: 'c', generatedAt: 'T', head: { sha: 'h'.repeat(40), tree: 't' }, base: { ref: 'main', sha: 'm'.repeat(40), tree: 't' }, mergeBase: { sha: 'm'.repeat(40), tree: 't' },
      env: { node: 'v22', npm: '10', os: 'linux' }, charter: [], fixtures: { files: [], determinism: [] },
      gates: [{ name: 'unit', command: 'npx vitest', status: STATUS.PASS, exitCode: 0, durationSec: 1, summary: 'ok', tail: 'last line' }],
      rollback: { status: STATUS.PASS, procedure: 'p', detail: 'd', production: 'r' }, knownGaps: [],
    };
    for (const e of [ev, { ...ev, platform: { manifest: PLATFORM_MANIFEST, ...evidence() } }]) {
      const md = renderEvidenceMd(e);
      expect(md.endsWith('\n')).toBe(true);
      expect(md.endsWith('\n\n')).toBe(false);
      expect(md).not.toMatch(/[ \t]$/m);
    }
  });
});
