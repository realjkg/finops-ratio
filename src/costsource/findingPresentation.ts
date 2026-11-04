// Display wording for seeded findings. The finding title is a value in the public API contract
// (src/compat/golden/api.json) and is never edited. For the seeded "below the value target" opportunity
// the UI shows this wording instead, chosen by the finding's stable identity (type, category and the
// `...:opportunity:rightsizing:<workload id>` id), never by matching or replacing the title text.
// A finding with any other id shows its own title unchanged.

import { WORKLOADS } from '@/data/workloads';
import { VALUE_MINIMUM } from '@/findings/recommendationMath';
import { COPY, VALUE_COST_BREAK_EVEN } from '@/lib/vocabulary';

interface FindingLike {
  id: string;
  type: string;
  category: string;
  title: string;
}

export interface PresentedFinding {
  title: string;
  /** Extra lines shown beside the title; empty when the contract title is shown as is. */
  details: string[];
}

const RIGHTSIZING_ID = /:opportunity:rightsizing:([A-Za-z0-9_-]+)$/;

export function presentFinding(f: FindingLike): PresentedFinding {
  const m = f.type === 'opportunity' && f.category === 'rightsizing' ? RIGHTSIZING_ID.exec(f.id) : null;
  const workload = m ? WORKLOADS.find((w) => w.id === m[1]) : undefined;
  if (!workload) return { title: f.title, details: [] };
  return {
    title: `${workload.name} is below the configured ${VALUE_MINIMUM}\u00d7 value / cost target.`,
    details: [`Break-even: ${VALUE_COST_BREAK_EVEN}\u00d7`, `Policy target: ${VALUE_MINIMUM}\u00d7`, `Target source: Demo configuration (${COPY.targetSetBy})`],
  };
}
