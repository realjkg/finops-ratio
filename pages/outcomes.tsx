import Link from "next/link";
import { useStore } from "@/store/useStore";
import { OutcomesPanel } from "@/outcomes/OutcomesPanel";
export default function Outcomes() {
  const workloads = useStore((s) => s.workloads);
  const selected = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  return (
    <div className="h-full overflow-y-auto p-4 sm:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Initiative outcomes</h1>
          <p className="mt-2 text-sm text-sub">
            Baseline → evidence → full cost → business decision
          </p>
          <label className="mt-4 block text-sm">
            Outcome initiative
            <select
              className="sim-input mt-2 block max-w-full"
              value={selected}
              onChange={(e) => select(e.target.value)}
            >
              {workloads.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        </header>
        <OutcomesPanel key={selected} workloadId={selected} />
        <nav className="flex gap-5 text-sm text-unit">
          <Link href="/workspace">Cost tracking workspace</Link>
          <Link href="/reports">Reports</Link>
          <Link href="/agent-workflows">Agent workflows</Link>
          <Link href="/workloads">Workload detail</Link>
        </nav>
      </div>
    </div>
  );
}
