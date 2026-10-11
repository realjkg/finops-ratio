// A6 — the offline sandbox allowlist is exactly six ids. Live connector ids
// must never enter it; near-miss ids must be denied.

import { describe, expect, it } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { OFFLINE_SANDBOX_SOURCE_IDS, isOfflineSandboxSource } from './sandboxSources';
import { sourcesForEnv } from './seed';
import { gateSourceAccess } from '@/server/gateway/liveDataAuth';
import { AZURE_SOURCE_ID, AWS_SOURCE_ID, GCP_SOURCE_ID } from './cloudConnectorConfig';

const EXISTING = ['pointfive-sandbox', 'focus-file-sandbox', 'servicenow-sandbox'];
const NEW = ['aws-sandbox', 'azure-sandbox', 'gcp-sandbox'];

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    setHeader() {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function fakeReq(ip: string): NextApiRequest {
  return { method: 'GET', headers: {}, socket: { remoteAddress: ip } } as unknown as NextApiRequest;
}

describe('A6 sandbox allowlist', () => {
  it('existing_three_sandbox_ids_unchanged_and_still_anonymous', () => {
    for (const id of EXISTING) {
      expect(OFFLINE_SANDBOX_SOURCE_IDS.has(id)).toBe(true);
      expect(isOfflineSandboxSource(id)).toBe(true);
    }
  });

  it('allowlist_is_exactly_the_six_sandbox_ids', () => {
    expect([...OFFLINE_SANDBOX_SOURCE_IDS].sort()).toEqual([...EXISTING, ...NEW].sort());
    expect(OFFLINE_SANDBOX_SOURCE_IDS.size).toBe(6);
  });

  it('isOfflineSandboxSource_true_for_aws_azure_gcp_sandbox', () => {
    for (const id of NEW) expect(isOfflineSandboxSource(id)).toBe(true);
  });

  it('no_live_connector_id_is_in_the_allowlist', () => {
    const live = sourcesForEnv({})
      .map((s) => s.id)
      .filter((id) => ![...EXISTING, ...NEW].includes(id));
    expect(live).toEqual(expect.arrayContaining([AZURE_SOURCE_ID, AWS_SOURCE_ID, GCP_SOURCE_ID, 'pointfive-live']));
    for (const id of live) expect(isOfflineSandboxSource(id)).toBe(false);
  });

  it('near_miss_ids_denied', () => {
    const misses = [
      'aws-sandbox ',
      ' aws-sandbox',
      'AWS-sandbox',
      'Aws-Sandbox',
      'aws-sandbox/',
      'aws-sandbox/../x',
      'aws-sandbox\n',
      'azure-sandbox ',
      'AZURE-SANDBOX',
      'azure-sandbox?x=1',
      'gcp-sandbox ',
      'GCP-sandbox',
      'gcp-sandbox/rows',
      'aws-sandbox2',
      'aws',
      '',
    ];
    for (const id of misses) expect(isOfflineSandboxSource(id)).toBe(false);
  });

  it('gateSourceAccess_passes_new_sandbox_ids_without_a_token_and_still_401s_live_ids', () => {
    const env = {};
    for (const id of NEW) {
      const res = fakeRes();
      expect(gateSourceAccess(fakeReq('10.9.0.1'), res as unknown as NextApiResponse, id, env)).toBe(true);
      expect(res.statusCode).toBe(200);
    }
    for (const id of [AZURE_SOURCE_ID, AWS_SOURCE_ID, GCP_SOURCE_ID, 'pointfive-live', 'aws-sandbox ']) {
      const res = fakeRes();
      expect(gateSourceAccess(fakeReq('10.9.0.2'), res as unknown as NextApiResponse, id, env)).toBe(false);
      expect(res.statusCode).toBe(401);
    }
  });
});
