// Tests for the PR risk classifier (governance track).
// Written before the implementation; every restricted class, the fail-closed
// default, the self-protection rule and the low-risk allow-list are covered.
import { describe, it, expect } from 'vitest';
import process from 'node:process';
import { URL } from 'node:url';
import { classify, globToRegExp, parseUnifiedDiff, binaryPathsInDiff, loadRules } from './classify-risk.mjs';

const paths = (...p) => ({ files: p.map((path) => ({ path })) });
const withPatch = (path, ...added) => ({
  files: [{ path, patch: added.map((l) => `+${l}`).join('\n') }],
});
const classesOf = (r) => r.classes;

describe('globToRegExp', () => {
  it('matches ** across directories and * within one segment', () => {
    expect(globToRegExp('src/costsource/**').test('src/costsource/a/b.ts')).toBe(true);
    expect(globToRegExp('src/lib/forecast*').test('src/lib/forecast.ts')).toBe(true);
    expect(globToRegExp('src/lib/forecast*').test('src/lib/x/forecast.ts')).toBe(false);
    expect(globToRegExp('**/migrations/**').test('src/ingest/db/migrations/0001_x.up.sql')).toBe(true);
    expect(globToRegExp('**/migrations/**').test('migrations/0001.sql')).toBe(true);
    expect(globToRegExp('**/*.test.{ts,tsx}').test('src/a.test.tsx')).toBe(true);
    expect(globToRegExp('**/*.test.{ts,tsx}').test('src/a.test.js')).toBe(false);
  });
});

describe('restricted classes — path rules', () => {
  const cases = [
    ['migrations', 'src/ingest/db/migrations/0001_init.up.sql'],
    ['migrations', 'db/seed.sql'],
    ['auth_tenancy', 'src/server/gateway/withGateway.ts'],
    ['auth_tenancy', 'src/lib/tenantContext.ts'],
    ['auth_tenancy', 'pages/api/v1/auth/login.ts'],
    ['auth_tenancy', 'src/server/rlsPolicy.ts'],
    ['auth_tenancy', 'src/types/Role.ts'],
    ['secrets', '.env'],
    ['secrets', '.env.local'],
    ['secrets', '.env.example'],
    ['network_egress', 'src/costsource/transports/http.ts'],
    ['retention', 'src/jobs/purgeOldRuns.ts'],
    ['retention', 'docs/retention-policy.md'],
    ['deployment', '.github/workflows/ci.yml'],
    ['deployment', '.github/dependabot.yml'],
    ['deployment', 'Dockerfile'],
    ['deployment', 'Dockerfile.worker'],
    ['deployment', 'docker-compose.yml'],
    ['deployment', 'next.config.js'],
    ['deployment', 'wrangler.toml'],
    ['financial_semantics', 'src/costsource/normalize.ts'],
    ['financial_semantics', 'src/ingest/worker.ts'],
    ['financial_semantics', 'src/lib/forecast.ts'],
    ['financial_semantics', 'src/lib/budgetStatus.ts'],
    ['financial_semantics', 'src/findings/recommendationMath.ts'],
    ['financial_semantics', 'src/connectors/focusMapping.ts'],
    ['financial_semantics', 'pages/api/v1/reconcile.ts'],
    ['financial_semantics', 'src/lib/normalizeCurrency.ts'],
    ['dependencies', 'package.json'],
    ['dependencies', 'package-lock.json'],
    ['policy', '.obvious/obvious.md'],
  ];
  for (const [cls, p] of cases) {
    it(`${p} → restricted:${cls}`, () => {
      const r = classify(paths(p));
      expect(r.risk).toBe('restricted');
      expect(classesOf(r)).toContain(cls);
      const reason = r.reasons.find((x) => x.class === cls);
      expect(reason).toBeDefined();
      expect(reason.path).toBe(p);
      expect(typeof reason.rule).toBe('string');
      expect(reason.rule.length).toBeGreaterThan(0);
    });
  }
});

