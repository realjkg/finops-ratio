// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvidenceMark } from './EvidenceMark';

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
