// @vitest-environment happy-dom
// The typography control in the shared nav: labeled, keyboard operable, applies and persists.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEY } from '@/theme/typography';
import { NavBar } from './NavBar';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
const html = document.documentElement;
const storage = window.localStorage;
let root: Root | undefined;
let container: HTMLDivElement;
const mount = () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(<NavBar />);
  });
};
const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-controls="typography-panel"]') as HTMLButtonElement;
const field = (label: string) => {
  const l = [...container.querySelectorAll('label')].find((x) => x.textContent === label);
  return container.querySelector<HTMLSelectElement>(`#${l?.htmlFor}`) as HTMLSelectElement;
};
const choose = (el: HTMLSelectElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

beforeEach(() => {
  localStorage.clear();
  html.removeAttribute('style');
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
});

describe('TypographyMenu', () => {
  it('is a labeled disclosure beside the theme control, closed until opened and closed again by Escape', () => {
    mount();
    expect(toggle().textContent).toBe('Text');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#typography-panel')).toBeNull();
    act(() => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(field('Text size').tagName).toBe('SELECT');
    expect(field('Font').tagName).toBe('SELECT');
    act(() => { container.querySelector('#typography-panel')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(container.querySelector('#typography-panel')).toBeNull();
  });

  it('applies and persists the chosen size and font', () => {
    mount();
    act(() => toggle().click());
    choose(field('Text size'), '130');
    choose(field('Font'), 'system-serif');
    expect(html.style.getPropertyValue('--ui-scale')).toBe('1.3');
    expect(html.style.getPropertyValue('--font-body')).toContain('serif');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({ scale: 130, family: 'system-serif' });
    choose(field('Text size'), '100');
    choose(field('Font'), 'default');
    expect(html.getAttribute('style') ?? '').toBe('');
  });

  it('shows a stored choice, and still applies one when storage is blocked, saying it will not persist', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ scale: 115, family: 'instrument-sans' }));
    mount();
    act(() => toggle().click());
    expect(field('Text size').value).toBe('115');
    expect(field('Font').value).toBe('instrument-sans');
    act(() => root?.unmount());
    container.remove();
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('SecurityError'); } });
    mount();
    act(() => toggle().click());
    choose(field('Text size'), '90');
    expect(html.style.getPropertyValue('--ui-scale')).toBe('0.9');
    expect(container.querySelector('#typography-status')?.textContent).toMatch(/not be saved/);
  });
});
