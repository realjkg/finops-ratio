import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
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

describe('pages/_document head', () => {
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
