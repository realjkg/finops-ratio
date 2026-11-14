// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvidenceMark } from './EvidenceMark';
import { EVIDENCE_META, evidenceExplanation } from '@/lib/valueEvidence';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let box: HTMLDivElement;
const mount = (el: React.ReactElement) => act(() => root.render(el));
beforeEach(() => {
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
});
afterEach(() => {
  act(() => root.unmount());
  box.remove();
});

describe('EvidenceMark', () => {
  it('says "Estimated value" for assumed evidence, never the bare word ASSUMED', () => {
    mount(<EvidenceMark status="assumed" />);
    expect(box.textContent).toBe('Estimated value');
    expect(box.innerHTML).not.toMatch(/assumed/i);
  });

  it('names the other two statuses', () => {
    mount(<><EvidenceMark status="projected" /><EvidenceMark status="measured" /></>);
    expect(box.textContent).toBe('Projected valueMeasured value');
  });

  it('renders nothing without a status', () => {
    mount(<EvidenceMark />);
    expect(box.innerHTML).toBe('');
  });

  it('explain: a button opens a short explanation by click, and Escape closes it', () => {
    mount(<EvidenceMark status="assumed" explain />);
    const btn = box.querySelector('button')!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="note"]')).toBeNull();
    act(() => btn.click());
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const note = document.querySelector('[role="note"]')!;
    expect(btn.getAttribute('aria-controls')).toBe(note.id);
    expect(note.textContent).toMatch(/stated assumptions/);
    act(() => {
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="note"]')).toBeNull();
  });

  it('explain: opening describes the button by the popup and announces the text in a polite live region', () => {
    mount(<EvidenceMark status="assumed" explain />);
    const btn = box.querySelector('button')!;
    const live = box.querySelector('[data-testid="evidence-live"]')!;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');
    expect(btn.hasAttribute('aria-describedby')).toBe(false);
    act(() => btn.click());
    const note = document.querySelector('[role="note"]')!;
    expect(btn.getAttribute('aria-describedby')).toBe(note.id);
    expect(live.textContent).toBe(note.textContent);
    expect(live.textContent).toMatch(/stated assumptions/);
    act(() => btn.click());
    expect(live.textContent).toBe('');
    expect(btn.hasAttribute('aria-describedby')).toBe(false);
  });

  it('explain: Escape inside the Frank panel leaves it open; from any other control, the popup or the page it closes', () => {
    const frank = document.createElement('aside');
    frank.id = 'ai-chat-panel';
    const frankInput = document.createElement('input');
    frank.appendChild(frankInput);
    const other = document.createElement('button');
    document.body.append(frank, other);
    const esc = (el: Element) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    const open = () => document.querySelector('[role="note"]') !== null;
    try {
      mount(<EvidenceMark status="assumed" explain />);
      const btn = box.querySelector('button')!;
      act(() => btn.click());
      frankInput.focus();
      esc(frankInput);
      expect(open()).toBe(true); // Frank handles its own Escape
      expect(document.activeElement).toBe(frankInput); // focus is not pulled out of the panel
      // Review Low (a): opened from the keyboard, then Tab to another page control, then Escape: it closes.
      other.focus();
      esc(other);
      expect(open()).toBe(false);
      act(() => btn.click());
      esc(document.querySelector('[role="note"]')!);
      expect(open()).toBe(false);
      expect(document.activeElement).toBe(btn);
      act(() => btn.click());
      esc(document.body);
      expect(open()).toBe(false);
    } finally {
      frank.remove();
      other.remove();
    }
  });

  it('explain: a tap outside closes it (touch)', () => {
    mount(<EvidenceMark status="assumed" explain />);
    act(() => box.querySelector('button')!.click());
    expect(document.querySelector('[role="note"]')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(document.querySelector('[role="note"]')).toBeNull();
  });
});

describe('EvidenceMark names inputs with no recorded provenance', () => {
  it('the title names the unmarked inputs instead of claiming stated assumptions', () => {
    mount(<EvidenceMark status="assumed" unmarked={['harm_from_misses', 'quality_floor_pass_rate']} />);
    const title = box.querySelector('span')?.getAttribute('title') ?? '';
    expect(title).toBe('No valid provenance is recorded for harm from misses and quality-floor pass rate, so this value counts as estimated until a source is recorded.');
    expect(title).not.toContain(EVIDENCE_META.assumed.title);
    expect(title).not.toMatch(/assumed/i);
  });
  it('the explanation popup carries the same sentence', () => {
    mount(<EvidenceMark status="assumed" unmarked={['revenue_protected']} explain />);
    act(() => box.querySelector('button')!.click());
    expect(document.querySelector('[data-testid="evidence-note"]')?.textContent).toBe('No valid provenance is recorded for revenue protected, so this value counts as estimated until a source is recorded.');
  });
  it('nothing changes when every input is marked', () => {
    mount(<EvidenceMark status="assumed" unmarked={[]} />);
    expect(box.querySelector('span')?.getAttribute('title')).toBe(EVIDENCE_META.assumed.title);
  });
  it('the portfolio form counts the workloads with an unmarked input and never claims stated assumptions', () => {
    const two = evidenceExplanation('assumed', undefined, 2);
    expect(two).toBe('This portfolio value counts as estimated. 2 workloads have value inputs with no recorded provenance; those inputs count as estimated until a source is recorded.');
    expect(two).not.toContain(EVIDENCE_META.assumed.title);
    expect(two).not.toMatch(/stated assumption/i);
    expect(evidenceExplanation('assumed', undefined, 1)).toContain('One workload has value inputs with no recorded provenance');
    expect(evidenceExplanation('assumed', undefined, 0)).toBe(EVIDENCE_META.assumed.title);
  });
  it('the portfolio mark with explain opens the same text by keyboard or tap', () => {
    mount(<EvidenceMark status="assumed" unmarkedWorkloads={2} explain />);
    act(() => box.querySelector('button')!.click());
    expect(document.querySelector('[data-testid="evidence-note"]')?.textContent).toBe(evidenceExplanation('assumed', undefined, 2));
  });
  it.each(['Measured', '', 'toString', 'bogus'])('a status that is not a known one (%j) shows as Estimated, never crashes', (bad) => {
    mount(<EvidenceMark status={bad as never} />);
    expect(box.querySelector('span')?.textContent).toBe(EVIDENCE_META.assumed.label);
  });
});
