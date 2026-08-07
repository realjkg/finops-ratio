// Top-level navigation for the six Ratio objects (Wave 4 Slice 1).
// Thin, hairline bar — does not compete with page content.
// Owned by the shared AppShell: the `active` item is router-derived there, and
// the AI/agent launcher (purple token) lives on the right of this same bar so a
// single agent affordance sits identically on every in-scope screen.

export const NAV_ITEMS = [
  { key: 'findings',   label: 'Findings',   href: '/' },
  { key: 'overview',   label: 'Overview',   href: '/overview' },
  { key: 'workloads',  label: 'Workloads',  href: '/workloads' },
  { key: 'connectors', label: 'Connectors', href: '/connectors' },
  { key: 'frameworks', label: 'Frameworks', href: '/frameworks' },
  { key: 'reports',    label: 'Reports',    href: '/reports' },
] as const;

export type NavKey = (typeof NAV_ITEMS)[number]['key'];

// The ChatPanel's <aside> id — referenced by the launcher for aria-controls.
const AI_PANEL_ID = 'ai-chat-panel';

export function NavBar({
  active,
  onOpenAgent,
  agentOpen,
}: {
  active?: NavKey;
  /** When provided, renders the single top-bar agent launcher on the right. */
  onOpenAgent?: () => void;
  agentOpen?: boolean;
}) {
  return (
    <nav
      className="flex h-10 shrink-0 items-center gap-0.5 border-b border-edge bg-deep px-3"
      aria-label="Main navigation"
    >
      {/* Logo mark */}
      <span className="mr-4 flex items-center gap-1.5">
        <span
          className="flex h-5 w-5 items-center justify-center rounded font-mono text-xs font-bold"
          style={{ background: 'var(--gate)' }}
          aria-hidden="true"
        >
          <span className="text-white">%</span>
        </span>
        <span className="font-mono text-sm font-bold tracking-tight text-txt">Ratio</span>
      </span>

      {NAV_ITEMS.map((item) => {
        const isActive = item.key === active;
        return (
          <a
            key={item.key}
            href={item.href}
            className={`rounded px-2.5 py-1 font-mono text-xs transition-colors ${
              isActive
                ? 'bg-raised text-txt'
                : 'text-sub hover:bg-raised/60 hover:text-txt'
            }`}
            aria-current={isActive ? 'page' : undefined}
          >
            {item.label}
          </a>
        );
      })}

      {/* Single agent launcher — purple AI token, reserved warm accent untouched. */}
      {onOpenAgent && (
        <button
          type="button"
          onClick={onOpenAgent}
          aria-expanded={agentOpen}
          aria-controls={AI_PANEL_ID}
          className="ml-auto flex items-center gap-1.5 rounded border border-purple/60 bg-purple/15 px-2.5 py-1 font-mono text-xs font-bold text-purple transition-colors hover:bg-purple/25"
        >
          <span
            className="flex h-4 w-4 items-center justify-center rounded font-mono text-[10px] font-bold text-void"
            style={{ background: 'var(--purple)' }}
            aria-hidden="true"
          >
            R
          </span>
          Ask Ratio AI
        </button>
      )}
    </nav>
  );
}