describe('restricted classes — diff content rules (added lines only)', () => {
  it('AWS access key id in an added line → secrets', () => {
    const r = classify(withPatch('README.md', 'key: AKIAIOSFODNN7EXAMPLE'));
    expect(r.risk).toBe('restricted');
    expect(classesOf(r)).toContain('secrets');
  });
  it('PEM header → secrets', () => {
    const r = classify(withPatch('docs/setup.md', '-----BEGIN RSA PRIVATE KEY-----'));
    expect(classesOf(r)).toContain('secrets');
  });
  it('password= → secrets', () => {
    const r = classify(withPatch('docs/setup.md', 'DATABASE password=hunter2'));
    expect(classesOf(r)).toContain('secrets');
  });
  it('added fetch( in src/ → network_egress', () => {
    const r = classify(withPatch('src/components/Widget.tsx', "  const r = await fetch('/api/x');"));
    expect(r.risk).toBe('restricted');
    expect(classesOf(r)).toContain('network_egress');
  });
  it('new URL in src/ → network_egress', () => {
    const r = classify(withPatch('src/components/Link.tsx', "const u = 'https://api.example.com/v1';"));
    expect(classesOf(r)).toContain('network_egress');
  });
  it('new URL in pages/ → network_egress', () => {
    const r = classify(withPatch('pages/about.test.tsx', "const u = 'http://10.0.0.1:8080';"));
    expect(classesOf(r)).toContain('network_egress');
  });
  it('fetch( in docs is not network egress', () => {
    const r = classify(withPatch('docs/guide.md', 'call fetch() then https://example.com'));
    expect(classesOf(r)).not.toContain('network_egress');
    expect(r.risk).toBe('low');
  });
  it('DELETE FROM / DROP TABLE / purge in diff → retention', () => {
    expect(classesOf(classify(withPatch('src/components/A.tsx', '// DELETE FROM x')))).toContain('retention');
    expect(classesOf(classify(withPatch('src/components/A.tsx', '// DROP TABLE x')))).toContain('retention');
    expect(classesOf(classify(withPatch('docs/a.md', 'we purge after 30 days')))).toContain('retention');
  });
  it('UI drag-and-drop wording is not retention', () => {
    expect(classify(withPatch('src/components/A.tsx', '<p>drag and drop</p>')).risk).toBe('low');
  });
  it('removed lines do not trigger content rules', () => {
    const r = classify({ files: [{ path: 'docs/a.md', patch: '-password=old\n context' }] });
    expect(r.risk).toBe('low');
  });
  it('a unified diff string is attributed to the right files', () => {
    const diff = [
      'diff --git a/docs/a.md b/docs/a.md',
      '--- a/docs/a.md',
      '+++ b/docs/a.md',
      '@@ -1 +1,2 @@',
      ' hi',
      '+fine text',
      'diff --git a/src/components/B.tsx b/src/components/B.tsx',
      '--- a/src/components/B.tsx',
      '+++ b/src/components/B.tsx',
      '@@ -1 +1,2 @@',
      '+fetch("/x")',
    ].join('\n');
    const parsed = parseUnifiedDiff(diff);
    expect(Object.keys(parsed).sort()).toEqual(['docs/a.md', 'src/components/B.tsx']);
    expect(parsed['docs/a.md']).toEqual(['fine text']);
    const r = classify({ files: [{ path: 'docs/a.md' }, { path: 'src/components/B.tsx' }], diff });
    expect(r.reasons).toEqual([
      expect.objectContaining({ path: 'src/components/B.tsx', class: 'network_egress' }),
    ]);
  });
});

describe('self-protection', () => {
  it('any change to scripts/governance/** is restricted:deployment', () => {
    for (const p of [
      'scripts/governance/classify-risk.mjs',
      'scripts/governance/risk-rules.json',
      'scripts/governance/classify-risk.test.mjs',
      'scripts/governance/README.md',
    ]) {
      const r = classify(paths(p));
      expect(r.risk, p).toBe('restricted');
      expect(classesOf(r), p).toContain('deployment');
    }
  });
  it('the governance workflow itself is restricted', () => {
    expect(classify(paths('.github/workflows/governance.yml')).risk).toBe('restricted');
  });
});

