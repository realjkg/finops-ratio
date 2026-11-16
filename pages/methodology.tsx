// How Value / cost is calculated (route /methodology). Read-only documentation
// page: the formula, where every input comes from, the evidence labels, and a
// worked example per workload. Every number is computed from the same store
// records and the same functions as Value review, so it cannot drift from it.

import { useMemo } from 'react';
import { EvidenceMark } from '@/components/EvidenceMark';
import { formatPct, formatRatio, formatUSD } from '@/lib/format';
import { EVIDENCE_META } from '@/lib/valueEvidence';
import type { EvidenceStatus } from '@/types';
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

// What each label means. The count of inputs carrying it is computed from the data shown, never typed.
const EVIDENCE_TEXT: Record<EvidenceStatus, string> = {
  measured: 'Recorded from a source of record and checked independently.',
  projected: 'A forward-looking estimate that has not been checked against results yet.',
  assumed: 'A stated assumption, shown in the app as Estimated value. An input with no label counts here too.',
};
const money2 = (n: number) => `$${n.toFixed(2)}`;
const rate = (n: number) => `$${n} per million`;

const fmtInput = (i: InputTrace) => (i.format === 'pct' ? formatPct(i.value, 1) : formatUSD(i.value));
const fmtStep = (s: StepTrace) => (s.format === 'ratio' ? (s.value === null ? 'N/A' : `${s.value.toFixed(3)}× (shown as ${formatRatio(s.value)})`) : formatUSD(s.value ?? 0));

