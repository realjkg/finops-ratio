// Static guarantees of .github/workflows/governance.yml (text-level; the YAML
// itself is parse-validated separately in verification).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { URL } from 'node:url';

const wf = fs.readFileSync(new URL('../../.github/workflows/governance.yml', import.meta.url), 'utf8');
const code = wf.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

describe('governance.yml', () => {
  it('pins every action to a full commit SHA', () => {
    const uses = [...code.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('only uses base-context triggers (no PR-head-controlled workflow)', () => {
    expect(code).toMatch(/^\s{2}pull_request_target:/m);
    expect(code).not.toMatch(/^\s{2}pull_request:/m);
    expect(code).not.toMatch(/^\s{2}pull_request_review:/m);
    expect(code).not.toMatch(/^\s{2}pull_request_review_comment:/m);
  });

  it('never checks out or references the PR head', () => {
    expect(code).not.toMatch(/head\.(sha|ref)|head_ref|refs\/pull/);
    expect(code).not.toMatch(/^\s+ref:/m);
  });

  it('defaults to no permissions and does not persist checkout credentials', () => {
    expect(code).toMatch(/^permissions: \{\}$/m);
    expect((code.match(/persist-credentials: false/g) ?? []).length).toBe((code.match(/actions\/checkout@/g) ?? []).length);
  });

  it('job names match the required checks used by eligibility and branch protection', () => {
    expect(code).toContain('name: Governance · risk classification');
    expect(code).toContain('name: Governance · merge eligibility');
    expect(code).toContain('name: Governance · eligibility targets');
  });

  it('L3: eligibility runs per PR in its own concurrency group; no shared sweep group', () => {
    expect(code).not.toMatch(/sweep/);
    expect(code).toMatch(/group: governance-pr-\$\{\{ matrix\.pr \}\}/);
    expect(code).toMatch(/matrix:\s*\n\s+pr: \$\{\{ fromJSON\(needs\.targets\.outputs\.prs\) \}\}/);
    expect(code).toMatch(/fail-fast: false/);
  });

  it('M1: eligibility can resolve check runs to workflow paths (actions: read)', () => {
    expect(code).toMatch(/actions: read/);
  });

  it('does not interpolate event data into scripts', () => {
    const lines = code.split('\n');
    const blocks = [];
    lines.forEach((l, i) => {
      if (!/script: \|\s*$/.test(l)) return;
      const indent = l.search(/\S/);
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j];
        if (t.trim() && t.search(/\S/) <= indent) break;
        blocks.push(t);
      }
    });
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.join('\n')).not.toMatch(/\$\{\{/);
  });
});