describe('fail-closed default', () => {
  it('unknown production path → restricted:unclassified', () => {
    const r = classify(paths('src/lib/format.ts'));
    expect(r.risk).toBe('restricted');
    expect(classesOf(r)).toEqual(['unclassified']);
    expect(r.reasons[0]).toMatchObject({ path: 'src/lib/format.ts', class: 'unclassified' });
  });
  it('unknown root file → restricted', () => {
    expect(classify(paths('token-budget-estimator.html')).risk).toBe('restricted');
    expect(classify(paths('tailwind.config.js')).risk).toBe('restricted');
  });
  it('empty change set → restricted', () => {
    const r = classify({ files: [] });
    expect(r.risk).toBe('restricted');
    expect(classesOf(r)).toEqual(['unclassified']);
  });
  it('a low path whose diff could not be inspected is restricted', () => {
    const r = classify({ files: [{ path: 'README.md', patchUnavailable: true }] });
    expect(r.risk).toBe('restricted');
    expect(r.reasons[0]).toMatchObject({ path: 'README.md', class: 'unclassified', rule: 'diff-unavailable' });
  });
  it('a truncated file list is restricted', () => {
    const r = classify({ files: [{ path: 'README.md' }], truncated: true });
    expect(r.risk).toBe('restricted');
    expect(r.reasons).toContainEqual(expect.objectContaining({ rule: 'file-list-truncated' }));
  });
  it('renamed file is classified by its previous path too', () => {
    const r = classify({ files: [{ path: 'docs/moved.md', previousPath: 'src/lib/forecast.ts' }] });
    expect(r.risk).toBe('restricted');
    expect(classesOf(r)).toContain('financial_semantics');
  });
  it('restricted rules win over the low allow-list (tests under financial code)', () => {
    const r = classify(paths('src/costsource/costsource.test.ts'));
    expect(r.risk).toBe('restricted');
    expect(classesOf(r)).toContain('financial_semantics');
  });
});

describe('low-risk examples', () => {
  it('README-only', () => {
    expect(classify(paths('README.md'))).toEqual({ risk: 'low', classes: [], reasons: [] });
  });
  it('docs/** markdown and images (images only when the diff is viewable)', () => {
    expect(classify(paths('docs/guide/setup.md')).risk).toBe('low');
    expect(classify(paths('docs/architecture/overview.png')).risk).toBe('low');
    expect(classify(paths('docs/architecture/overview.svg')).risk).toBe('low');
  });
  it('UI component without egress', () => {
    const r = classify(withPatch('src/components/layout/Header.tsx', '<h1>Hello</h1>'));
    expect(r.risk).toBe('low');
  });
  it('tests-only change', () => {
    expect(classify(paths('src/lib/persona.test.ts', 'src/lib/basePath.test.ts')).risk).toBe('low');
  });
});

describe('challenger round 1 regressions', () => {
  // H1: Next builds pages/**/*.test.* into a production route.
  it('H1: the exact probe pages/api/zzgovprobe.test.ts is restricted:routes', () => {
    const r = classify(paths('pages/api/zzgovprobe.test.ts'));
    expect(r.risk).toBe('restricted');
    expect(r.classes).toContain('routes');
  });
  for (const p of ['pages/index.tsx', 'pages/x.test.tsx', 'src/pages/a.test.ts', 'src/pages/index.tsx', 'pages/README.md']) {
    it(`H1: ${p} is restricted:routes`, () => {
      const r = classify(paths(p));
      expect(r.risk).toBe('restricted');
      expect(r.classes).toContain('routes');
    });
  }
  it('H1: the low test allow-list excludes pages/ even without the routes rule', () => {
    const rules = loadRules();
    const lowTests = rules.low.find((l) => l.id === 'low.tests');
    expect(lowTests.matchPath('pages/api/zzgovprobe.test.ts')).toBe(false);
    expect(lowTests.matchPath('src/pages/a.test.ts')).toBe(false);
    expect(lowTests.matchPath('src/lib/a.test.ts')).toBe(true);
  });

  // H2: binary files outside docs/ are restricted; binary diffs are uninspectable.
  for (const p of ['src/components/logo.png', 'src/components/font.woff2', 'public/x.bin', 'docs/spec.pdf', 'docs/a.zip']) {
    it(`H2: ${p} is restricted`, () => {
      expect(classify(paths(p)).risk).toBe('restricted');
    });
  }
  it('H2: a binary file in a git diff is treated as uninspectable (fail closed)', () => {
    const diff = [
      'diff --git a/docs/a.png b/docs/a.png',
      'new file mode 100644',
      'index 0000000..1111111',
      'Binary files /dev/null and b/docs/a.png differ',
      'diff --git a/src/components/X.tsx b/src/components/X.tsx',
      'index 1..2 100644',
      'GIT binary patch',
      'literal 10',
    ].join('\n');
    expect(binaryPathsInDiff(diff).sort()).toEqual(['docs/a.png', 'src/components/X.tsx']);
    const r = classify({ files: [{ path: 'docs/a.png' }, { path: 'src/components/X.tsx' }], diff });
    expect(r.risk).toBe('restricted');
    expect(r.reasons).toEqual([
      { path: 'docs/a.png', class: 'unclassified', rule: 'diff-unavailable' },
      { path: 'src/components/X.tsx', class: 'unclassified', rule: 'diff-unavailable' },
    ]);
  });

  // M3: agent/policy instruction files are restricted.
  for (const p of ['.obvious/skills/local-dev/SKILL.md', '.obvious/config.yml', '.claude/settings.json', 'CLAUDE.md', 'AGENTS.md', 'src/x/CLAUDE.md', 'docs/skills/foo/SKILL.md']) {
    it(`M3: ${p} is restricted:policy`, () => {
      const r = classify(paths(p));
      expect(r.risk).toBe('restricted');
      expect(r.classes).toContain('policy');
    });
  }
  it('M3: docs/** is narrowed to md/png/svg', () => {
    expect(classify(paths('docs/run.sh')).risk).toBe('restricted');
    expect(classify(paths('docs/data.json')).risk).toBe('restricted');
  });
  for (const line of [
    "navigator.sendBeacon('/x', d)",
    'const ws = new WebSocket(u)',
    'const x = new XMLHttpRequest()',
    'new EventSource(u)',
    "const m = await import('./x')",
    "const u = '//cdn.example.net/a.js'",
    'const u = "//cdn.example.net/a.js"',
  ]) {
    it(`M3: egress pattern in src/ → network_egress: ${line}`, () => {
      const r = classify(withPatch('src/components/W.tsx', line));
      expect(r.risk).toBe('restricted');
      expect(r.classes).toContain('network_egress');
    });
  }
});

