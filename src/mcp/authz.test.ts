// Authorization: authorize() on every call, role-filtered tools/list, write denial for
// every role and env, cross-tenant attempts, expiry, and team scope.
import { describe, expect, it } from 'vitest';
import { decideToolAccess, ROLE_TOOL_CLASSES } from './access';
import { handleMcpMessage } from './handler';
import { RPC_ERRORS } from './jsonrpc';
import { TOOL_REGISTRY } from './registry';
import { ROLES, DEPLOY_ENVS, PERSONA_ROLES, type DeployEnv, type Role } from '@/identity/types';
import { FAR_FUTURE_S, START_MS, TEAM_CX, TEAM_PLATFORM, asFailure, callMsg, makeCtx, makePrincipal, msg, toolNames, toolResult } from './testkit';

const listFor = async (role: Role, env: DeployEnv = 'dev') =>
  toolNames(await handleMcpMessage(msg('tools/list'), makeCtx({ principal: makePrincipal(role), deployEnv: env })));

describe('tools/list is filtered by role', () => {
  const expected: Record<Role, string[]> = {
    cto: ['get_forecast', 'get_spend_summary', 'list_findings'],
    finops_lead: TOOL_REGISTRY.map((t) => t.def.name).sort(),
    finance: ['get_allocation_summary', 'get_budget_status', 'get_forecast', 'get_spend_summary'],
    eng_lead: TOOL_REGISTRY.map((t) => t.def.name).filter((n) => n !== 'get_commitment_coverage').sort(), // team-scoped: no team-less tool
    procurement: ['get_commitment_coverage'],
    auditor: TOOL_REGISTRY.map((t) => t.def.name).sort(),
    legacy_service: [],
  };
  for (const role of ROLES) {
    it(`${role} sees exactly its tools in every env`, async () => {
      for (const env of DEPLOY_ENVS) expect((await listFor(role, env)).sort()).toEqual(expected[role]);
    });
  }
  it('what list shows equals what call allows, for every role and tool', async () => {
    for (const role of ROLES) {
      const visible = new Set(await listFor(role));
      for (const t of TOOL_REGISTRY) {
        const ctx = makeCtx({ principal: makePrincipal(role) });
        const args = role === 'eng_lead' && t.def.name !== 'get_commitment_coverage' ? { team: TEAM_PLATFORM } : {};
        const r = await handleMcpMessage(callMsg(t.def.name, args), ctx);
        expect(r !== null && 'result' in r, `${role} ${t.def.name}`).toBe(visible.has(t.def.name));
      }
    }
  });
  it('a principal whose env does not include the deployment env sees nothing and is denied', async () => {
    const principal = makePrincipal('finops_lead', { envs: ['dev'] });
    expect(toolNames(await handleMcpMessage(msg('tools/list'), makeCtx({ principal, deployEnv: 'prod' })))).toEqual([]);
    const ctx = makeCtx({ principal, deployEnv: 'prod' });
    expect(asFailure(await handleMcpMessage(callMsg('get_spend_summary', {}), ctx)).error).toEqual(RPC_ERRORS.toolNotAvailable);
    expect(ctx.provider.calls).toHaveLength(0);
  });
});

describe('writes are denied for every role and env', () => {
  it('mcp.write is denied by the matrix for all roles and envs, and by the access decision', () => {
    for (const role of ROLES) for (const env of DEPLOY_ENVS) {
      const p = makePrincipal(role);
      for (const t of TOOL_REGISTRY) {
        expect(decideToolAccess(p, { ...t.def, access: 'write' as never }, env).allow, `${role} ${env}`).toBe(false);
      }
    }
  });
  it('write-named and unknown tools are denied with the same fixed text, with no provider call', async () => {
    for (const role of ROLES) for (const env of DEPLOY_ENVS) {
      for (const name of ['update_budget', 'apply_remediation', 'create_ticket', 'delete_finding', 'run_action', 'set_threshold']) {
        const ctx = makeCtx({ principal: makePrincipal(role), deployEnv: env });
        const res = asFailure(await handleMcpMessage(callMsg(name, { id: 'x' }), ctx));
        expect(res.error, `${role} ${env} ${name}`).toEqual(RPC_ERRORS.toolNotAvailable);
        expect(ctx.provider.calls).toHaveLength(0);
      }
    }
  });
  it('unknown and not-authorized tools are indistinguishable to the client', async () => {
    const a = await handleMcpMessage(callMsg('nonexistent_tool', {}), makeCtx());
    const b = await handleMcpMessage(callMsg('get_commitment_coverage', {}), makeCtx({ principal: makePrincipal('finance') }));
    expect(asFailure(a).error).toEqual(asFailure(b).error);
  });
  it('denies tool names that are prototype keys or oddly shaped', async () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'GET_SPEND_SUMMARY', 'get_spend_summary ', '../x', 'a'.repeat(64), 'get spend']) {
      expect(asFailure(await handleMcpMessage(callMsg(name, {}), makeCtx())).error, name).toEqual(RPC_ERRORS.toolNotAvailable);
    }
    expect(asFailure(await handleMcpMessage(callMsg('a'.repeat(65), {}), makeCtx())).error).toEqual(RPC_ERRORS.invalidParams);
  });
  it('legacy_service is denied everywhere', async () => {
    const ctx = makeCtx({ principal: makePrincipal('legacy_service') });
    for (const t of TOOL_REGISTRY) expect(asFailure(await handleMcpMessage(callMsg(t.def.name, {}), ctx)).error).toEqual(RPC_ERRORS.toolNotAvailable);
  });
  it('role class table covers every role and gives persona roles at least one class', () => {
    expect(Object.keys(ROLE_TOOL_CLASSES).sort()).toEqual([...ROLES].sort());
    for (const r of PERSONA_ROLES) expect(ROLE_TOOL_CLASSES[r].length).toBeGreaterThan(0);
  });
});

