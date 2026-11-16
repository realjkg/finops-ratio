// How Value / cost is calculated (route /methodology). Read-only documentation
// page: the formula, where every input comes from, the evidence labels, and a
// worked example per workload. Every number is computed from the same store
// records and the same functions as Value review, so it cannot drift from it.

import { useMemo } from 'react';
import { EvidenceMark } from '@/components/EvidenceMark';
import { formatPct, formatRatio, formatUSD } from '@/lib/format';
import { EVIDENCE_META } from '@/lib/valueEvidence';
import { VALUE_MINIMUM } from '@/findings/recommendationMath';
import {
  DEMO_DATASET_FILE,
  VALUE_DERIVATION_DOC,
  traceAll,
  type InputTrace,
  type StepTrace,
  type WorkloadTrace,
} from '@/methodology/valueSources';
import { useStore } from '@/store/useStore';

const fmtInput = (i: InputTrace) => (i.format === 'pct' ? formatPct(i.value, 1) : formatUSD(i.value));
const fmtStep = (s: StepTrace) => (s.format === 'ratio' ? (s.value === null ? 'N/A' : `${s.value.toFixed(3)}× (shown as ${formatRatio(s.value)})`) : formatUSD(s.value ?? 0));

export default function Methodology() {
  const workloads = useStore((s) => s.workloads);
  const ledger = useStore((s) => s.simulation?.state.ledger);
  const traces = useMemo(() => traceAll(workloads, ledger), [workloads, ledger]);
  const inWorkspace = ledger !== undefined;
  const matching = traces.filter((t) => t.check.matches).length;

  return (
    <div className="h-full overflow-y-auto bg-void font-body text-txt">
      <main className="mx-auto max-w-5xl space-y-8 px-6 py-6">
        <header>
          <h1 className="text-lg font-bold text-txt">How Value / cost is calculated</h1>
          <p className="mt-1 max-w-3xl text-sm text-sub">
            Every Value / cost figure in the app comes from the inputs on this page and one formula. The page reads the same records and runs the
            same calculation as Value review, so the numbers here match the rest of the app.
          </p>
        </header>

        <section aria-labelledby="data-status" data-testid="methodology-data-status" className="rounded-card border border-edge bg-slab px-4 py-3 text-sm">
          <h2 id="data-status" className="font-medium text-txt">What this data is</h2>
          {inWorkspace ? (
            <p className="mt-1 text-sub">
              You are in a simulation workspace. Value inputs were copied from the demo dataset when the workspace was created and are stated
              assumptions, not measurements. Cost is the sum of the cost postings recorded in this workspace.
            </p>
          ) : (
            <p className="mt-1 text-sub">
              This is the demo dataset. Every value input is a stated assumption in a dataset record, not a measurement, and cost is a modeled monthly
              figure, not a bill. No customer data is shown.
            </p>
          )}
          <p className="mt-2 text-sub" data-testid="methodology-source-check">
            Source check: {matching} of {traces.length} workloads match their source records.
            {matching < traces.length && ' The differences are listed in each worked example below.'}
          </p>
        </section>

        <section aria-labelledby="formula">
          <h2 id="formula" className="text-base font-bold text-txt">The formula</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-sub">
            <li><span className="text-txt">Gross value</span> = protected revenue + avoided cost.</li>
            <li><span className="text-txt">Counted value</span> = gross value × quality-floor pass rate. Outputs below the quality floor count for nothing. The rate is applied once.</li>
            <li><span className="text-txt">Adjusted value</span> = counted value − harm from misses (refunds, rework, manual cleanup). It can be negative.</li>
            <li>
              <span className="text-txt">Value / cost</span> = adjusted value ÷ cost for the same period. Break-even is 1×. The configured policy target is{' '}
              {VALUE_MINIMUM}×. Displayed figures are rounded to one decimal; the unrounded figure is in each example below and in View calculation.
            </li>
          </ol>
        </section>

        <section aria-labelledby="sources">
          <h2 id="sources" className="text-base font-bold text-txt">Where each input comes from</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs text-dim">
                <tr><th scope="col" className="py-1 pr-4 font-medium">Input</th><th scope="col" className="py-1 pr-4 font-medium">Demo dataset</th><th scope="col" className="py-1 font-medium">Simulation workspace</th></tr>
              </thead>
              <tbody className="divide-y divide-edge text-sub">
                <tr><th scope="row" className="py-1.5 pr-4 font-normal text-txt">Protected revenue, avoided cost</th><td className="py-1.5 pr-4">Stated in the workload&apos;s dataset record as a value multiple of its stated monthly cost, split between the two.</td><td className="py-1.5">Copied from the dataset record.</td></tr>
                <tr><th scope="row" className="py-1.5 pr-4 font-normal text-txt">Quality-floor pass rate</th><td className="py-1.5 pr-4">Stated in the dataset record. Not measured from graded outputs.</td><td className="py-1.5">Copied from the dataset record.</td></tr>
                <tr><th scope="row" className="py-1.5 pr-4 font-normal text-txt">Harm from misses</th><td className="py-1.5 pr-4">Stated in the dataset record. Not measured from refund or rework records.</td><td className="py-1.5">Copied from the dataset record.</td></tr>
                <tr><th scope="row" className="py-1.5 pr-4 font-normal text-txt">Cost</th><td className="py-1.5 pr-4">Modeled monthly cost stated in the dataset record. The daily cost is modeled separately from token counts × model list price.</td><td className="py-1.5">Sum of the cost postings recorded in the workspace, month to date.</td></tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-sm text-sub">
            The value inputs cannot be entered or edited in the app today. In the demo they come from the dataset file{' '}
            <code className="font-mono text-xs text-txt">{DEMO_DATASET_FILE}</code>; each worked example names its record.
          </p>
        </section>

        <section aria-labelledby="evidence">
          <h2 id="evidence" className="text-base font-bold text-txt">Evidence labels</h2>
          <ul className="mt-2 space-y-1 text-sm text-sub">
            {(['measured', 'projected', 'assumed'] as const).map((s) => (
              <li key={s} className="flex items-baseline gap-2"><EvidenceMark status={s} /><span>{EVIDENCE_META[s].title}</span></li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-sub">A Value / cost figure carries the weakest label of its value inputs. An input with no label counts as assumed.</p>
        </section>

        <section aria-labelledby="examples">
          <h2 id="examples" className="text-base font-bold text-txt">Worked examples, one per workload</h2>
          <div className="mt-3 space-y-6">
            {traces.map((t) => <WorkedExample key={t.id} t={t} />)}
          </div>
        </section>

        <section aria-labelledby="docs" className="border-t border-edge pt-4 text-sm text-sub">
          <h2 id="docs" className="text-base font-bold text-txt">Documentation</h2>
          <p className="mt-1">
            The method, its limits and the open decisions are in <code className="font-mono text-xs text-txt">{VALUE_DERIVATION_DOC}</code> in the product
            repository. That document is a proposal; this page describes what the app calculates today.
          </p>
        </section>
      </main>
    </div>
  );
}

function WorkedExample({ t }: { t: WorkloadTrace }) {
  return (
    <section id={t.anchor} aria-labelledby={`${t.anchor}-h`} data-testid={`calc-example-${t.id}`} className="scroll-mt-4 rounded-card border border-edge bg-slab px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${t.anchor}-h`} className="font-medium text-txt">{t.name}</h3>
        <span className="font-mono text-xs text-dim">
          {t.origin === 'simulation_workspace' ? 'Workspace record' : 'Dataset record'} {t.id}
        </span>
      </div>

      <table className="mt-2 w-full text-left text-xs">
        <caption className="sr-only">Inputs for {t.name}</caption>
        <thead className="text-dim"><tr><th scope="col" className="py-1 pr-3 font-medium">Input</th><th scope="col" className="py-1 pr-3 text-right font-medium">Value</th><th scope="col" className="py-1 pr-3 font-medium">Evidence</th><th scope="col" className="py-1 font-medium">Source</th></tr></thead>
        <tbody className="divide-y divide-edge">
          {t.inputs.map((i) => (
            <tr key={i.key} data-testid={`input-${t.id}-${i.key}`}>
              <th scope="row" className="py-1.5 pr-3 font-normal text-txt">{i.label}</th>
              <td className="py-1.5 pr-3 text-right font-mono text-txt">{fmtInput(i)}</td>
              <td className="py-1.5 pr-3">{i.evidence ? <EvidenceMark status={i.evidence} unmarked={i.unmarked ? [i.key] : undefined} /> : <span className="text-dim">Cost, not a value input</span>}</td>
              <td className="py-1.5 text-sub">{i.origin}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="mt-3 w-full text-left text-xs">
        <caption className="sr-only">Calculation for {t.name}</caption>
        <tbody className="divide-y divide-edge">
          {t.steps.map((s) => (
            <tr key={s.label} data-testid={`step-${t.id}-${s.label}`}>
              <th scope="row" className="py-1.5 pr-3 font-normal text-txt">{s.label}</th>
              <td className="py-1.5 pr-3 text-sub">{s.formula}</td>
              <td className="py-1.5 text-right font-mono text-txt">{fmtStep(s)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {t.dailyCost && (
        <p className="mt-3 text-xs text-sub">
          Modeled daily cost today: {t.dailyCost.inputTokens.toLocaleString('en-US')} input tokens at ${t.dailyCost.inputPer1m} per million,{' '}
          {t.dailyCost.outputTokens.toLocaleString('en-US')} output tokens at ${t.dailyCost.outputPer1m} per million, and{' '}
          {t.dailyCost.cachedTokens.toLocaleString('en-US')} cached tokens at ${t.dailyCost.cachedPer1m} per million, plus 5% infrastructure overhead ={' '}
          <span className="font-mono text-txt">{formatUSD(t.dailyCost.dailySpend)}</span>. Model prices are list prices from the model registry. Value / cost
          uses the stated monthly cost above, not this daily figure.
        </p>
      )}

      <p className="mt-2 text-xs" data-testid={`check-${t.id}`}>
        {t.check.matches ? (
          <span className="text-sub">Source check passed: {t.check.checked}.</span>
        ) : (
          <span className="text-cost">Source check found differences: {t.check.differences.join(' ')}</span>
        )}
      </p>
    </section>
  );
}
