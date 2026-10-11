// Team scoping for team-scoped principals (review finding). Purpose: decide whether a
// tool may run for a principal whose teams are not '*', and check provider rows again
// before delivery. Trust boundary: a team-scoped caller must name a team it covers on
// every tool that has a team argument, and gets no tool without one (org-wide only).
// The row check is defense in depth: a provider that ignores the scope is refused.
import { teamCovered } from '@/identity/scope';
import type { JsonValue } from './jsonSafe';
import type { ToolDefinition } from './tools';

export const hasTeamArg = (tool: Pick<ToolDefinition, 'inputSchema'>): boolean => Object.hasOwn(tool.inputSchema.properties ?? {}, 'team');

/** True when a team-scoped principal may not call the tool with these (validated) arguments. */
export function teamScopeDenied(teams: unknown, tool: Pick<ToolDefinition, 'inputSchema'>, team: unknown): boolean {
  if (teams === '*') return false;
  if (!hasTeamArg(tool)) return true;
  return typeof team !== 'string' || !teamCovered(teams, team);
}

const rowsOf = (v: JsonValue | undefined): JsonValue[] => (Array.isArray(v) ? v : []);
const objOf = (v: JsonValue | undefined): { [k: string]: JsonValue } | null => (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** Every row that carries or is keyed by a team must be inside the scope. Unknown shape fails. */
export function rowsInScope(teams: unknown, data: JsonValue): boolean {
  if (teams === '*') return true;
  const d = objOf(data);
  if (d === null) return false;
  for (const f of rowsOf(d.findings)) if (!teamCovered(teams, objOf(f)?.team)) return false;
  for (const b of rowsOf(d.budgets)) if (!teamCovered(teams, objOf(b)?.team)) return false;
  if (d.group_by === 'team' || d.dimension === 'team') {
    for (const g of rowsOf(d.groups)) for (const r of rowsOf(objOf(g)?.rows)) if (!teamCovered(teams, objOf(r)?.key)) return false;
  }
  return true;
}
