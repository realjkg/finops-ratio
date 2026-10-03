// Branch-protection payload builder + CLI safety (never calls GitHub in tests).
import { describe, it, expect } from 'vitest';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRequests, applyRequests } from './protect-main.mjs';

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
        // M1: CI must come from the GitHub Actions app (id 15368).
        { context: 'Lint · Typecheck · Test · Build', app_id: 15368 },
        // H1: governance statuses are pinned to the GitHub Actions app too, so a
        // status posted with a personal token cannot satisfy them.
        { context: 'Governance · risk classification', app_id: 15368 },
        { context: 'Governance · merge eligibility', app_id: 15368 },
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

describe('H1: every required check is pinned to the GitHub Actions app', () => {
  it('app_id 15368 on all three', () => {
    const checks = buildRequests({ repo: 'o/r' })[0].body.required_status_checks.checks;
    expect(checks).toHaveLength(3);
    for (const c of checks) expect(c.app_id, c.context).toBe(15368);
  });
});

describe('C4: applyRequests', () => {
  const reqs = buildRequests({ repo: 'o/r', branch: 'main' });
  const fakeFetch = (statuses) => {
    const seen = [];
    const fn = async (url, init) => {
      seen.push({ url, method: init.method });
      const status = statuses[seen.length - 1] ?? 200;
      return { ok: status < 300, status, statusText: 'x', json: async () => ({ message: `m${status}` }) };
    };
    return { fn, seen };
  };
  it('applies protection first, then the repo PATCH', async () => {
    const f = fakeFetch([200, 200]);
    const out = await applyRequests(reqs, { fetchImpl: f.fn, token: 't', api: 'https://api.test' });
    expect(out.failed).toBe(false);
    expect(f.seen.map((x) => x.method)).toEqual(['PUT', 'PATCH']);
    expect(f.seen[0].url).toBe('https://api.test/repos/o/r/branches/main/protection');
  });
  it('stops at the first failure: protection 403 ⇒ PATCH never sent, failed', async () => {
    const f = fakeFetch([403, 200]);
    const out = await applyRequests(reqs, { fetchImpl: f.fn, token: 't', api: 'https://api.test' });
    expect(out.failed).toBe(true);
    expect(f.seen).toHaveLength(1);
    expect(out.results).toEqual([expect.objectContaining({ method: 'PUT', status: 403, ok: false, message: 'm403' })]);
  });
  it('a failing PATCH is reported as failed', async () => {
    const f = fakeFetch([200, 422]);
    const out = await applyRequests(reqs, { fetchImpl: f.fn, token: 't', api: 'https://api.test' });
    expect(out.failed).toBe(true);
    expect(f.seen).toHaveLength(2);
  });
  it('buildRequests orders PUT protection before PATCH repo', () => {
    expect(reqs.map((r) => r.method)).toEqual(['PUT', 'PATCH']);
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
