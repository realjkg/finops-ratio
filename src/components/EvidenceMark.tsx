// EvidenceMark — the quiet provenance mark (audit C1/C8 un-walling, Wave-1).
// A small token-colored status word rendered next to a value ratio. Deliberately
// NOT a signature component: no background, no border, no motion — a one-word
// honesty chip. Renders nothing when no evidence status exists (the UI never
// invents provenance).

import type { EvidenceStatus } from '@/types';
import { EVIDENCE_META } from '@/lib/valueEvidence';

export function EvidenceMark({
  status,
  className = '',
}: {
  status?: EvidenceStatus;
  className?: string;
}) {
  if (!status) return null;
  const meta = EVIDENCE_META[status];
  return (
    <span
      className={`font-mono text-[9px] uppercase tracking-wider ${className}`}
      style={{ color: meta.color }}
      title={meta.title}
    >
      {meta.label}
    </span>
  );
}
