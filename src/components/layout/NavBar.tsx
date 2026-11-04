// Top-level navigation for the six Ratio objects (Wave 4 Slice 1).
// Thin, hairline bar — does not compete with page content.
// Owned by the shared AppShell: the `active` item is router-derived there, and
// the AI/agent launcher (purple token) lives on the right of this same bar so a
// single agent affordance sits identically on every in-scope screen.

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ThemeMenu } from './ThemeMenu';
import { TypographyMenu } from './TypographyMenu';

export const NAV_ITEMS = [
  { key: 'findings',   label: 'Value review', href: '/' },
  { key: 'overview',   label: 'Overview',   href: '/overview' },
  { key: 'workloads',  label: 'Workloads',  href: '/workloads' },
  { key: 'connectors', label: 'Connectors', href: '/connectors' },
  { key: 'frameworks', label: 'Governance', href: '/frameworks' },
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
  // On a phone the six destinations do not fit, so the row is an intentional scroll strip:
  // items snap to the start edge, a fade plus an arrow shows which side has more, and the
  // current page's item is scrolled into view. From md up the row simply wraps.
  const strip = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
  }, []);
  useEffect(() => {
    const el = strip.current;
    el?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [active, measure]);
  const nudge = (dir: -1 | 1) => strip.current?.scrollBy?.({ left: dir * (strip.current.clientWidth * 0.6), behavior: 'smooth' });
  return (
    <nav className="relative shrink-0 border-b border-edge bg-deep" aria-label="Main navigation">
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 px-3 py-2 md:flex md:min-h-10 md:flex-wrap md:gap-y-1 md:gap-x-0.5 md:py-1">
      {/* Logo mark */}
      <span className="flex items-center gap-1.5 md:mr-4">
        <span
          className="flex h-5 w-5 items-center justify-center rounded font-mono text-xs font-bold"
          style={{ background: 'var(--gate)' }}
          aria-hidden="true"
        >
          <span className="text-void">%</span>
        </span>
        <span className="font-mono text-sm font-bold tracking-tight text-txt">Ratio</span>
      </span>

      <div className="relative col-span-2 row-start-2 min-w-0 md:col-auto md:row-auto">
        <div
          ref={strip}
          onScroll={measure}
          data-testid="nav-strip"
          className="flex min-w-0 snap-x snap-proximity gap-0.5 overflow-x-auto scroll-px-8 pb-0.5 [scrollbar-width:none] md:overflow-visible md:pb-0 [&::-webkit-scrollbar]:hidden"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = item.key === active;
            return (
              <Link
                key={item.key}
                href={item.href}
                className={`shrink-0 snap-start whitespace-nowrap rounded px-2.5 py-1.5 text-sm transition-colors md:py-1 md:text-xs ${
                  isActive
                    ? 'bg-raised font-medium text-txt'
                    : 'text-sub hover:bg-raised/60 hover:text-txt'
                }`}
                aria-current={isActive ? 'page' : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
        {/* Scroll affordances: a fade plus an arrow on the side that has more items. Phones only. */}
        {more.left && (
          <button type="button" tabIndex={-1} aria-hidden="true" onClick={() => nudge(-1)} data-testid="nav-more-left" className="absolute inset-y-0 left-0 flex w-8 items-center justify-start bg-gradient-to-r from-deep via-deep/90 to-transparent pl-1 text-sub md:hidden">&#8249;</button>
        )}
        {more.right && (
          <button type="button" tabIndex={-1} aria-hidden="true" onClick={() => nudge(1)} data-testid="nav-more-right" className="absolute inset-y-0 right-0 flex w-8 items-center justify-end bg-gradient-to-l from-deep via-deep/90 to-transparent pr-1 text-sub md:hidden">&#8250;</button>
        )}
      </div>

      {/* md:[&>div:first-child]:static: ThemeMenu's own md:relative would anchor its panel to the wrapping button group; anchoring both panels to the nav keeps them inside the viewport. */}
      <div className="col-start-2 row-start-1 ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 md:col-auto md:row-auto md:[&>div:first-child]:static">
      <ThemeMenu />
      <TypographyMenu />
      {/* Single agent launcher — purple AI token, reserved warm accent untouched. */}
      {onOpenAgent && (
        <button
          type="button"
          onClick={onOpenAgent}
          aria-expanded={agentOpen}
          aria-controls={AI_PANEL_ID}
          aria-label="Ask Frank Coster"
          className="col-start-2 row-start-1 ml-auto flex items-center gap-1.5 rounded border border-purple/60 bg-purple/15 px-2.5 py-1 font-mono text-xs font-bold text-purple transition-colors hover:bg-purple/25 md:col-auto md:row-auto"
        >
          <span
            className="flex h-4 w-4 items-center justify-center rounded font-mono text-[10px] font-bold text-void"
            style={{ background: 'var(--purple)' }}
            aria-hidden="true"
          >
            F
          </span>
          <span className="md:hidden">Ask Frank</span>
          <span className="hidden md:inline">Ask Frank Coster</span>
        </button>
      )}
      </div>
      </div>
    </nav>
  );
}