describe('mixed PR', () => {
  it('README + migration → restricted, only the migration is a reason', () => {
    const r = classify(paths('README.md', 'src/ingest/db/migrations/0002_x.up.sql'));
    expect(r.risk).toBe('restricted');
    expect(r.reasons.every((x) => x.path !== 'README.md')).toBe(true);
    expect(classesOf(r)).toEqual(['financial_semantics', 'migrations']);
  });
  it('tests + production code → production code is classified', () => {
    const r = classify(paths('src/lib/persona.test.ts', 'src/lib/persona.ts'));
    expect(r.risk).toBe('restricted');
    expect(r.reasons).toEqual([{ path: 'src/lib/persona.ts', class: 'unclassified', rule: 'fail-closed-default' }]);
  });
  it('classes are sorted and unique', () => {
    const r = classify(paths('package.json', 'package-lock.json', '.github/workflows/ci.yml'));
    expect(r.classes).toEqual(['dependencies', 'deployment']);
  });
});

describe('CLI', () => {
  it('prints JSON for positional paths and a diff file', async () => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const cli = fileURLToPath(new URL('./classify-risk.mjs', import.meta.url));
    const low = spawnSync(process.execPath, [cli, 'README.md'], { encoding: 'utf8' });
    expect(low.status).toBe(0);
    expect(JSON.parse(low.stdout)).toEqual({ risk: 'low', classes: [], reasons: [] });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-'));
    const diffFile = path.join(dir, 'd.patch');
    fs.writeFileSync(diffFile, 'diff --git a/README.md b/README.md\n+++ b/README.md\n+password=x\n');
    const r = spawnSync(process.execPath, [cli, '--diff-file', diffFile, 'README.md'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).classes).toEqual(['secrets']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('rules file', () => {
  it('is data-driven and declares every required class', () => {
    const rules = loadRules();
    const declared = new Set(rules.restricted.map((r) => r.class));
    for (const c of [
      'migrations', 'auth_tenancy', 'secrets', 'network_egress', 'retention',
      'deployment', 'financial_semantics', 'dependencies', 'policy', 'routes',
    ]) expect(declared.has(c), c).toBe(true);
    for (const r of rules.restricted) {
      expect(typeof r.id).toBe('string');
      expect(['path-glob', 'path-regex', 'added-line-regex']).toContain(r.kind);
    }
  });
});
