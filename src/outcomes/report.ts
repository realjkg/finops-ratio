import type { Workload } from "@/types";
import type { CostEntry } from "@/simulation/types";
import { evaluateOutcome, outcomeBasis } from "./model";
import type { OutcomeRecord } from "./types";
export interface OutcomeReportRow {
  name: string;
  record: OutcomeRecord;
  result: ReturnType<typeof evaluateOutcome>;
  decisionStale: boolean;
}
export function outcomeReportRows(
  workloads: Workload[],
  records: Record<string, OutcomeRecord>,
  ledger: CostEntry[],
): OutcomeReportRow[] {
  return workloads
    .filter((w) => records[w.id])
    .map((w) => {
      const record = records[w.id];
      const latest = record.decisions.at(-1);
      return {
        name: w.name,
        record,
        result: evaluateOutcome(record, ledger),
        decisionStale: Boolean(
          latest && latest.basis !== outcomeBasis(record, ledger, w.governance),
        ),
      };
    });
}
