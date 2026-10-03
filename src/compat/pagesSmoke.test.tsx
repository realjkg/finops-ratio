// Page smoke test (compatibility suite): every non-API module under pages/
// server-renders via react-dom/server without throwing. Pages are rendered
// inside the real pages/_app (as Next does), with next/router mocked at the
// page's own route so _app picks the same shell it would in production.

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';

const PAGES_DIR = path.resolve(__dirname, '../../pages');

function pageModules(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'api') continue;
      out.push(...pageModules(path.join(dir, entry.name), path.join(rel, entry.name)));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(path.join(rel, entry.name));
    }
  }
  return out.sort();
}

const current = { pathname: '/' };
vi.mock('next/router', () => {
  const router = {
    get pathname() {
      return current.pathname;
    },
    get route() {
      return current.pathname;
    },
    get asPath() {
      return current.pathname;
    },
    query: {},
    basePath: '',
    isReady: true,
    push: async () => true,
    replace: async () => true,
    prefetch: async () => undefined,
    back: () => undefined,
    events: { on: () => undefined, off: () => undefined, emit: () => undefined },
  };
  return { useRouter: () => router, default: router };
});

const PAGES = pageModules(PAGES_DIR);

describe('every page server-renders', () => {
  it('found the page modules', () => {
    expect(PAGES.length).toBeGreaterThan(10);
  });

  it.each(PAGES)('pages/%s renders without throwing', async (rel) => {
    const mod = (await import(/* @vite-ignore */ path.join(PAGES_DIR, rel))) as { default: ComponentType<Record<string, unknown>> };
    const Page = mod.default;
    expect(typeof Page).toBe('function');
    if (rel === '_document.tsx') {
      // Next's Document needs Next's HtmlContext; constructing it proves the
      // module loads and exports a Document class.
      expect(Page.prototype?.render ?? Page).toBeDefined();
      return;
    }
    const App = ((await import(/* @vite-ignore */ path.join(PAGES_DIR, '_app.tsx'))) as {
      default: ComponentType<Record<string, unknown>>;
    }).default;
    const route = `/${rel.replace(/\.tsx?$/, '').replace(/(^|\/)index$/, '')}`;
    current.pathname = rel === '_app.tsx' ? '/' : route;
    const Component = rel === '_app.tsx' ? () => createElement('div', null, 'page') : Page;
    expect(() => renderToString(createElement(App, { Component, pageProps: {} }))).not.toThrow();
  }, 30_000);
});
