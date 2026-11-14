// @vitest-environment happy-dom
// Each surface that shows a value status, rendered with a workload that has no evidence block:
// the rendered mark (opened like a user would) or the button's accessible name must say that no
// valid provenance is recorded, never only "Estimated value" (round 3 review M2: these checks fail
// if the wiring of the unmarked inputs is removed from any surface).
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import type { Workload } from '@/types';
import { KpiCards } from '@/components/detail/KpiCards';
import { InitiativeCard } from '@/executive/InitiativeCard';
import { toInitiativeView } from '@/executive/initiativeModel';
import { languageFor } from '@/lib/languageMap';
import { TcaBreakdown } from '@/outcomes/TcaBreakdown';
import { MissionCard } from '@/mission/MissionCard';
import { FleetHeader } from '@/mission/FleetHeader';
import { buildMissionBoard, toMissionView } from '@/mission/missionModel';
import { FindingsPage } from '@/findings/FindingsPage';
import { useStore } from '@/store/useStore';

vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, pathname: '/', isReady: true, push: async () => true, replace: async () => true }) }));
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const stripped = (w: Workload = WORKLOADS[0]): Workload => {
  const c = structuredClone(w);
  delete (c.value as { evidence?: unknown }).evidence;
  return c;
};
const ALL = 'No valid provenance is recorded for revenue protected, cost avoided, harm from misses and quality-floor pass rate';

let root: Root | null = null;
let box: HTMLDivElement;
function mount(el: ReactElement) {
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  act(() => root!.render(el));
}
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});
const marks = () => [...box.querySelectorAll('button')].filter((b) => b.textContent === 'Estimated value');
const open = (b: HTMLButtonElement) => {
  act(() => b.click());
  return document.querySelector('[data-testid="evidence-note"]')?.textContent ?? '';
};

describe('unmarked inputs are named on every surface', () => {
  it('KPI card (workload detail)', () => {
    mount(<KpiCards workload={stripped()} />);
    expect(open(marks()[0])).toContain(ALL);
  });
  it('initiative card', () => {
    mount(<InitiativeCard initiative={toInitiativeView(stripped())} lang={languageFor('executive')} showLens={false} />);
    expect(open(marks()[0])).toContain(ALL);
  });
  it('TCA breakdown: each input row and the headline row', () => {
    mount(<TcaBreakdown workload={stripped()} />);
    const texts = marks().map((b) => { const t = open(b); act(() => b.click()); return t; });
    expect(texts).toEqual(expect.arrayContaining([
      expect.stringContaining('No valid provenance is recorded for revenue protected and cost avoided'),
      expect.stringContaining('No valid provenance is recorded for quality-floor pass rate'),
      expect.stringContaining('No valid provenance is recorded for harm from misses'),
      expect.stringContaining(ALL),
    ]));
  });
  it('mission card: the button’s accessible name carries the status and the unmarked inputs', () => {
    mount(<MissionCard mission={toMissionView(stripped())} onOpen={() => {}} />);
    const label = box.querySelector('button')!.getAttribute('aria-label') ?? '';
    expect(label).toContain('value evidence: estimated, no valid provenance recorded for revenue protected');
    expect(label.toLowerCase()).not.toContain('estimated value');
  });
  it('fleet headline: the explanation counts the workload', () => {
    mount(<FleetHeader fleet={buildMissionBoard([stripped(), ...WORKLOADS.slice(1)]).fleet} />);
    expect(open(marks()[0])).toContain('One workload has value inputs with no recorded provenance');
  });
  it('finding row and detail pane: the row’s name and mark title, and the pane’s opened mark, name the inputs', () => {
    useStore.setState({ workloads: [stripped(), ...structuredClone(WORKLOADS.slice(1))], simulation: null, aiPanelOpen: false, selectedId: WORKLOADS[0].id });
    try {
      mount(<FindingsPage />);
      const row = [...box.querySelectorAll('button[aria-label^="Finding "]')].find((b) => b.getAttribute('aria-label')!.includes(WORKLOADS[0].name)) as HTMLButtonElement;
      expect(row.getAttribute('aria-label')).toContain('value evidence: estimated, no valid provenance recorded for revenue protected');
      // The row's visible mark is static text inside the button: its title names the inputs.
      expect([...row.querySelectorAll('span[title]')].some((el) => el.getAttribute('title')!.includes(ALL))).toBe(true);
      act(() => row.click());
      // The detail pane's mark is the keyboard and touch explanation for the selected finding.
      const pane = marks().filter((b) => !row.contains(b));
      expect(pane.length).toBeGreaterThan(0);
      expect(open(pane[0])).toContain(ALL);
    } finally {
      useStore.setState({ workloads: structuredClone(WORKLOADS) });
    }
  });
  it('mission card: the visible mark’s title names the inputs', () => {
    mount(<MissionCard mission={toMissionView(stripped())} onOpen={() => {}} />);
    expect([...box.querySelectorAll('span[title]')].some((el) => el.getAttribute('title')!.includes(ALL))).toBe(true);
  });
});
