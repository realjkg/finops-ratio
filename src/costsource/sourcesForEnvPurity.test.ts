// M2 — sourcesForEnv(env) is a pure function of `env`: no connector spec may
// capture process.env at module init, so a caller that supplies its own env
// (e.g. the client render's `{}`) never sees server env leak into descriptors.

import { describe, expect, it, vi } from 'vitest';

// Every env var any registered source reads (connector anchors, credentials,
// optional settings, kill-switches, PointFive flag + OAuth).
const SERVER_ENV: Record<string, string> = {
  AZURE_FOCUS_EXPORT_URL: 'https://acct.blob.core.windows.net/exports',
  AZURE_FOCUS_SAS: 'sv=1&sig=x',
  AWS_FOCUS_EXPORT_BUCKET: 'bucket',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secret',
  GCP_FOCUS_BQ_DATASET: 'billing.focus',
  GCP_PROJECT_ID: 'proj',
  GOOGLE_APPLICATION_CREDENTIALS: '/secrets/gcp.json',
  KUBERNETES_FOCUS_ENDPOINT: 'http://opencost/focus',
  KUBERNETES_FOCUS_TOKEN: 'k8s',
  NUTANIX_ENDPOINT: 'https://ncm/api',
  NUTANIX_API_KEY: 'ntnx',
  COSTSOURCE_POINTFIVE_LIVE: 'true',
  POINTFIVE_OAUTH_CLIENT_ID: 'id',
  POINTFIVE_OAUTH_CLIENT_SECRET: 'secret',
  POINTFIVE_OAUTH_TOKEN_URL: 'https://auth.example/token',
};

async function freshSourcesForEnvEmpty(env: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    vi.resetModules();
    const { sourcesForEnv } = await import('./seed');
    return sourcesForEnv({});
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('M2 — sourcesForEnv is pure over the supplied env', () => {
  it('sourcesForEnv({}) is identical whether or not process.env is populated at module init', async () => {
    const clean = await freshSourcesForEnvEmpty({});
    const polluted = await freshSourcesForEnvEmpty(SERVER_ENV);
    expect(polluted).toEqual(clean);
    // And with the server env in process.env, `{}` still reports nothing live.
    expect(polluted.filter((s) => s.configured).map((s) => s.id).sort()).toEqual([
      'focus-file-sandbox',
      'pointfive-sandbox',
      'servicenow-sandbox',
    ]);
  });
});
