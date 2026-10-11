// Card A1 mutation check: node docs/evidence/A1/mutate.mjs [id ...]
// Applies one mutation at a time in place, runs the A1 tests, restores the file.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [A, S, M, E] = ['src/rbac/authorize.ts', 'src/identity/scope.ts', 'src/rbac/matrix.ts', 'src/identity/envMap.ts'];
const MUTANTS = [ // id, file, exact text (once), replacement
  ['no-principal-allowed', A, 'if (!isPrincipal(p)) return deny(401', 'if (!p) return deny(401'],
  ['legacy-role-any-credential', A, " || (p.role === 'legacy_service') !== (p.authMethod === 'legacy-shared-token')", ''],
  ['unknown-action-allowed', A, 'if (!isOneOf(ACTIONS, action)) return deny(403, DENY_REASONS.action);', ''],
  ['real-team-not-required', A, 'if (!hasRealTeam(p.teams) || ', 'if ('],
  ['env-claim-ignored', A, 'if (env !== undefined && !envCovered(p.envs, env)) return deny(403, DENY_REASONS.scope);', ''],
  ['team-claim-ignored', A, 'if (team !== undefined && !teamCovered(p.teams, team)) return deny(403, DENY_REASONS.scope);', ''],
  ['page-route-confusion', A, " || (kind === 'route') !== (row.kind === 'api')", ''],
  ['deferred-row-allowed', A, 'if (row.deferred) return deny(403, DENY_REASONS.disabled);', ''],
  ['kind-binding-dropped', A, 'if (!row.kinds.includes(kind)) return deny(403, DENY_REASONS.resource);', ''],
  ['route-list-dropped', A, 'if (row.routes && !row.routes.includes(id))', 'if (false)'],
  ['unteamed-change-allowed', A, "(p.teams !== '*' || cell !== 'Y')", "(p.teams !== '*')"],
  ['impact-ignored', A, 'if (impact !== undefined && res.impact !== impact)', 'if (false)'],
  ['self-approval', A, ' || res.requesterSub === p.sub)) {', ')) {'],
  ['prod-apply-without-ticket', A, 'return deny(403, DENY_REASONS.noTicket);', 'void 0;'],
  ['approver-equals-requester', A, 'if (res.approverSub === res.requesterSub) return deny(403, DENY_REASONS.duties);', ''],
  ['ticket-not-approved-ok', A, "if (ticket !== 'approved') return deny(409, DENY_REASONS.ticketNotApproved);", ''],
  ['throw-escapes-authorize', A, '} catch {\n    return deny(403, DENY_REASONS.resource);', '} catch (e) {\n    throw e;'],
  ['inherited-fields-read', S, '    if (!Object.hasOwn(o, k)) continue;\n', ''],
  ['array-as-record', S, "typeof o !== 'object' || Array.isArray(o)) return undefined;", "typeof o !== 'object') return undefined;"],
  ['record-inherits-object-prototype', S, 'Object.create(null) as', '{} as'],
  ['inherited-index-read', S, 'if (Object.hasOwn(a, i)) out.push(a[i]);', 'out.push(a[i]);'],
  ['claim-cap-removed', S, ' || a.length > max)', ')'],
  ['row-cap-removed', S, 'ownArray(rows, MAX_ROWS)', 'ownArray(rows, Infinity)'],
  ['throw-escapes-inScope', S, '} catch {\n    return false;', '} catch (e) {\n    throw e;'],
  ['env-trimmed', E, 'RATIO_ENV.get(value)', "RATIO_ENV.get(typeof value === 'string' ? value.trim().toLowerCase() : value)"],
  ['unknown-env-is-dev', E, "DATA_ENV.get(value) ?? null", "DATA_ENV.get(value) ?? 'dev'"],
  ['policy-not-frozen', M, "if (o && typeof o === 'object' && !Object.isFrozen(o))", 'if (false)'],
  ['mcp-write-finops', M, "'mcp.write': a([N, N, N, N, N, N, N]", "'mcp.write': a([N, Y, N, N, N, N, N]"],
  ['prod-apply-cell-y', M, "['Y*', 'Y*', 'A']", 'YS'],
  ['legacy-reads-audit', M, "'audit.read': a([Y, Y, N, YS, N, Y, N]", "'audit.read': a([Y, Y, N, YS, N, Y, Y]"],
  ['legacy-on-open-route', M, "r('/api/attribution', 'attribution')", "r('/api/attribution', 'attribution', LEGACY)"],
  ['webhook-public', M, "{ status: 'signed', plannedBy: 'C4' }", "{ status: 'public', plannedBy: 'C4' }"],
  ['sync-row-dropped', M, "  r('/api/v1/cm/sync', 'status_sync', { plannedBy: 'C8', action: 'ticket.update' }),\n", ''],
];
const run = () => spawnSync('npx', ['vitest', 'run', 'src/identity', 'src/rbac'], { encoding: 'utf8', timeout: 300_000 }).status;
if (run() !== 0) throw new Error('baseline is not green');
const ids = process.argv.slice(2);
let killed = 0;
const todo = MUTANTS.filter(([id]) => !ids.length || ids.includes(id));
for (const [id, file, find, repl] of todo) {
  const src = readFileSync(file, 'utf8');
  if (src.split(find).length !== 2) throw new Error(`${id}: pattern must occur exactly once`);
  try {
    writeFileSync(file, src.replace(find, repl));
    const ok = run() !== 0;
    killed += ok;
    console.log(`${ok ? 'killed  ' : 'SURVIVED'} ${id}`);
  } finally {
    writeFileSync(file, src);
  }
}
console.log(`${killed} of ${todo.length} mutants killed`);
process.exit(killed === todo.length ? 0 : 1);
