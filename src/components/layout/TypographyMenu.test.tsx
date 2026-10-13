// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEY } from '@/theme/typography';
import { NavBar } from './NavBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const html = document.documentElement;
const storage = window.localStorage;
let root: Root | undefined;
let container: HTMLDivElement;
const mount = () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => (root = createRoot(container)).render(<NavBar />));
  act(() => container.querySelector<HTMLButtonElement>('button[aria-controls="typography-panel"]')?.click());
};
const field = (id: string) => container.querySelector<HTMLSelectElement>(`#${id}`) as HTMLSelectElement;
const choose = (id: string, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(field(id), value);
    field(id).dispatchEvent(new Event('change', { bubbles: true }));
  });

beforeEach(() => {
  localStorage.clear();
  html.removeAttribute('style');
});
afterEach(() => {
  act(() => root?.unmount());
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
});

describe('TypographyMenu', () => {
  it('is a labeled disclosure beside the theme control and Escape closes it', () => {
    mount();
    const toggle = container.querySelector('button[aria-controls="typography-panel"]');
    expect([toggle?.textContent, toggle?.getAttribute('aria-expanded')]).toEqual(['Text', 'true']);
    expect([...container.querySelectorAll('label[for^="text-"]')].map((l) => l.textContent)).toEqual(['Text size', 'Font']);
    act(() => { container.querySelector('#typography-panel')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(container.querySelector('#typography-panel')).toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });

  it('applies and persists the chosen size and font, and the defaults clear them again', () => {
    mount();
    choose('text-size', '130');
    choose('text-font', 'system-serif');
    expect([html.style.getPropertyValue('--ui-scale'), html.style.getPropertyValue('--font-body')]).toEqual(['1.3', expect.stringContaining('serif')]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({ scale: 130, family: 'system-serif' });
    choose('text-size', '100');
    choose('text-font', 'default');
    expect(html.getAttribute('style') ?? '').toBe('');
  });

  it('shows a stored choice; with blocked storage it still applies and says it will not be saved', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ scale: 115, family: 'instrument-sans' }));
    mount();
    expect([field('text-size').value, field('text-font').value]).toEqual(['115', 'instrument-sans']);
    act(() => root?.unmount());
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('SecurityError'); } });
    mount();
    choose('text-size', '90');
    expect(html.style.getPropertyValue('--ui-scale')).toBe('0.9');
    expect(container.querySelector('#typography-status')?.textContent).toMatch(/not be saved/);
  });
});
