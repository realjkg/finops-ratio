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
import { CI_CHECK_NAME, GITHUB_ACTIONS_APP_ID, ELIGIBILITY_CONTEXT } from './eligibility.mjs';

// CI is pinned to the GitHub Actions app so a status/check from another app
// cannot satisfy it. The governance context is a COMMIT STATUS posted by the
// classify job and is accepted from any source: it is informational (it is
// always "success"; it never gates on risk), and merge eligibility re-classifies
// the PR itself, so a spoofed status cannot make a restricted PR auto-mergeable.
export const REQUIRED_CHECKS = [
  { context: CI_CHECK_NAME, app_id: GITHUB_ACTIONS_APP_ID },
  { context: 'Governance · risk classification' },
  // Posted by the eligibility job: success only for an eligible low-risk PR or a
  // valid admin/maintain exception. Requiring it means enabling GitHub's native
  // auto-merge by hand cannot bypass the gate.
  { context: ELIGIBILITY_CONTEXT },
];

export function buildRequests({ repo, branch = 'main', enforceAdmins = true, checks = REQUIRED_CHECKS }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) {
    throw new Error(`repo must be "owner/name", got "${repo}"`);
  }
  return [
    {
      method: 'PUT',
      path: `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`,
      body: {
        required_status_checks: { strict: true, checks: checks.map((c) => ({ ...c })) },
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

/**
 * Send the requests IN ORDER (branch protection PUT first, then the repo PATCH
 * that allows auto-merge) and STOP at the first failure, so auto-merge is never
 * switched on for a branch whose protection could not be applied.
 */
export async function applyRequests(requests, { fetchImpl, token, api }) {
  const results = [];
  for (const r of requests) {
    const res = await fetchImpl(`${api}${r.path}`, {
      method: r.method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(r.body),
    });
    // Never echo response bodies wholesale; status + message is enough.
    let message;
    if (!res.ok) {
      try {
        message = (await res.json()).message;
      } catch {
        message = res.statusText;
      }
    }
    results.push({ method: r.method, path: r.path, status: res.status, ok: res.ok, ...(message ? { message } : {}) });
    if (!res.ok) return { results, failed: true };
  }
  return { results, failed: false };
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
  const { results, failed } = await applyRequests(requests, { fetchImpl: globalThis.fetch, token, api });
  process.stdout.write(`${JSON.stringify({ dryRun: false, results }, null, 2)}\n`);
  if (failed && results.some((r) => r.status === 403 || r.status === 404)) {
    process.stderr.write('Token lacks admin rights on the repository (403/404). Record this in the exception report.\n');
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
