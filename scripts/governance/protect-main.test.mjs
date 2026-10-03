// Branch-protection payload builder + CLI safety (never calls GitHub in tests).
import { describe, it, expect } from 'vitest';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRequests } from './protect-main.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, 'protect-main.mjs');

function run(args, env = {}) {
  const cleanEnv = { PATH: process.env.PATH, ...env };
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: cleanEnv });
}

describe('buildRequests', () => {
  const reqs = buildRequests({ repo: 'o/r', branch: 'main' });

  it('PUTs branch protection with PR, required checks, conversation resolution, no force-push/deletion', () => {
    const p = reqs.find((r) => r.path === '/repos/o/r/branches/main/protection');
    expect(p.method).toBe('PUT');
    expect(p.body.required_status_checks).toEqual({
      strict: true,
      checks: [
        { context: 'Lint · Typecheck · Test · Build' },
        { context: 'Governance · risk classification' },
      ],
    });
    expect(p.body.required_pull_request_reviews).toMatchObject({ required_approving_review_count: 0 });
    expect(p.body.required_conversation_resolution).toBe(true);
    expect(p.body.allow_force_pushes).toBe(false);
    expect(p.body.allow_deletions).toBe(false);
    expect(p.body.enforce_admins).toBe(true);
    expect(p.body.restrictions).toBeNull();
  });

  it('PATCHes the repo to allow auto-merge (squash)', () => {
    const p = reqs.find((r) => r.path === '/repos/o/r');
    expect(p.method).toBe('PATCH');
    expect(p.body).toEqual({ allow_auto_merge: true, allow_squash_merge: true });
  });

  it('can relax enforce_admins only when asked', () => {
    const r = buildRequests({ repo: 'o/r', branch: 'main', enforceAdmins: false });
    expect(r[0].body.enforce_admins).toBe(false);
  });

  it('rejects a malformed repo slug', () => {
    expect(() => buildRequests({ repo: 'nope', branch: 'main' })).toThrow(/owner\/name/);
  });
});

describe('CLI', () => {
  it('--dry-run prints exact payloads and needs no token', () => {
    const r = run(['--dry-run', '--repo', 'o/r']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.dryRun).toBe(true);
    expect(out.requests).toEqual(buildRequests({ repo: 'o/r', branch: 'main' }));
  });

  it('refuses to run for real without a token', () => {
    const r = run(['--repo', 'o/r']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/GITHUB_TOKEN|GH_TOKEN/);
  });

  it('requires a repo', () => {
    const r = run(['--dry-run']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--repo/);
  });
});
