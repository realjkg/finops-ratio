// Mutation check for card A1 (documented manual-list runner).
//
//   node docs/evidence/A1/mutate.mjs [mutant-id ...]
//
// Applies ONE mutation at a time to the A1 source files in place, runs the A1
// test files, records whether at least one test failed (mutant killed), and
// restores the original bytes in a finally block. Run on a clean tree and
// confirm `git status --porcelain` is empty afterwards.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const root = resolve(new URL('../../..', import.meta.url).pathname);
const A = 'src/rbac/authorize.ts';
const M = 'src/rbac/matrix.ts';
const S = 'src/identity/scope.ts';
const E = 'src/identity/envMap.ts';
const TESTS = ['src/identity/envMap.test.ts', 'src/rbac/matrix.test.ts', 'src/rbac/authorize.test.ts'];

/** id, file, exact text (must occur once), replacement, what it models, [equivalent-mutant note]. */
const MUTANTS = [
  ['no-principal-allows', A, 'if (!isPrincipalShape(principal)) return deny(401, DENY_REASONS.noPrincipal);', 'if (!isPrincipalShape(principal)) return ALLOW;', 'deny by default dropped'],
  ['unknown-role-allowed', A, "if (!isRole(p.role)) return deny(403, DENY_REASONS.unknownRole);", "if (!isRole(p.role)) return ALLOW;", 'unknown role allowed'],
  ['legacy-role-any-method', A, "return (role === 'legacy_service') === (method === 'legacy-shared-token');", 'return true;', 'legacy_service claimable by a token'],
  ['empty-teams-has-scope', A, "const teamsOk = p.teams === '*' || p.teams.length > 0;", 'const teamsOk = true;', 'empty teams treated as a scope'],
  ['skip-env-check', A, 'if (env !== undefined && !envCovered(p.envs, env)) return deny(403, DENY_REASONS.envNotPermitted);', '', 'token env claim ignored'],
  ['skip-team-check', A, 'if (team !== undefined && !teamCovered(p.teams, team)) return deny(403, DENY_REASONS.teamNotPermitted);', '', 'team scope ignored'],
  ['env-optional-for-actions', A, 'if (env === undefined) return deny(403, DENY_REASONS.envNotPermitted);\n\n  const cell = cellFor(row, p.role, env);', "const cell = cellFor(row, p.role, env ?? 'dev');", 'missing resource env treated as dev'],
  ['deferred-row-enforced', A, 'if (row.deferred) return deny(403, DENY_REASONS.actionNotEnabled);', '', 'deferred budget.edit row yields allows'],
  ['skip-kind-binding', A, 'if (!row.kinds.includes(kind)) return deny(403, DENY_REASONS.badResource);', '', 'action not bound to resource kind'],
  ['page-route-confusion', A, "if ((kind === 'route') !== (row.kind === 'api')) return deny(403, DENY_REASONS.viewNotPermitted);", '', 'page id accepted as API route'],
  ['sim-only-readable', A, "if (row.status === 'sim_only' || row.status === 'signed')", "if (row.status === 'signed')", 'simulation status check dropped (codes still deny)', 'equivalent: simulation rows carry dev_test_only codes, which READABLE_CODES excludes; the status check is defense in depth, pinned by matrix_view_codes_match_plan_section_4_4'],
  ['matrix-sim-codes-readable', M, "simulation: group('Customer simulation (dev and test only, own session model)', ALL('dev_test_only')),", "simulation: group('Customer simulation (dev and test only, own session model)', ALL('D')),", 'simulation rows given readable codes'],
  ['skip-route-group', A, 'if (only && !only.includes(id)) return deny(403, DENY_REASONS.badResource);', '', 'ingest.write allowed on any readable route'],
  ['unteamed-change-for-anyone', A, "if (team === undefined && (p.teams !== '*' || cell === 'Y*' || cell === 'A')) {", "if (team === undefined && (cell === 'Y*' || cell === 'A')) {", 'unbound ticket open to team-limited principals'],
  ['skip-impact-rule', A, 'if (impactRule !== undefined && !(isChangeImpact(resource.impact) && resource.impact === impactRule)) {', 'if (false) {', 'finance approves commitment changes'],
  ['request-on-behalf', A, 'if (resource.requesterSub !== undefined && resource.requesterSub !== p.sub) {', 'if (false) {', 'request on behalf of another subject'],
  ['self-approve', A, 'if (!isNonEmptyString(resource.requesterSub) || resource.requesterSub === p.sub) {', 'if (!isNonEmptyString(resource.requesterSub)) {', 'requester can approve own change'],
  ['no-ticket-ok', A, "if (!isTicketState(ticket) || ticket === 'none') return deny(403, DENY_REASONS.noBoundTicket);", '', 'prod apply without a bound ticket'],
  ['unapproved-change-ok', A, 'if (!isNonEmptyString(resource.approverSub)) return deny(409, DENY_REASONS.changeNotApproved);', '', 'prod apply of an unapproved change'],
  ['approver-equals-requester-ok', A, 'if (resource.approverSub === resource.requesterSub) return deny(403, DENY_REASONS.separationOfDuties);', '', 'approver equal to requester'],
  ['ticket-not-approved-ok', A, "if (ticket !== 'approved') return deny(409, DENY_REASONS.ticketNotApproved);", '', 'prod apply while ticket open'],
  ['own-copy-dropped', A, "  if (Array.isArray(o)) return undefined;\n  const copy", "  if (Array.isArray(o)) return undefined;\n  return o;\n  const copy", 'inherited principal and resource fields decide (review M1)'],
  ['own-copy-keeps-inherited', A, '    if (!Object.hasOwn(o, k)) continue;\n', '', 'copy reads fields through the prototype chain (review M1)'],
  ['own-copy-array-passthrough', A, '  if (Array.isArray(o)) return undefined;\n', '', 'array resource read through its prototype (delta review H)'],
  ['own-elements-no-hasown', A, 'if (Object.hasOwn(a, i)) out.push(a[i]);', 'out.push(a[i]);', 'inherited index fills a hole in teams or envs (delta review M-a)'],
  ['own-copy-no-array-copy', A, 'copy[k] = Array.isArray(v) ? ownElements(v) : v;', 'copy[k] = v;', 'teams and envs used uncopied (delta review M-b)'],
  ['own-copy-object-proto', A, 'const copy = Object.create(null) as Record<K, unknown>;', 'const copy = {} as Record<K, unknown>;', 'copy inherits Object.prototype (delta review M-c)'],
  ['star-eng-lead-unteamed-ys', A, "(p.teams !== '*' || cell === 'Y*' || cell === 'A')", "(p.teams !== '*')", 'Y* or A cell without a team for teams "*" (review L2)'],
  ['scope-any-env-length', A, 'return teamsOk && p.envs.some((e) => isDeployEnv(e));', 'return teamsOk && p.envs.length > 0;', 'invalid-only env claim counts as scope (review L2)'],
  ['expires-not-finite', A, '    Number.isFinite(o.expiresAt) &&\n', '', 'non-finite expiresAt accepted (review L2)'],
  ['readview-kind-guard', A, "  if (kind !== 'view' && kind !== 'route') return deny(403, DENY_REASONS.badResource);\n  const row = findRoute(id);", '  const row = findRoute(id);', 'view.read with a non-view kind (review L2)'],
  ['scope-widen-team-list', S, 'return Array.isArray(teams) && teams.some((t) => t === team);', 'return Array.isArray(teams) && teams.length > 0;', 'any team list covers every team'],
  ['scope-star-element-wildcard', S, "if (teams === '*') return true;", "if (teams === '*' || (Array.isArray(teams) && teams.includes('*'))) return true;", "['*'] treated as a wildcard"],
  ['scope-case-fold', S, 'teams.some((t) => t === team)', 'teams.some((t) => t.toLowerCase() === team.toLowerCase())', 'team match case-insensitive'],
  ['scope-unattributed-visible', S, "if (teams !== '*') return false;\n  } else", "if (teams === undefined) return false;\n  } else", 'unattributed rows visible to team-limited principals'],
  ['scope-null-env-visible', S, 'if (key.env === undefined) return holdsEveryEnv(envs);', 'if (key.env == null) return holdsEveryEnv(envs);', 'unmapped env treated as unknown'],
  ['envmap-trim', E, "export function ratioEnvToDeployEnv(value: unknown): DeployEnv | null {\n  if (typeof value !== 'string') return null;\n  switch (value) {", "export function ratioEnvToDeployEnv(value: unknown): DeployEnv | null {\n  if (typeof value !== 'string') return null;\n  switch (value.trim().toLowerCase()) {", 'RATIO_ENV trimmed and case-folded'],
  ['envmap-staging-prod', E, "    case 'staging':\n      return 'test';\n    case 'prod':", "    case 'staging':\n      return 'prod';\n    case 'prod':", 'workload staging mapped to prod'],
  ['envmap-default-dev', E, "    case 'prod':\n      return 'prod';\n    default:\n      return null;", "    case 'prod':\n      return 'prod';\n    default:\n      return 'dev';", 'unknown workload env maps to dev'],
  ['matrix-mcp-write-finops', M, "'mcp.write': action([N, N, N, N, N, N, N], MCP),", "'mcp.write': action([N, Y, N, N, N, N, N], MCP),", 'MCP write granted to finops_lead'],
  ['matrix-auditor-ingest', M, "'ingest.write': action([N, Y, N, N, N, N, N], ['route']),", "'ingest.write': action([N, Y, N, N, N, Y, N], ['route']),", 'auditor may write ingest rows'],
  ['matrix-legacy-audit', M, "'audit.read': action([Y, Y, N, YS, N, Y, N], ['audit', 'view', 'route']),", "'audit.read': action([Y, Y, N, YS, N, Y, Y], ['audit', 'view', 'route']),", 'legacy token reads the audit log'],
  ['matrix-eng-prod-apply-y', M, "'change.apply': action([N, N, N, ['Y*', 'Y*', 'A'], N, N, N], CHANGE),", "'change.apply': action([N, N, N, YS, N, N, N], CHANGE),", 'prod apply without the ticket gate'],
  ['matrix-finops-prod-approve', M, "'change.approve': action([Y, ['Y', 'Y', 'n'], Y, N, Y, N, N], CHANGE, {", "'change.approve': action([Y, Y, Y, N, Y, N, N], CHANGE, {", 'finops lead approves in prod'],
  ['matrix-cto-costsource', M, "costsource: group('Cost sources', ['-', 'D', 'D', 'T', '-', 'D']),", "costsource: group('Cost sources', ['O', 'D', 'D', 'T', '-', 'D']),", 'CTO reads line-level cost sources'],
  ['matrix-legacy-new-route', M, "api('/api/v1/workloads', 'scoped_data', 'B7', { plannedBy: 'B7' }),", "api('/api/v1/workloads', 'scoped_data', 'B7', { plannedBy: 'B7', legacyService: 'D' }),", 'legacy token reads a route this plan adds'],
  ['matrix-legacy-open-route', M, "api('/api/attribution', 'attribution', 'B3'),", "api('/api/attribution', 'attribution', 'B3', { legacyService: 'D' }),", 'legacy grant beyond gateway-wrapped routes'],
  ['matrix-webhook-public', M, "api('/api/v1/cm/webhook', 'webhook', 'C4', { status: 'signed', plannedBy: 'C4' }),", "api('/api/v1/cm/webhook', 'webhook', 'C4', { status: 'public', plannedBy: 'C4' }),", 'webhook made public'],
  ['matrix-drop-route', M, "  page('/tokenomics', 'tokenomics'),\n", '', 'a page without a matrix row'],
  ['matrix-drop-sync-row', M, "  api('/api/v1/cm/sync', 'status_sync', 'C8', { plannedBy: 'C8', action: 'ticket.update' }),\n", '', 'planned status-sync route without a matrix row'],
  ['matrix-impact-dropped', M, "requiresImpact: Object.freeze({ finance: 'cost', procurement: 'commitment' }),", "requiresImpact: Object.freeze({ finance: 'cost' }),", 'procurement approves any impact'],
];

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const log = (s) => process.stdout.write(`${s}\n`);
const only = process.argv.slice(2);
const todo = only.length ? MUTANTS.filter((m) => only.includes(m[0])) : MUTANTS;