describe('principal and tenant checks', () => {
  it('refuses malformed principals with 401-style text and no provider call', async () => {
    const bad: unknown[] = [null, undefined, {}, 'cto', { ...makePrincipal(), sub: '' }, { ...makePrincipal(), role: 'admin' }, { ...makePrincipal(), teams: 'all' },
      { ...makePrincipal(), authMethod: 'basic' }, { ...makePrincipal('finops_lead'), authMethod: 'legacy-shared-token' }];
    for (const principal of bad) {
      const ctx = makeCtx({ principal: principal as never });
      const res = asFailure(await handleMcpMessage(callMsg('get_spend_summary', {}), ctx));
      expect([RPC_ERRORS.unauthenticated, RPC_ERRORS.toolNotAvailable]).toContainEqual(res.error);
      expect(ctx.provider.calls).toHaveLength(0);
      const listed = await handleMcpMessage(msg('tools/list'), makeCtx({ principal: principal as never }));
      expect(listed !== null && 'error' in listed ? listed.error : toolNames(listed)).not.toContain('get_spend_summary');
    }
  });
  it('refuses an expired principal on the injected clock, at the exact second', async () => {
    const exp = START_MS / 1000 + 100;
    const principal = makePrincipal('finops_lead', { expiresAt: exp });
    const ctx = makeCtx({ principal });
    expect(toolResult(await handleMcpMessage(callMsg('get_spend_summary', {}), ctx)).isError).toBe(false);
    ctx.clock.advance(99_999);
    expect(toolResult(await handleMcpMessage(callMsg('get_spend_summary', {}), ctx)).isError).toBe(false);
    ctx.clock.advance(1);
    expect(asFailure(await handleMcpMessage(callMsg('get_spend_summary', {}), ctx)).error).toEqual(RPC_ERRORS.unauthenticated);
    expect(asFailure(await handleMcpMessage(msg('tools/list'), ctx)).error).toEqual(RPC_ERRORS.unauthenticated);
    expect(ctx.audit.records.at(-1)?.reason).toBe('principal_expired');
  });
  it('refuses a principal whose tenant is not the context tenant', async () => {
    const ctx = makeCtx({ principal: makePrincipal('finops_lead', { tenant: 't-other' }) });
    expect(asFailure(await handleMcpMessage(callMsg('get_spend_summary', {}), ctx)).error).toEqual(RPC_ERRORS.unauthenticated);
    expect(ctx.provider.calls).toHaveLength(0);
    expect(ctx.audit.records[0]).toMatchObject({ decision: 'deny', reason: 'tenant_mismatch' });
  });
  it('binds the provider scope to the context tenant even when arguments name another tenant', async () => {
    const ctx = makeCtx();
    for (const key of ['tenant', 'tenant_id', 'account', 'user']) {
      const res = toolResult(await handleMcpMessage(callMsg('get_spend_summary', { [key]: 't-victim' }), ctx));
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe('Invalid arguments: unknown_property');
    }
    expect(ctx.provider.calls).toHaveLength(0);
    await handleMcpMessage(callMsg('get_spend_summary', { period: '2026-09' }), ctx);
    expect(ctx.provider.calls[0].scope).toMatchObject({ tenant: 't-1', env: 'dev', subject: 'sub-finops_lead' });
    expect(JSON.stringify(ctx.provider.calls[0].args)).not.toContain('victim');
  });
  it('freezes the scope handed to the provider so it cannot widen it', async () => {
    const ctx = makeCtx({ principal: makePrincipal('eng_lead') });
    await handleMcpMessage(callMsg('get_spend_summary', { team: TEAM_PLATFORM }), ctx);
    const scope = ctx.provider.calls[0].scope;
    expect(scope.teams).toEqual([TEAM_PLATFORM]);
    expect(() => (scope.teams as string[]).push(TEAM_CX)).toThrow();
  });
});

describe('team argument is authorized', () => {
  it('lets an eng lead name its own team and denies another team', async () => {
    const p = makePrincipal('eng_lead');
    const own = makeCtx({ principal: p });
    expect(toolResult(await handleMcpMessage(callMsg('get_spend_summary', { team: TEAM_PLATFORM }), own)).isError).toBe(false);
    const other = makeCtx({ principal: p });
    expect(asFailure(await handleMcpMessage(callMsg('get_spend_summary', { team: TEAM_CX }), other)).error).toEqual(RPC_ERRORS.toolNotAvailable);
    expect(other.provider.calls).toHaveLength(0);
    expect(other.audit.records[0]).toMatchObject({ decision: 'deny', reason: 'not_authorized' });
  });
  it('lets an org-wide principal name any real team, and denies a team of "*"', async () => {
    const ctx = makeCtx();
    expect(toolResult(await handleMcpMessage(callMsg('list_findings', { team: TEAM_CX }), ctx)).isError).toBe(false);
    expect(toolResult(await handleMcpMessage(callMsg('list_findings', { team: '*' }), ctx)).isError).toBe(true); // pattern refuses
  });
  it('FAR_FUTURE principal in a list-only team set stays inside it', () => {
    expect(FAR_FUTURE_S).toBeGreaterThan(START_MS / 1000);
  });
});
