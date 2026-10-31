// @vitest-environment jsdom
// R2 report page, browser side: sign-in links, the report fetched only from
// the slice-C route (same-origin cookie, no token anywhere), export links only
// with reports:export, fixed messages for 401/403/429/5xx. SYNTHETIC model.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngagementReportPage } from './EngagementReportPage';

const MODEL = { schema: 'ratio.engagement-report/1', title: 'SYNTHETIC engagement report', period: '2024-09', generatedAt: '2026-11-01T00:00:00Z',
  sections: [{ id: 'totals', title: 'Totals by currency', columns: ['Currency', 'Billed'], rows: [['USD', '123.45']] }] };
const reply = (status: number, body: unknown = {}) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EngagementReportPage', () => {
  it('signin: one link per enabled connection to the OIDC start route; nothing else', () => {
    render(<EngagementReportPage state="signin" connections={['idp-a', 'idp b']} />);
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/api/auth/oidc/start?connection=idp-a', '/api/auth/oidc/start?connection=idp%20b']);
    cleanup();
    render(<EngagementReportPage state="signin" connections={[]} />);
    expect(screen.getByText(/No sign-in connection is configured/)).toBeTruthy();
  });

  it('ready: fetches the JSON report for the period from the report route with the session cookie and renders it; exports only with permission', async () => {
    const fetchMock = vi.fn(() => reply(200, MODEL));
    vi.stubGlobal('fetch', fetchMock);
    render(<EngagementReportPage state="ready" displayName="SYNTHETIC a" canExport defaultPeriod="2024-09" />);
    await waitFor(() => expect(screen.getByText('123.45')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/reports/engagement?period=2024-09&format=json', { credentials: 'same-origin', cache: 'no-store' });
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/api/v1/reports/engagement?period=2024-09&format=xlsx', '/api/v1/reports/engagement?period=2024-09&format=pdf']);
    fireEvent.change(screen.getByLabelText('Billing month'), { target: { value: '2024-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load report' }));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/reports/engagement?period=2024-10&format=json', { credentials: 'same-origin', cache: 'no-store' }));
    cleanup();
    vi.stubGlobal('fetch', vi.fn(() => reply(200, MODEL)));
    render(<EngagementReportPage state="ready" displayName="SYNTHETIC v" canExport={false} defaultPeriod="2024-09" />);
    await waitFor(() => expect(screen.getByText('123.45')).toBeTruthy());
    expect(screen.queryAllByRole('link')).toEqual([]);
  });

  it('fixed messages for an ended session, a denial, the rate limit and an unavailable report; denied and unavailable states', async () => {
    for (const [status, text] of [[401, /session has ended/], [403, /does not have access/], [429, /Too many requests/], [500, /unavailable/]] as const) {
      vi.stubGlobal('fetch', vi.fn(() => reply(status, { error: { code: 'x', message: 'SERVER-TEXT' } })));
      render(<EngagementReportPage state="ready" displayName="SYNTHETIC a" canExport defaultPeriod="2024-09" />);
      await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(text));
      expect(document.body.textContent).not.toContain('SERVER-TEXT');
      cleanup();
    }
    render(<EngagementReportPage state="denied" />);
    expect(screen.getByText(/does not have access/)).toBeTruthy();
    cleanup();
    render(<EngagementReportPage state="unavailable" />);
    expect(screen.getByText(/temporarily unavailable/)).toBeTruthy();
  });
});
