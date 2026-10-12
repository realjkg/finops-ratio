import { afterEach, describe, expect, it, vi } from 'vitest';
import { JiraAdapter } from '../../../pages/api/v1/cm/change';
import { JIRA_ISSUE_KEY, SERVICENOW_NUMBER } from '@/cm/ticketRef';
import {
  createItsmState,
  startJiraStub,
  startMockItsm,
  startServiceNowStub,
  type RunningStub,
} from './index';

const BEARER = 'stub-bearer-4f9c1a7e';
const SN_USER = 'stub.user';
const SN_CRED = 'stub-basic-7d2b9e41';

const running: RunningStub[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(running.splice(0).map((s) => s.close()));
});

async function jira(options: Partial<Parameters<typeof startJiraStub>[0]> = {}) {
  const stub = await startJiraStub({ bearer: BEARER, ...options });
  running.push(stub);
  return stub;
}

async function serviceNow(options: Partial<Parameters<typeof startServiceNowStub>[0]> = {}) {
  const stub = await startServiceNowStub({ username: SN_USER, credential: SN_CRED, ...options });
  running.push(stub);
  return stub;
}

const basic = (user: string, cred: string) => `Basic ${Buffer.from(`${user}:${cred}`).toString('base64')}`;
const finding = {
  workloadId: 'wl-1',
  workloadName: 'checkout-api',
  recommendedAction: 'Right-size',
  projectedMonthlyImpact: 1234,
};
const jiraCreate = (stub: RunningStub, auth = `Bearer ${BEARER}`) =>
  fetch(`${stub.baseUrl}/rest/api/2/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ fields: { project: { key: 'RATIO' }, summary: 's', description: 'd' } }),
  });
const snCreate = (stub: RunningStub, auth = basic(SN_USER, SN_CRED)) =>
  fetch(`${stub.baseUrl}/api/now/table/change_request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ short_description: 'change one', description: 'x' }),
  });
const snGet = (stub: RunningStub, query: string, auth = basic(SN_USER, SN_CRED)) =>
  fetch(`${stub.baseUrl}/api/now/table/change_request?${query}`, { headers: { Authorization: auth } });

describe('mock Jira stub', () => {
  it('jira_adapter_create_attach_status_end_to_end_against_stub', async () => {
    const state = createItsmState({ now: () => new Date('2026-01-01T00:00:00.000Z') });
    const stub = await jira({ state });
    const adapter = new JiraAdapter(stub.baseUrl, BEARER, 'RATIO');

    const created = await adapter.createChange(finding, 'Right-size');
    expect(created.provider).toBe('jira');
    expect(created.status).toBe('created');
    expect(created.ticketRef).toMatch(JIRA_ISSUE_KEY);
    expect(created.url).toBe(`${stub.baseUrl}/browse/${created.ticketRef}`);

    const attached = await adapter.attachReference({ provider: 'jira', ticketRef: created.ticketRef });
    expect(attached.ticketRef).toBe(created.ticketRef);

    const before = await adapter.getStatus(created.ticketRef);
    expect(before.status).toBe('Open');
    expect(before.updatedAt).toBe('2026-01-01T00:00:00.000Z');

    await expect(adapter.attachReference({ provider: 'jira', ticketRef: 'RATIO-999' })).rejects.toThrow(/404/);
  });

  it('jira_stub_rejects_missing_or_wrong_bearer_with_401', async () => {
    const stub = await jira();
    expect((await jiraCreate(stub, 'Bearer not-the-right-one')).status).toBe(401);
    expect((await jiraCreate(stub, `Basic ${BEARER}`)).status).toBe(401);
    const none = await fetch(`${stub.baseUrl}/rest/api/2/issue/RATIO-1`);
    expect(none.status).toBe(401);
    expect(stub.state.getJiraIssue('RATIO-1')).toBeUndefined();
    expect((await jiraCreate(stub)).status).toBe(201);
  });

  it('jira_stub_issue_keys_match_JIRA_ISSUE_KEY', async () => {
    const stub = await jira({ state: createItsmState({ defaultProjectKey: 'FIN_OPS2' }) });
    const keys: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const body = (await (await jiraCreate(stub)).json()) as { key: string };
      keys.push(body.key);
    }
    for (const key of keys) expect(key).toMatch(JIRA_ISSUE_KEY);
    expect(new Set(keys).size).toBe(keys.length);
    const got = await fetch(`${stub.baseUrl}/rest/api/2/issue/${keys[0]}`, {
      headers: { Authorization: `Bearer ${BEARER}` },
    });
    const issue = (await got.json()) as { key: string; fields: { status: { name: string }; updated: string } };
    expect(issue.key).toBe(keys[0]);
    expect(typeof issue.fields.status.name).toBe('string');
    expect(Number.isNaN(Date.parse(issue.fields.updated))).toBe(false);
  });
});

