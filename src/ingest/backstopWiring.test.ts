// The runtime backstop against dangerous roles is only a control if it is
// wired in. Static check of both DB vitest configs: the parallel config runs
// the per-test backstop, the serial config the per-file (afterAll) backstop;
// both setup files exist and install the backstop in the right mode.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..', '..');

/** String elements of the `setupFiles` array literal(s) in a config file. */
export function setupFilesOf(code: string): string[] {
  const sf = ts.createSourceFile('config.ts', code, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'setupFiles' && ts.isArrayLiteralExpression(n.initializer)) {
      for (const e of n.initializer.elements) if (ts.isStringLiteral(e)) out.push(e.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const CASES = [
  { config: 'vitest.db.config.ts', setup: 'src/ingest/testing/dangerousLoginBackstopSetup.ts', mode: /perTest:\s*true/ },
  { config: 'vitest.db.serial.config.ts', setup: 'src/ingest/testing/dangerousLoginBackstopSerialSetup.ts', mode: /perTest:\s*false/ },
];

describe('dangerous-role backstop wiring', () => {
  for (const c of CASES) {
    it(`${c.config} lists ${path.basename(c.setup)}, which installs the backstop (${c.mode.source})`, () => {
      expect(setupFilesOf(fs.readFileSync(path.join(ROOT, c.config), 'utf8'))).toContain(c.setup);
      const setup = fs.readFileSync(path.join(ROOT, c.setup), 'utf8');
      expect(setup).toMatch(/installDangerousLoginBackstop\(/);
      expect(setup).toMatch(c.mode);
    });
  }

  it('detector self-test', () => {
    expect(setupFilesOf("export default { test: { setupFiles: ['a.ts', 'b.ts'] } }")).toEqual(['a.ts', 'b.ts']);
    expect(setupFilesOf("export default { test: { globalSetup: ['a.ts'] } }")).toEqual([]);
  });
});
