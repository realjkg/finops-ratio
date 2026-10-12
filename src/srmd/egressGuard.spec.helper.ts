// Structural no-egress guard for src/srmd. It parses every code file with the
// TypeScript parser and rejects any import outside this directory, dynamic
// import, and any identifier or member name tied to network access, dynamic
// code or global-object indexing. It is a guard against accidents and simple
// tricks, not a sandbox: it cannot prove the absence of every escape.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const BANNED = new Set([
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'Image', 'Function', 'eval', 'require',
  'importScripts', 'Worker', 'SharedWorker', 'BroadcastChannel', 'globalThis', 'window', 'self', 'global',
  'parent', 'top', 'navigator', 'document', 'location', 'process', 'setTimeout', 'setInterval', 'setImmediate',
  'constructor', '__proto__', 'child_process',
]);
const CODE = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts']);
/** The only files exempt from the scan: the guard itself and the two test files. */
export const EXEMPT_TEST_FILES = ['srmd.test.ts', 'srmdContract.spec.helper.ts', 'egressGuard.spec.helper.ts'];

export function egressViolations(file: string, text: string, root: string): string[] {
  const out: string[] = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const checkSpec = (spec: string) => {
    const target = resolve(dirname(file), spec);
    if (!(spec.startsWith('./') || spec.startsWith('../')) || relative(root, target).startsWith('..')) out.push(`import of "${spec}"`);
  };
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      checkSpec(ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : '?');
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      out.push('import = require');
    } else if (ts.isImportTypeNode(n)) {
      out.push('import() type');
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      out.push('dynamic import');
    } else if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && BANNED.has(n.text)) {
      out.push(`banned name ${n.text}`);
    } else if (ts.isStringLiteral(n) && ts.isElementAccessExpression(n.parent) && BANNED.has(n.text)) {
      out.push(`banned member ${n.text}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Scans every file under root, recursively, except the exempt test files at the top level. */
export function scanDir(root: string, exempt: readonly string[] = EXEMPT_TEST_FILES): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (dir === root && exempt.includes(name)) continue;
      else if (!CODE.has(extname(name))) out.push(`${relative(root, full)}: file type not allowed`);
      else egressViolations(full, readFileSync(full, 'utf8'), root).forEach((v) => out.push(`${relative(root, full)}: ${v}`));
    }
  };
  walk(root);
  return out;
}
