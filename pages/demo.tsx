import { useMemo } from 'react';
import { MissionSurface } from '@/executive/MissionSurface';
import { SpendToValueGraph } from '@/findings/SpendToValueGraph';
import { formatRatio, formatUSD } from '@/lib/format';
import { TOKEN_HEX } from '@/lib/scales';
import { useStore } from '@/store/useStore';

const DEMO_PROMPTS = [
  'Why is my spend spiking?',
  'Which workload has the worst value ratio?',
  'Which model should I switch to?',
] as const;

export default function Demo() {
  const workloads = useStore((s) => s.workloads);
  const toggleAIPanel = useStore((s) => s.toggleAIPanel);

  const snapshot = useMemo(() => {
    const monthlySpend = workloads.reduce((sum, workload) => sum + workload.costs.monthly_spend, 0);
    const totalValue = workloads.reduce((sum, workload) => sum + workload.value.total_value, 0);
    const portfolioRatio = monthlySpend > 0 ? totalValue / monthlySpend : 0;
    const belowGate = workloads.filter((workload) => workload.value.value_ratio < 3).length;

    return {
      monthlySpend,
      totalValue,
      portfolioRatio,
      belowGate,
    };
  }, [workloads]);

  return (
    <div className="h-full overflow-y-auto bg-void font-body text-txt">
      <section className="border-b border-edge bg-deep px-6 py-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-dim">
                Self-service demo
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-txt">
                Take Ratio for a spin.
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-sub">
                This is a working FinOps environment built from business requirements, not a slideshow.
                Inspect seeded AI workloads, compare spend to value, test governance and budget controls,
                and ask Ratio AI questions against the same dataset.
              </p>
            </div>

            <div className="rounded-md border border-edge bg-slab px-4 py-3 text-xs text-sub lg:max-w-sm">
              <p className="font-mono text-[10px] uppercase tracking-wider text-dim">Demo data</p>
              <p className="mt-1 leading-5">
                Deterministic seed workloads are used so every visitor sees the same business scenario.
                No cloud credentials or external API key are required.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-px overflow-hidden rounded-md border border-edge bg-edge sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Monthly AI spend" value={formatUSD(snapshot.monthlySpend)} />
            <Metric label="Business value" value={formatUSD(snapshot.totalValue)} />
            <Metric
              label="Portfolio value ratio"
              value={formatRatio(snapshot.portfolioRatio)}
              valueColor={snapshot.portfolioRatio >= 3 ? TOKEN_HEX.value : TOKEN_HEX.gate}
            />
            <Metric
              label="Below 3x value gate"
              value={`${snapshot.belowGate} of ${workloads.length}`}
              valueColor={snapshot.belowGate > 0 ? TOKEN_HEX.cost : TOKEN_HEX.value}
            />
          </div>
        </div>
      </section>

      <section className="border-b border-edge px-6 py-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-4">
            <p className="font-mono text-[10px] uppercase tracking-wider text-dim">Try it yourself</p>
            <h2 className="mt-1 text-lg font-semibold text-txt">A five-minute path through the product</h2>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <DemoStep
              number="01"
              title="Find the weak economics"
              body="Open Findings. Ratio ranks workloads by value ratio, worst first, and shows the evidence behind the recommendation."
              href="/"
              cta="Open Findings"
            />
            <DemoStep
              number="02"
              title="Test the operating controls"
              body="Open Workloads. Change budget thresholds, compare model costs, inspect unit economics, and test governance gates before scale."
              href="/workloads"
              cta="Open Workloads"
            />
            <div className="rounded-md border border-edge bg-deep p-4">
              <p className="font-mono text-[10px] text-dim">03</p>
              <h3 className="mt-3 text-sm font-semibold text-txt">Ask the FinOps question directly</h3>
              <p className="mt-2 text-xs leading-5 text-sub">
                Open Ratio AI and ask a business question. The offline demo answers from current workload data rather than returning canned prose.
              </p>
              <div className="mt-3 space-y-1.5">
                {DEMO_PROMPTS.map((prompt) => (
                  <p key={prompt} className="font-mono text-[10px] text-dim">
                    “{prompt}”
                  </p>
                ))}
              </div>
              <button
                type="button"
                onClick={toggleAIPanel}
                className="mt-4 rounded border border-purple/60 bg-purple/15 px-3 py-1.5 font-mono text-[11px] font-bold text-purple transition-colors hover:bg-purple/25"
              >
                Ask Ratio AI
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-edge bg-deep px-6 py-6">
        <div className="mx-auto max-w-6xl">
          <p className="mb-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">
            Portfolio — spend vs. value
          </p>
          <p className="mb-4 text-xs text-sub">
            Each point is a workload. Break-even is 1x; Ratio's default governance gate requires at least 3x value before scale.
          </p>
          <SpendToValueGraph workloads={workloads} size="large" />
        </div>
      </section>

      <section aria-label="Executive Ratio dashboard">
        <MissionSurface embedded />
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="bg-deep px-4 py-4">
      <p className="font-mono text-[9px] uppercase tracking-wider text-dim">{label}</p>
      <p className="mt-1 font-mono text-xl font-bold text-txt" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </p>
    </div>
  );
}

function DemoStep({
  number,
  title,
  body,
  href,
  cta,
}: {
  number: string;
  title: string;
  body: string;
  href: string;
  cta: string;
}) {
  return (
    <div className="rounded-md border border-edge bg-deep p-4">
      <p className="font-mono text-[10px] text-dim">{number}</p>
      <h3 className="mt-3 text-sm font-semibold text-txt">{title}</h3>
      <p className="mt-2 text-xs leading-5 text-sub">{body}</p>
      <a
        href={href}
        className="mt-4 inline-flex rounded border border-edge bg-raised px-3 py-1.5 font-mono text-[11px] font-bold text-txt transition-colors hover:border-dim"
      >
        {cta}
      </a>
    </div>
  );
}
