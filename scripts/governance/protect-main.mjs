#!/usr/bin/env node
// Apply branch protection to main + allow auto-merge on the repository.
// Requires an ADMIN token in GITHUB_TOKEN or GH_TOKEN (the Actions
// GITHUB_TOKEN cannot do this). Use --dry-run to print the exact payloads.
//
//   node scripts/governance/protect-main.mjs --repo owner/name [--branch main]
//        [--dry-run] [--no-enforce-admins]
import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CHECKS = ['Lint · Typecheck · Test · Build', 'Governance · risk classification'];

export function buildRequests({ repo, branch = 'main', enforceAdmins = true, checks = REQUIRED_CHECKS }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) {
    throw new Error(`repo must be "owner/name", got "${repo}"`);
  }
  return [
    {
      method: 'PUT',
      path: `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`,
      body: {
        required_status_checks: { strict: true, checks: checks.map((context) => ({ context })) },
        enforce_admins: enforceAdmins,
        // PR required; approvals are 0 because merge eligibility is decided by
        // checks + independent review + resolved conversations, not by humans.
        required_pull_request_reviews: {
          dismiss_stale_reviews: true,
          require_code_owner_reviews: false,
          required_approving_review_count: 0,
        },
        restrictions: null,
        required_conversation_resolution: true,
        allow_force_pushes: false,
        allow_deletions: false,
      },
    },
    {
      method: 'PATCH',
      path: `/repos/${repo}`,
      body: { allow_auto_merge: true, allow_squash_merge: true },
    },
  ];
}

async function main(argv) {
  let repo = process.env.GITHUB_REPOSITORY;
  let branch = 'main';
  let dryRun = false;
  let enforceAdmins = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') repo = argv[++i];
    else if (a === '--branch') branch = argv[++i];
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--no-enforce-admins') enforceAdmins = false;
    else {
      process.stderr.write(`unknown argument ${a}\n`);
      return 2;
    }
  }
  if (!repo) {
    process.stderr.write('missing --repo owner/name (or GITHUB_REPOSITORY)\n');
    return 2;
  }
  const requests = buildRequests({ repo, branch, enforceAdmins });
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, requests }, null, 2)}\n`);
    return 0;
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    process.stderr.write('GITHUB_TOKEN or GH_TOKEN (admin scope) is required unless --dry-run\n');
    return 2;
  }
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const results = [];
  let failed = false;
  for (const r of requests) {
    const res = await globalThis.fetch(`${api}${r.path}`, {
      method: r.method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(r.body),
    });
    const ok = res.ok;
    failed ||= !ok;
    // Never echo response bodies wholesale; status + message is enough.
    let message;
    if (!ok) {
      try {
        message = (await res.json()).message;
      } catch {
        message = res.statusText;
      }
    }
    results.push({ method: r.method, path: r.path, status: res.status, ok, ...(message ? { message } : {}) });
  }
  process.stdout.write(`${JSON.stringify({ dryRun: false, results }, null, 2)}\n`);
  if (failed && results.some((r) => r.status === 403 || r.status === 404)) {
    process.stderr.write('Token lacks admin rights on the repository (403/404). Record this in the exception report.\n');
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
