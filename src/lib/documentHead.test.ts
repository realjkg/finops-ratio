import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Document from '../../pages/_document';

const ROOT = path.resolve(__dirname, '../..');

/** Collect every element of the given type from a React element tree, without rendering. */
function findElements(node: ReactNode, type: string, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, type, found);
  } else if (isValidElement(node)) {
    const element = node as ReactElement<{ children?: ReactNode }>;
    if (element.type === type) found.push(element);
    findElements(element.props.children, type, found);
  }
  return found;
}

function iconHref(): string {
  const links = findElements(Document(), 'link').filter((link) =>
    String((link.props as { rel?: string }).rel ?? '').split(' ').includes('icon'),
  );
  expect(links.length).toBeGreaterThan(0);
  return String((links[0].props as { href?: string }).href ?? '');
}

describe('pages/_document head', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('document_head_links_an_icon_that_exists_in_public_under_a_mount_path', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/ratio');
    const href = iconHref();
    expect(href).toBe('/ratio/favicon.svg');
    // Strip the mount prefix before looking in public/, as the disk check must.
    const file = path.join(ROOT, 'public', href.slice('/ratio'.length).replace(/^\/+/, ''));
    expect(existsSync(file), `missing ${file}`).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('<svg');
  });

  it('document_head_links_an_icon_that_exists_in_public', () => {
    const tree = Document();
    const links = findElements(tree, 'link').filter((link) =>
      String((link.props as { rel?: string }).rel ?? '').split(' ').includes('icon'),
    );
    expect(links.length).toBeGreaterThan(0);

    const href = String((links[0].props as { href?: string }).href ?? '');
    expect(href).toMatch(/\.svg$/);
    const file = path.join(ROOT, 'public', href.replace(/^\/+/, ''));
    expect(existsSync(file), `missing ${file}`).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(0);
    expect(readFileSync(file, 'utf8')).toContain('<svg');
  });
});
