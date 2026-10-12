// Alert History tab — spec §3.4.6. Chronological alerts for the selected
// workload: type, message, timestamp, severity badge, action taken, and an
// acknowledge control for open alerts.

import { useMemo } from 'react';
import type { Alert, AlertSeverity } from '@/types';
import { useStore } from '@/store/useStore';
import { timeAgo } from '@/lib/format';
import { DEMO_NOW } from '@/data/workloads';
import { tint } from '@/lib/scales';

const SEVERITY: Record<AlertSeverity, { color: string; label: string }> = {
  info: { color: 'var(--unit)', label: 'INFO' },
  warning: { color: 'var(--shape)', label: 'WARNING' },
  critical: { color: 'var(--cost)', label: 'CRITICAL' },
};

export function AlertHistoryTab({ workloadId }: { workloadId: string }) {
  const alerts = useStore((s) => s.alerts);
  const acknowledgeAlert = useStore((s) => s.acknowledgeAlert);

  const list = useMemo(
    () =>
      alerts
        .filter((a) => a.workload_id === workloadId)
        .sort(
          (a, b) => new Date(b.triggered_at).getTime() - new Date(a.triggered_at).getTime(),
        ),
    [alerts, workloadId],
  );

  if (list.length === 0) {
    return (
      <p className="rounded-card border border-edge bg-slab px-4 py-8 text-center text-sm text-dim">
        No alerts for this workload. It is operating within all thresholds.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {list.map((alert) => (
        <AlertCard key={alert.id} alert={alert} onAcknowledge={acknowledgeAlert} />
      ))}
    </div>
  );
}

function AlertCard({
  alert,
  onAcknowledge,
}: {
  alert: Alert;
  onAcknowledge: (id: string) => void;
}) {
  const sev = SEVERITY[alert.severity];
  return (
    <div className="rounded-card border border-edge bg-slab px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold"
              style={{ color: sev.color, background: tint(sev.color) }}
            >
              {sev.label}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-dim">
              {alert.type.replace(/_/g, ' ')}
            </span>
            <span className="font-mono text-[10px] text-dim">
              · {timeAgo(alert.triggered_at, DEMO_NOW)}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-txt">{alert.message}</p>
          {alert.action_taken && (
            <p className="mt-1 font-mono text-[11px] text-value">→ {alert.action_taken}</p>
          )}
        </div>
        {alert.acknowledged ? (
          <span className="shrink-0 font-mono text-[10px] text-dim">
            ack · {alert.acknowledged_by}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onAcknowledge(alert.id)}
            className="shrink-0 rounded-md border border-edge px-2.5 py-1 font-mono text-[10px] font-bold uppercase text-sub transition-colors hover:border-unit hover:text-unit"
          >
            Acknowledge
          </button>
        )}
      </div>
    </div>
  );
}

