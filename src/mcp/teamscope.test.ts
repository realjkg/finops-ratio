// Team scoping: a team-scoped principal must name an own team on every team-dimensioned
// tool, gets no team-less tool, and provider rows outside its teams are refused.
import { describe, expect, it } from 'vitest';
import { handleMcpMessage } from './handler';
import { RPC_ERRORS } from './jsonrpc';
import { rowsInScope } from './scope';
import { TOOL_REGISTRY } from './registry';
import { SAMPLE, TEAM_CX, TEAM_PLATFORM, asFailure, callMsg, makeCtx, makePrincipal, makeProvider, toolResult } from './testkit';
import type { JsonValue } from './jsonSafe';

const TEAM_TOOLS = TOOL_REGISTRY.filter((t) => Object.hasOwn(t.def.inputSchema.properties ?? {}, 'team')).map((t) => t.def.name);
const eng = () => makePrincipal('eng_lead'); // teams: [Platform Eng]

describe('team-scoped principal (eng_lead)', () => {
  it('covers five team tools and one team-less tool', () => {
    expect(TEAM_TOOLS.sort()).toEqual(['get_allocation_summary', 'get_budget_status', 'get_forecast', 'get_spend_summary', 'list_findings']);
  });
  for (const name of TEAM_TOOLS) {
    it(`${name}: omitted team and other team are denied, own team is served`, async () => {
      for (const args of [{}, { team: TEAM_CX }]) {
        const ctx = makeCtx({ principal: eng() });
        expect(asFailure(await handleMcpMessage(callMsg(name, args), ctx)).error, JSON.stringify(args)).toEqual(RPC_ERRORS.toolNotAvailable);
        expect(ctx.provider.calls).toHaveLength(0);
        expect(ctx.audit.records[0]).toMatchObject({ decision: 'deny', reason: 'not_authorized' });
      }
      const f = SAMPLE.findings();
      const a = SAMPLE.allocation();
      const own = makeCtx({ principal: eng(), provider: makeProvider({
        listFindings: async () => ({ ...f, data: { ...f.data, findings: [{ ...f.data.findings[0], team: TEAM_PLATFORM }] } }),
        getAllocationSummary: async () => ({ ...a, data: { ...a.data, groups: [{ ...a.data.groups[0], rows: [{ key: TEAM_PLATFORM, amount: '250.00' }] }] } }),
      }) });
      expect(toolResult(await handleMcpMessage(callMsg(name, { team: TEAM_PLATFORM }), own)).isError).toBe(false);
    });
    it(`${name}: an org-wide principal needs no team`, async () => {
      const ctx = makeCtx({ principal: makePrincipal('finops_lead') });
      expect(toolResult(await handleMcpMessage(callMsg(name, {}), ctx)).isError).toBe(false);
    });
  }
  it('get_commitment_coverage has no team dimension: denied for team-scoped, allowed org-wide', async () => {
    const ctx = makeCtx({ principal: eng() });
    expect(asFailure(await handleMcpMessage(callMsg('get_commitment_coverage', {}), ctx)).error).toEqual(RPC_ERRORS.toolNotAvailable);
    expect(ctx.provider.calls).toHaveLength(0);
    // a team argument is not in its schema, so it is refused as invalid before any provider call
    expect(toolResult(await handleMcpMessage(callMsg('get_commitment_coverage', { team: TEAM_PLATFORM }), ctx)).isError).toBe(true);
    expect(ctx.provider.calls).toHaveLength(0);
    const org = makeCtx({ principal: makePrincipal('auditor') });
    expect(toolResult(await handleMcpMessage(callMsg('get_commitment_coverage', {}), org)).isError).toBe(false);
  });
  it('a list-teams principal with several teams is held to the ones it has', async () => {
    const p = makePrincipal('finops_lead', { teams: [TEAM_PLATFORM, TEAM_CX] });
    const ctx = makeCtx({ principal: p });
    expect(toolResult(await handleMcpMessage(callMsg('get_forecast', { team: TEAM_CX }), ctx)).isError).toBe(false);
    expect(asFailure(await handleMcpMessage(callMsg('get_forecast', { team: 'Other' }), ctx)).error).toEqual(RPC_ERRORS.toolNotAvailable);
  });
});

describe('row scope check (defense in depth)', () => {
  const run = async (name: string, provider: object, args: object) => {
    const ctx = makeCtx({ principal: eng(), provider: makeProvider(provider) });
    return { ctx, res: await handleMcpMessage(callMsg(name, args), ctx) };
  };
  it('refuses findings and budgets for another or missing team, passes own team', async () => {
    const f = SAMPLE.findings();
    const fnd = (team?: string) => async () => ({ ...f, data: { ...f.data, findings: [{ ...f.data.findings[0], ...(team ? { team } : {}) }] } });
    for (const team of [TEAM_CX, undefined]) {
      const { ctx, res } = await run('list_findings', { listFindings: fnd(team) }, { team: TEAM_PLATFORM });
      expect(toolResult(res).content[0].text).toBe('Tool failed');
      expect(ctx.audit.records[0].reason).toBe('output_invalid');
    }
    expect(toolResult((await run('list_findings', { listFindings: fnd(TEAM_PLATFORM) }, { team: TEAM_PLATFORM })).res).isError).toBe(false);
    const b = SAMPLE.budgets();
    const bud = async () => ({ ...b, data: { budgets: [{ ...b.data.budgets[0], team: TEAM_CX }] } });
    expect(toolResult((await run('get_budget_status', { getBudgetStatus: bud }, { team: TEAM_PLATFORM })).res).content[0].text).toBe('Tool failed');
  });
  it('refuses team-keyed spend and allocation rows outside scope', async () => {
    const s = SAMPLE.spend();
    const spend = async () => ({ ...s, data: { ...s.data, group_by: 'team' as const, groups: [{ currency: 'USD', total: '3.00', rows: [{ key: TEAM_PLATFORM, amount: '1.00' }, { key: TEAM_CX, amount: '2.00' }] }] } });
    expect(toolResult((await run('get_spend_summary', { getSpendSummary: spend }, { team: TEAM_PLATFORM })).res).content[0].text).toBe('Tool failed');
    const a = SAMPLE.allocation(); // its 'untagged' row is outside any team
    expect(toolResult((await run('get_allocation_summary', { getAllocationSummary: async () => a }, { team: TEAM_PLATFORM })).res).content[0].text).toBe('Tool failed');
  });
  it('rowsInScope: org-wide always true; unknown shape fails for team-scoped', () => {
    const bad: JsonValue = { findings: [{ team: TEAM_CX }] };
    expect(rowsInScope('*', bad)).toBe(true);
    expect(rowsInScope([TEAM_PLATFORM], bad)).toBe(false);
    expect(rowsInScope([TEAM_PLATFORM], null)).toBe(false);
    expect(rowsInScope([TEAM_PLATFORM], { findings: [{ team: TEAM_PLATFORM }] })).toBe(true);
  });
});