describe('mock ServiceNow stub', () => {
  it('servicenow_stub_create_returns_result_number_matching_SERVICENOW_NUMBER', async () => {
    const stub = await serviceNow();
    const res = await snCreate(stub);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { result: { number: string; sys_id: string } };
    expect(body.result.number).toMatch(SERVICENOW_NUMBER);
    expect(body.result.sys_id).toMatch(/^[0-9a-f]{32}$/);
    const second = (await (await snCreate(stub)).json()) as { result: { number: string } };
    expect(second.result.number).not.toBe(body.result.number);
    expect(second.result.number).toMatch(SERVICENOW_NUMBER);
    const bad = await fetch(`${stub.baseUrl}/api/now/table/change_request`, {
      method: 'POST',
      headers: { Authorization: basic(SN_USER, SN_CRED), 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
  });

  it('servicenow_stub_query_filters_by_number_and_honors_sysparm_fields_and_limit', async () => {
    const stub = await serviceNow();
    const numbers: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      numbers.push(((await (await snCreate(stub)).json()) as { result: { number: string } }).result.number);
    }

    const one = (await (await snGet(stub, `sysparm_query=number=${numbers[1]}&sysparm_fields=number,state&sysparm_limit=1`)).json()) as {
      result: Array<Record<string, string>>;
    };
    expect(one.result).toEqual([{ number: numbers[1], state: '-5' }]);

    const all = (await (await snGet(stub, 'sysparm_fields=number')).json()) as { result: Array<Record<string, string>> };
    expect(all.result.map((r) => r.number)).toEqual(numbers);

    const limited = (await (await snGet(stub, 'sysparm_limit=2')).json()) as { result: unknown[] };
    expect(limited.result).toHaveLength(2);

    const none = (await (await snGet(stub, 'sysparm_query=number=CHG9999999')).json()) as { result: unknown[] };
    expect(none.result).toEqual([]);

    expect((await snGet(stub, 'sysparm_query=number%5EORnumber=X')).status).toBe(400);
  });

  it('servicenow_stub_rejects_wrong_basic_auth_with_401', async () => {
    const stub = await serviceNow();
    expect((await snCreate(stub, basic(SN_USER, 'wrong-cred'))).status).toBe(401);
    expect((await snCreate(stub, basic('someone.else', SN_CRED))).status).toBe(401);
    expect((await snCreate(stub, `Bearer ${SN_CRED}`)).status).toBe(401);
    expect((await fetch(`${stub.baseUrl}/api/now/table/change_request`)).status).toBe(401);
    expect(stub.state.listServiceNowChanges()).toEqual([]);
    expect((await snCreate(stub)).status).toBe(201);
  });
});

describe('shared stub behavior', () => {
  it('stub_status_transition_is_visible_to_next_status_call', async () => {
    const all = await startMockItsm({
      jira: { bearer: BEARER },
      serviceNow: { username: SN_USER, credential: SN_CRED },
    });
    running.push(all.jira, all.serviceNow);

    const adapter = new JiraAdapter(all.jira.baseUrl, BEARER, 'RATIO');
    const created = await adapter.createChange(finding, 'Right-size');
    expect((await adapter.getStatus(created.ticketRef)).status).toBe('Open');
    expect(all.state.transitionJira(created.ticketRef, 'In Progress')).toBe(true);
    expect((await adapter.getStatus(created.ticketRef)).status).toBe('In Progress');
    expect(all.state.transitionJira('RATIO-404', 'Done')).toBe(false);

    const number = ((await (await snCreate(all.serviceNow)).json()) as { result: { number: string } }).result.number;
    expect(all.state.transitionServiceNow(number, '-1')).toBe(true);
    const row = (await (await snGet(all.serviceNow, `sysparm_query=number=${number}&sysparm_fields=state`)).json()) as {
      result: Array<{ state: string }>;
    };
    expect(row.result[0].state).toBe('-1');
    expect(all.state.transitionServiceNow('CHG0000000', '3')).toBe(false);
  });

  it('stub_failure_injection_401_429_500_and_slow_are_reproducible', async () => {
    const state = createItsmState();
    const stub = await jira({ state });
    const sn = await serviceNow({ state });

    const sequence = async () => {
      state.injectFailure({ kind: '429', times: 2 });
      state.injectFailure({ kind: '500' });
      state.injectFailure({ kind: '401' });
      const seen: number[] = [];
      for (let i = 0; i < 5; i += 1) seen.push((await jiraCreate(stub)).status);
      return seen;
    };
    const first = await sequence();
    expect(first).toEqual([429, 429, 500, 401, 201]);
    state.reset();
    expect(await sequence()).toEqual(first);

    state.injectFailure({ kind: '429' });
    const limited = await snCreate(sn);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    state.injectFailure({ kind: '500' });
    expect((await snGet(sn, 'sysparm_limit=1')).status).toBe(500);

    state.injectFailure({ kind: 'slow', delayMs: 120 });
    const started = Date.now();
    const slow = await jiraCreate(stub);
    expect(slow.status).toBe(201);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    const fast = Date.now();
    await jiraCreate(stub);
    expect(Date.now() - fast).toBeLessThan(100);

    state.injectFailure({ kind: '500', times: 3 });
    state.clearFailures();
    expect((await jiraCreate(stub)).status).toBe(201);
  });

  it('stubs_bind_loopback_only_and_refuse_a_non_loopback_host', async () => {
    const stub = await jira();
    const sn = await serviceNow();
    expect(stub.host).toBe('127.0.0.1');
    expect(stub.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(sn.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    for (const host of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', 'localhost', 'example.com', '127.0.0.1.evil.test', '']) {
      await expect(startJiraStub({ bearer: BEARER, host })).rejects.toThrow(/loopback/);
      await expect(startServiceNowStub({ username: SN_USER, credential: SN_CRED, host })).rejects.toThrow(/loopback/);
    }
  });

  it('stubs_never_log_the_authorization_header', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const entries: unknown[] = [];
    const log = (entry: unknown) => entries.push(entry);

    const wrongBearer = 'wrong-bearer-0badc0de';
    const wrongCred = 'wrong-basic-0badc0de';
    const stub = await jira({ log });
    const sn = await serviceNow({ log });
    await jiraCreate(stub);
    await jiraCreate(stub, `Bearer ${wrongBearer}`);
    await snCreate(sn);
    await snCreate(sn, basic(SN_USER, wrongCred));
    stub.state.injectFailure({ kind: '500' });
    await jiraCreate(stub);

    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const entry of entries) expect(Object.keys(entry as object).sort()).toEqual(['method', 'path', 'status']);

    const captured = JSON.stringify([
      entries,
      ...spies.map((s) => s.mock.calls),
      out.mock.calls,
      err.mock.calls,
    ]);
    for (const secret of [BEARER, wrongBearer, SN_CRED, wrongCred, basic(SN_USER, SN_CRED), basic(SN_USER, wrongCred)]) {
      expect(captured).not.toContain(secret);
    }
    expect(captured).not.toMatch(/authorization/i);
  });
});