function runTests() {
  const r = spawnSync('npx', ['vitest', 'run', ...TESTS, '--reporter=dot'], { cwd: root, encoding: 'utf8', timeout: 300_000 });
  const out = `${r.stdout}\n${r.stderr}`.replace(ANSI, '');
  const m = out.match(/Tests\s+(?:(\d+) failed)?[^\n]*?(\d+) passed/);
  return { code: r.status, failed: m?.[1] ? Number(m[1]) : 0, passed: m ? Number(m[2]) : 0, out };
}

const base = runTests();
if (base.code !== 0) {
  log('baseline is not green; aborting');
  log(base.out);
  process.exit(2);
}
log(`baseline: ${base.passed} passed`);
log('| mutant | file | models | result | failing tests |');
log('|---|---|---|---|---|');
let survived = 0;
let equivalent = 0;
for (const [id, file, find, replace, what, equiv] of todo) {
  const abs = join(root, file);
  const original = readFileSync(abs, 'utf8');
  const count = original.split(find).length - 1;
  if (count !== 1) {
    log(`| ${id} | ${file} | ${what} | ERROR: pattern occurs ${count} times | |`);
    survived += 1;
    continue;
  }
  try {
    writeFileSync(abs, original.replace(find, replace));
    const r = runTests();
    const killed = r.code !== 0;
    if (!killed && equiv) equivalent += 1;
    else if (!killed) survived += 1;
    const result = killed ? 'killed' : equiv ? `survived (${equiv})` : 'SURVIVED';
    log(`| ${id} | ${file} | ${what} | ${result} | ${killed ? (r.failed || 'suite error') : 0} |`);
  } finally {
    writeFileSync(abs, original);
  }
}
log(`\n${todo.length - survived - equivalent} of ${todo.length} mutants killed; ${equivalent} equivalent; ${survived} survived`);
process.exit(survived === 0 ? 0 : 1);
