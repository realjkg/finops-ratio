// Workloads route — the FinOps workload dashboard, rendered inside the shared
// AppShell (Wave 4 nav unification). The shell owns the six-object NavBar and
// the single agent launcher, so this page no longer carries the legacy Header
// or the superseded AgentPanel — only the workload list, detail panel, and the
// footer alert ticker. Agent access is the shell's ChatPanel, consistent with
// every other object.
import { WorkloadList } from '@/components/workload/WorkloadList';
import { DetailPanel } from '@/components/detail/DetailPanel';
import { Footer } from '@/components/layout/Footer';

export default function Workloads() {
  return (
    <div className="flex h-full flex-col bg-void font-body text-txt">
      <div className="flex min-h-0 flex-1">
        <WorkloadList />
        <DetailPanel />
      </div>
      <Footer />
    </div>
  );
}

