// Footer alert bar (Ratio v2 / Wave3a). Static strip showing the three most
// recent unacknowledged alerts inline — no scrolling animation. Clicking an
// alert navigates to that workload’s Alert History tab.

import { useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { timeAgo } from '@/lib/format';
import { DEMO_NOW } from '@/data/workloads';
import type { Alert, AlertSeverity } from '@/types';

const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  info: 'var(--unit)',
  warning: 'var(--shape)',
  critical: 'var(--cost)',
};

function severityIcon(severity: AlertSeverity): string {
  if (severity === 'critical') return '◉';
  if (severity === 'warning') return '△';
  return '○';
}

export function Footer() {
  const alerts = useStore((s) => s.alerts);
  const workloads = useStore((s) => s.workloads);
  const select = useStore((s) => s.select);
  const setTab = useStore((s) => s.setTab);

  // Most-recent three unacknowledged alerts, sorted descending by time.
  const top3 = useMemo(
    () =>
      [...alerts]
        .filter((a) => !a.acknowledged)
        .sort((a, b) => new Date(b.triggered_at).getTime() - new Date(a.triggered_at).getTime())
        .slice(0, 3),
    [alerts],
  );

  const nameFor = (id: string) => workloads.find((w) => w.id === id)?.name ?? id;

  const onClick = (alert: Alert) => {
    select(alert.workload_id);
    setTab('alerts');
  };

  if (top3.length === 0) return null;

  return (
    <footer className="flex min-h-8 shrink-0 items-center gap-4 border-t border-edge bg-deep px-4 py-1">
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-dim">
        Alerts
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-1">
        {top3.map((alert) => (
          <button
            key={alert.id}
            type="button"
            onClick={() => onClick(alert)}
            className="flex min-w-0 items-center gap-2 text-left text-xs text-sub transition-colors hover:text-txt"
          >
            <span style={{ color: SEVERITY_COLOR[alert.severity] }}>
              {severityIcon(alert.severity)}
            </span>
            <span className="font-mono font-medium text-txt">{nameFor(alert.workload_id)}:</span>
            <span className="min-w-0">{alert.message}</span>
            <span className="text-dim">· {timeAgo(alert.triggered_at, DEMO_NOW)}</span>
          </button>
        ))}

      </div>
    </footer>
  );
}

