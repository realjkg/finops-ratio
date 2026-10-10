// Top-level navigation for the six Ratio objects (Wave 4 Slice 1).
// Thin, hairline bar — does not compete with page content.
// Owned by the shared AppShell: the `active` item is router-derived there, and
// the AI/agent launcher (purple token) lives on the right of this same bar so a
// single agent affordance sits identically on every in-scope screen.

import Link from 'next/link';

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
    <nav className="shrink-0 border-b border-edge bg-deep" aria-label="Main navigation">
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 px-3 py-2 md:flex md:h-10 md:gap-0.5 md:py-0">
      {/* Logo mark */}
      <span className="flex items-center gap-1.5 md:mr-4">
        <span
          className="flex h-5 w-5 items-center justify-center rounded font-mono text-xs font-bold"
          style={{ background: 'var(--gate)' }}
          aria-hidden="true"
        >
          <span className="text-white">%</span>
        </span>
        <span className="font-mono text-sm font-bold tracking-tight text-txt">Ratio</span>
      </span>

      <div className="col-span-2 row-start-2 flex min-w-0 gap-0.5 overflow-x-auto pb-0.5 md:col-auto md:row-auto md:overflow-visible md:pb-0">
        {NAV_ITEMS.map((item) => {
          const isActive = item.key === active;
          return (
            <Link
              key={item.key}
              href={item.href}
              className={`shrink-0 rounded px-2.5 py-1 font-mono text-xs transition-colors ${
                isActive
                  ? 'bg-raised text-txt'
                  : 'text-sub hover:bg-raised/60 hover:text-txt'
              }`}
              aria-current={isActive ? 'page' : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </div>

      {/* Single agent launcher — purple AI token, reserved warm accent untouched. */}
      {onOpenAgent && (
        <button
          type="button"
          onClick={onOpenAgent}
          aria-expanded={agentOpen}
          aria-controls={AI_PANEL_ID}
          className="col-start-2 row-start-1 ml-auto flex items-center gap-1.5 rounded border border-purple/60 bg-purple/15 px-2.5 py-1 font-mono text-xs font-bold text-purple transition-colors hover:bg-purple/25 md:col-auto md:row-auto"
        >
          <span
            className="flex h-4 w-4 items-center justify-center rounded font-mono text-[10px] font-bold text-void"
            style={{ background: 'var(--purple)' }}
            aria-hidden="true"
          >
            F
          </span>
          Ask Frank Coster
        </button>
      )}
      </div>
    </nav>
  );
}