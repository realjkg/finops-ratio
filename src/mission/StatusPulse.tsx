// Mission status indicator (Ratio v2 Workstream 1 / Wave3a). Keyed to workload
// status using the durable semantic tokens. All three states render a static,
// color-coded dot — no pulse rings, no Lottie. The size prop controls the outer
// bounding box; the dot occupies 36% of that area, consistent with the card grid.
import { TOKEN_COLOR } from '@/lib/scales';
import type { MissionStatus } from './missionModel';

const STATUS_COLOR: Record<MissionStatus, string> = {
  nominal: TOKEN_COLOR.value,
  caution: TOKEN_COLOR.shape,
  critical: TOKEN_COLOR.cost,
  na: 'var(--sub)',
};

const STATUS_LABEL: Record<MissionStatus, string> = {
  nominal: 'On track',
  caution: 'At risk',
  critical: 'Critical',
  na: 'Budget N/A',
};

interface StatusPulseProps {
  status: MissionStatus;
  size?: number;
}

export function StatusPulse({ status, size = 28 }: StatusPulseProps) {
  const color = STATUS_COLOR[status];
  const dot = Math.round(size * 0.36);

  return (
    <span
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${STATUS_LABEL[status]} status`}
    >
      <span
        className="rounded-full"
        style={{ width: dot, height: dot, backgroundColor: color }}
      />
    </span>
  );
}
