// Upstream error bodies never reach API callers. Transports throw only label +
// HTTP status + a fixed reason; the body is logged server-side (console.warn,
// structured JSON) after redaction + truncation.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchChecked, parseExportText } from './focusExport';
import { createGcpBigQueryTransport } from './gcpBigQueryTransport';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchChecked — no upstream body in the thrown error', () => {
  it('throws label + status + fixed reason only, and logs the redacted body server-side', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = 'UPSTREAM-BODY-MARKER token Bearer s3cr3t-token at https://x.example/p?sig=leak';
    const fetchImpl = vi.fn(async () => new Response(body, { status: 401 })) as unknown as typeof fetch;
    const err = await fetchChecked(fetchImpl, 'https://x.example/p', {}, 'Kubernetes FOCUS endpoint').catch((e: unknown) => e);
    expect((err as Error).message).toBe('Kubernetes FOCUS endpoint returned 401 (unauthorized)');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0][0]);
    const entry = JSON.parse(logged) as Record<string, unknown>;
    expect(entry).toMatchObject({ label: 'Kubernetes FOCUS endpoint', status: 401 });
    expect(String(entry.body)).toContain('UPSTREAM-BODY-MARKER');
    expect(logged).not.toContain('s3cr3t-token');
    expect(logged).not.toContain('sig=leak');
  });
});

describe('export parsing — no upstream body in parse errors', () => {
  it('a malformed NDJSON line throws a fixed message, not the line content', () => {
    let message = '';
    try {
      parseExportText('{"BilledCost":1}\n{"a": LEAKED}\n');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/NDJSON/);
    expect(message).toMatch(/line 2/);
    expect(message).not.toContain('LEAKED');
  });
});

describe('GCP — no credential or upstream content in errors', () => {
  it('an invalid inline credential JSON does not echo its content', async () => {
    const t = createGcpBigQueryTransport({
      dataset: 'a.b',
      projectId: 'p',
      credentials: '{"private_key": "KEY-MATERIAL-MARKER", oops}',
      fetch: vi.fn() as unknown as typeof fetch,
    });
    const err = await t.ping().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/GOOGLE_APPLICATION_CREDENTIALS/);
    expect((err as Error).message).not.toContain('KEY-MATERIAL-MARKER');
  });
});