export default function Methodology() {
  const workloads = useStore((s) => s.workloads);
  const ledger = useStore((s) => s.simulation?.state.ledger);
  const traces = useMemo(() => traceAll(workloads, ledger), [workloads, ledger]);
  const inWorkspace = ledger !== undefined;
  const matching = traces.filter((t) => t.check.matches).length;
  const valueInputs = traces.flatMap((t) => t.inputs.filter((i) => i.evidence !== null));
  const countOf = (s: EvidenceStatus) => valueInputs.filter((i) => i.evidence === s).length;
  const portfolio = useMemo(() => {
    const value = workloads.reduce((sum, w) => sum + w.value.total_value, 0);
    const cost = workloads.reduce((sum, w) => sum + w.costs.monthly_spend, 0);
    return { value, cost, ratio: cost > 0 ? value / cost : null };
  }, [workloads]);

  return (
    <div className="h-full overflow-y-auto bg-void font-body text-txt">
      <main className="mx-auto max-w-5xl space-y-8 px-6 py-6">
        <header>
          <h1 className="text-lg font-bold text-txt">How Value / cost is calculated</h1>
          <p className="mt-1 max-w-3xl text-sm text-sub">
            Each workload&apos;s Value / cost comes from the inputs on this page and one formula, and the portfolio figure is built from those. The
            page reads the same records and runs the same calculation as Value review, so its numbers match. The Total cost of AI view on a
            workload adds estimated implementation, oversight and labor costs; that estimate is explained on the workload, not here.
          </p>
        </header>

        <section aria-labelledby="data-status" data-testid="methodology-data-status" className="rounded-card border border-edge bg-slab px-4 py-3 text-sm">
          <h2 id="data-status" className="font-medium text-txt">What this data is</h2>
          {inWorkspace ? (
            <p className="mt-1 text-sub">
              You are in a simulation workspace. Value inputs were copied from the demo dataset when the workspace was created and are stated
              assumptions, not measurements. Cost is the sum of the cost postings recorded in this workspace so far this month. The periods
              differ: Value / cost divides a whole month of value by cost recorded to date.
            </p>
          ) : (
            <p className="mt-1 text-sub">
              This is the demo dataset. Every value input is a stated assumption in a dataset record, not a measurement, and cost is a modeled monthly
              figure, not a bill. No customer data is shown.
            </p>
          )}
          <p className="mt-2 text-sub" data-testid="methodology-source-check">
            {inWorkspace ? 'Source check' : 'Dataset check'}: {matching} of {traces.length} workloads match, to the cent.
            {matching < traces.length && ' The differences are listed in each worked example below.'}
          </p>
          <p className="mt-1 text-xs text-sub">
            {inWorkspace
              ? 'Cost is checked against the sum of the workspace\u2019s cost postings, and value inputs against the dataset record they were copied from.'
              : 'In the demo, this confirms that the figures in use match the dataset file and that each stored headline equals what its inputs give. It does not show that the dataset itself is right: the dataset is illustrative.'}
            {' '}Every workload is also checked so that its stored estimated value and Value / cost equal the calculation from its inputs.
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

        <section aria-labelledby="portfolio">
          <h2 id="portfolio" className="text-base font-bold text-txt">Portfolio Value / cost</h2>
          <p className="mt-2 text-sm text-sub" data-testid="methodology-portfolio">
            The portfolio figure adds up each workload&apos;s estimated value (rounded to the dollar) and divides by the total cost. It is not an
            average of the workload ratios. Now: {formatUSD(portfolio.value)} ÷ {formatUSD(portfolio.cost)} ={' '}
            <span className="font-mono text-txt">{portfolio.ratio === null ? 'N/A' : `${portfolio.ratio.toFixed(3)}×`}</span>.
          </p>
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
                <tr><th scope="row" className="py-1.5 pr-4 font-normal text-txt">Cost</th><td className="py-1.5 pr-4">Modeled monthly cost stated in the dataset record. The daily cost is modeled separately from token counts × model list price.</td><td className="py-1.5">Sum of the cost postings recorded in the workspace, month to date. Value inputs cover the whole month, so the two periods differ.</td></tr>
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
          <ul className="mt-2 space-y-1 text-sm text-sub" data-testid="methodology-evidence">
            {(['measured', 'projected', 'assumed'] as const).map((s) => (
              <li key={s}>
                <span className="font-medium" style={{ color: EVIDENCE_META[s].color }}>{EVIDENCE_META[s].label}.</span> {EVIDENCE_TEXT[s]}{' '}
                {countOf(s)} of the {valueInputs.length} value inputs on this page.
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-sub">A Value / cost figure carries the weakest label of its value inputs.</p>
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
        <thead className="text-dim"><tr><th scope="col" className="py-1 pr-3 font-medium">Step</th><th scope="col" className="py-1 pr-3 font-medium">Formula</th><th scope="col" className="py-1 text-right font-medium">Result</th></tr></thead>
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
        <p className="mt-3 text-xs text-sub" data-testid={`daily-${t.id}`}>
          Modeled daily cost today, from list prices in the model registry: input {t.dailyCost.inputTokens.toLocaleString('en-US')} tokens at{' '}
          {rate(t.dailyCost.inputPer1m)} = {money2(t.dailyCost.inputCost)}; output {t.dailyCost.outputTokens.toLocaleString('en-US')} tokens at{' '}
          {rate(t.dailyCost.outputPer1m)} = {money2(t.dailyCost.outputCost)}; cached {t.dailyCost.cachedTokens.toLocaleString('en-US')} tokens at{' '}
          {rate(t.dailyCost.cachedPer1m)} = {money2(t.dailyCost.cachedCost)}; infrastructure overhead, 5% of the input and output cost ={' '}
          {money2(t.dailyCost.compute)}. Total, rounded to the cent: <span className="font-mono text-txt">{money2(t.dailyCost.dailySpend)}</span>. Value / cost
          uses the stated monthly cost above, not this daily figure.
        </p>
      )}

      <p className="mt-2 text-xs" data-testid={`check-${t.id}`}>
        {t.check.matches ? (
          <span className="text-sub">Check passed: {t.check.checked}.</span>
        ) : (
          <span className="text-cost">Check found differences: {t.check.differences.join(' ')}</span>
        )}
      </p>
    </section>
  );
}
