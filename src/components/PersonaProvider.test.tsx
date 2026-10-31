// @vitest-environment happy-dom
// A browser whose localStorage getter throws (blocked site data) must not blank the app.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonaProvider } from './PersonaProvider';
import { usePersona } from '@/lib/persona';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const original = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
afterEach(() => Object.defineProperty(window, 'localStorage', original));

function Probe() {
  const { persona, setPersona } = usePersona();
  return <button onClick={() => setPersona('technical')}>{persona}</button>;
}

describe('PersonaProvider with unavailable storage', () => {
  it('renders, and a persona change still works in memory', () => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
    const box = document.createElement('div'); document.body.appendChild(box);
    const root = createRoot(box);
    act(() => root.render(<PersonaProvider><Probe /></PersonaProvider>));
    expect(box.textContent).toBe('executive');
    act(() => box.querySelector('button')!.click());
    expect(box.textContent).toBe('technical');
    act(() => root.unmount()); box.remove();
  });
});
