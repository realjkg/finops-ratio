// @vitest-environment happy-dom
// SpendToValueGraph — hover-identify interactions.
//
// Every dot must be identifiable (identity comes from the same Workload
// records the dots encode — no invented data), the tooltip must reveal on
// hover AND keyboard focus with the workload's own values, and click (or
// Enter) must navigate via the onOpenWorkload callback — the seam the pages
// wire to select() + router.push('/workloads').

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SpendToValueGraph } from './SpendToValueGraph';
import { WORKLOADS } from '@/data/workloads';
import { formatUSD, formatRatio } from '@/lib/format';
import { ratioColor } from '@/lib/scales';
import type { Workload } from '@/types';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// A small portfolio slice — enough dots to verify identity mapping without
// dragging the whole seed set through every assertion.
const portfolio: Workload[] = WORKLOADS.slice(0, 4);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderGraph(
  onOpenWorkload?: (workloadId: string) => void,
  size: 'compact' | 'large' = 'large',
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <SpendToValueGraph
        workloads={portfolio}
        size={size}
        onOpenWorkload={onOpenWorkload}
      />,
    );
  });
}

function dotFor(id: string): SVGGElement {
  const dot = container?.querySelector<SVGGElement>(`g[data-workload-id="${id}"]`);
  if (!dot) throw new Error(`dot for workload ${id} not rendered`);
  return dot;
}

function mouseover(dot: Element) {
  act(() => {
    dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

function mouseout(dot: Element) {
  act(() => {
    dot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  });
}

// React 17+ delegates focus/blur via focusin/focusout — drive both the DOM
// API and the bubbled event so the behavior holds under either wiring.
function focus(dot: SVGElement) {
  act(() => {
    dot.focus();
    dot.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
}

function blur(dot: SVGElement) {
  act(() => {
    dot.blur();
    dot.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

function tooltip(): HTMLElement {
  const el = container?.querySelector<HTMLElement>('[role="tooltip"]');
  if (!el) throw new Error('tooltip not rendered');
  return el;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('SpendToValueGraph — dot→workload identity mapping', () => {
  it('renders one focusable dot per workload, labeled with that workload record', () => {
    renderGraph();

    const dots = container!.querySelectorAll('g[data-workload-id]');
    expect(dots.length).toBe(portfolio.length);

    for (const w of portfolio) {
      const dot = dotFor(w.id);
      expect(dot.getAttribute('tabindex')).toBe('0');
      expect(dot.getAttribute('aria-label')).toContain(w.name);
      expect(dot.getAttribute('aria-label')).toContain(
        formatUSD(w.costs.monthly_spend),
      );
      expect(dot.getAttribute('aria-label')).toContain(
        formatRatio(w.value.value_ratio),
      );
    }
  });

  it('maps the same record to the same position — highest spend rightmost, lowest ratio lowest', () => {
    renderGraph();

    const cxOf = (w: Workload) =>
      parseFloat(dotFor(w.id).querySelector('circle')!.getAttribute('cx')!);
    const cyOf = (w: Workload) =>
      parseFloat(dotFor(w.id).querySelector('circle[fill]')!.getAttribute('cy')!);

    const highestSpend = [...portfolio].sort(
      (a, b) => b.costs.monthly_spend - a.costs.monthly_spend,
    )[0];
    const lowestRatio = [...portfolio].sort(
      (a, b) => a.value.value_ratio - b.value.value_ratio,
    )[0];

    const allCx = portfolio.map(cxOf);
    expect(cxOf(highestSpend)).toBe(Math.max(...allCx));
    const allCy = portfolio.map(cyOf);
    expect(cyOf(lowestRatio)).toBe(Math.max(...allCy));
  });
});

describe('SpendToValueGraph — tooltip reveal', () => {
  it('shows no tooltip until a dot is hovered or focused', () => {
    renderGraph();
    expect(container!.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('reveals on hover with the hovered record’s name, spend, and band-colored ratio', () => {
    renderGraph();
    const w = portfolio[0];

    mouseover(dotFor(w.id));

    const tip = tooltip();
    expect(tip.textContent).toContain(w.name);
    expect(tip.textContent).toContain(formatUSD(w.costs.monthly_spend));
    expect(tip.textContent).toContain(formatRatio(w.value.value_ratio));
    const ratioEl = tip.querySelector<HTMLElement>('[data-testid="stv-tooltip-ratio"]')!;
    expect(ratioEl.style.color).toBe(ratioColor(w.value.value_ratio));

    // Calm reveal — the hovered dot carries the band-colored ring…
    const dot = dotFor(w.id);
    expect(dot.querySelectorAll('circle[stroke]').length).toBeGreaterThan(0);
    // …and a single tooltip for a single hovered dot.
    expect(container!.querySelectorAll('[role="tooltip"]').length).toBe(1);

    mouseout(dotFor(w.id));
    expect(container!.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('reveals on keyboard focus and hides on blur — same reveal, either way', () => {
    renderGraph();
    const a = portfolio[1];
    const b = portfolio[2];

    focus(dotFor(a.id));
    expect(tooltip().textContent).toContain(a.name);

    // Moving focus moves the tooltip — never two at once.
    blur(dotFor(a.id));
    expect(container!.querySelector('[role="tooltip"]')).toBeNull();
    focus(dotFor(b.id));
    expect(tooltip().textContent).toContain(b.name);
    expect(container!.querySelectorAll('[role="tooltip"]').length).toBe(1);
  });
});

describe('SpendToValueGraph — click-through navigation', () => {
  it('clicking a dot opens that workload via onOpenWorkload', () => {
    const opened: string[] = [];
    renderGraph((id) => opened.push(id));
    const w = portfolio[2];

    act(() => {
      dotFor(w.id).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(opened).toEqual([w.id]);
  });

  it('Enter on a focused dot opens that workload — keyboard parity with click', () => {
    const opened: string[] = [];
    renderGraph((id) => opened.push(id));
    const w = portfolio[0];

    act(() => {
      dotFor(w.id).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(opened).toEqual([w.id]);
  });

  it('without onOpenWorkload (static embed) clicking is inert but the tooltip still reveals', () => {
    renderGraph(undefined);
    const w = portfolio[3];
    const dot = dotFor(w.id);

    act(() => {
      dot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    mouseover(dot);
    expect(tooltip().textContent).toContain(w.name);
  });
});

describe('SpendToValueGraph — embedded (compact) variant stays consistent', () => {
  it('compact size keeps the same identity mapping and hover reveal', () => {
    renderGraph(undefined, 'compact');

    expect(container!.querySelectorAll('g[data-workload-id]').length).toBe(
      portfolio.length,
    );
    mouseover(dotFor(portfolio[1].id));
    expect(tooltip().textContent).toContain(portfolio[1].name);
  });
});
