// Top-level navigation for the six Ratio objects (Wave 4 Slice 1).
// Thin, hairline bar — does not compete with page content.
// Owned by the shared AppShell: the `active` item is router-derived there, and
// the AI/agent launcher (purple token) lives on the right of this same bar so a
// single agent affordance sits identically on every in-scope screen.

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ThemeMenu } from './ThemeMenu';
import { TypographyMenu } from './TypographyMenu';
import { DemoBadge } from './DemoBadge';

export const NAV_ITEMS = [
  { key: 'findings',   label: 'Value review', href: '/' },
  { key: 'overview',   label: 'Overview',   href: '/overview' },
  { key: 'workloads',  label: 'Workloads',  href: '/workloads' },
  { key: 'connectors', label: 'Connectors', href: '/connectors' },
  { key: 'frameworks', label: 'Governance', href: '/frameworks' },
  { key: 'reports',    label: 'Reports',    href: '/reports' },
] as const;

/** Browser tab, bookmark and screen-reader title for an in-scope route, e.g. "Governance · Ratio". */
export function pageTitle(pathname: string): string {
  const item = NAV_ITEMS.find((i) => i.href === pathname);
  return item ? `${item.label} · Ratio` : 'Ratio';
}

export type NavKey = (typeof NAV_ITEMS)[number]['key'];

// The ChatPanel's <aside> id — referenced by the launcher for aria-controls.
const AI_PANEL_ID = 'ai-chat-panel';

export function NavBar({
  active,
  onOpenAgent,
  agentOpen,
  demo = false,
}: {
  active?: NavKey;
  /** Shows the single "Demo" badge beside the logo (every demo page; never in engagement mode). */
  demo?: boolean;
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
    // Centre the current item in the strip (never scrolls the page itself). Done again once web
    // fonts have loaded, because the labels get wider and an item measured earlier can end up cut.
    const reveal = () => {
      const cur = el?.querySelector<HTMLElement>('[aria-current="page"]');
      if (el && cur) el.scrollLeft = Math.ceil(cur.offsetLeft - (el.clientWidth - cur.offsetWidth) / 2);
      measure();
    };
    reveal();
    let live = true;
    void document.fonts?.ready.then(() => live && reveal());
    window.addEventListener('resize', reveal);
    return () => {
      live = false;
      window.removeEventListener('resize', reveal);
    };
  }, [active, measure]);
  return (
    <nav className="relative shrink-0 border-b border-edge bg-deep" aria-label="Main navigation">
      {/* Phones: one top row (logo, Demo badge, Display, Text, Ask Frank) above the nav strip. Below 400px
          Ask Frank is icon-only (its accessible name is unchanged) and the gaps tighten, so the row fits at 320px. */}
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-2 px-3 py-2 min-[400px]:gap-x-3 md:flex md:min-h-10 md:flex-wrap md:gap-y-1 md:gap-x-0.5 md:py-1">
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
        {demo && <DemoBadge />}
      </span>

      <div className="col-span-2 row-start-2 flex min-w-0 items-stretch md:col-auto md:row-auto">
        {/* Gutters hold the arrows, so they never sit on top of a label. Phones only; the space
            is reserved (invisible, not removed) so the strip does not jump when an arrow appears. */}
        <span aria-hidden="true" data-testid="nav-more-left" className={`flex w-5 shrink-0 items-center justify-start bg-gradient-to-r from-deep to-transparent text-sub md:hidden ${more.left ? '' : 'invisible'}`}>&#8249;</span>
        <div
          ref={strip}
          onScroll={measure}
          data-testid="nav-strip"
          className="flex min-w-0 flex-1 snap-x snap-proximity gap-0.5 overflow-x-auto scroll-px-2 pb-0.5 pr-1 [scrollbar-width:none] md:overflow-visible md:pb-0 [&::-webkit-scrollbar]:hidden"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = item.key === active;
            return (
              <Link
                key={item.key}
                href={item.href}
                className={`flex shrink-0 snap-start items-center whitespace-nowrap rounded px-2.5 py-1.5 text-sm transition-colors max-md:min-h-11 md:py-1 md:text-xs ${
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
        <span aria-hidden="true" data-testid="nav-more-right" className={`flex w-5 shrink-0 items-center justify-end bg-gradient-to-l from-deep to-transparent text-sub md:hidden ${more.right ? '' : 'invisible'}`}>&#8250;</span>
      </div>

      {/* md:[&>div:first-child]:static: ThemeMenu's own md:relative would anchor its panel to the wrapping button group; anchoring both panels to the nav keeps them inside the viewport. */}
      <div className="col-start-2 row-start-1 ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5 min-[400px]:gap-2 md:col-auto md:row-auto md:[&>div:first-child]:static">
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
          className="col-start-2 row-start-1 ml-auto flex items-center justify-center gap-1.5 rounded border border-purple/60 bg-purple/15 px-2.5 py-1 max-md:min-h-11 max-md:min-w-11 max-[399px]:px-0 font-mono text-xs font-bold text-purple transition-colors hover:bg-purple/25 md:col-auto md:row-auto"
        >
          <span
            className="flex h-4 w-4 items-center justify-center rounded font-mono text-[10px] font-bold text-void"
            style={{ background: 'var(--purple)' }}
            aria-hidden="true"
          >
            F
          </span>
          <span className="hidden min-[400px]:inline md:hidden" data-testid="ask-frank-short">Ask Frank</span>
          <span className="hidden md:inline">Ask Frank Coster</span>
        </button>
      )}
      </div>
      </div>
    </nav>
  );
}