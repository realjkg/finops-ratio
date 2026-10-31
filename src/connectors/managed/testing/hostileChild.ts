// Test-only child process for hostileWatchdog.test.ts: validates one hostile AWS location value per stdin
// line, at startup (R1 checkEngagementConfig) or in the worker (engagementProblems), and answers one JSON line.
// The parent kills this process if any answer takes longer than its hard timeout. SYNTHETIC values only.
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { checkEngagementConfig } from '../../../engagement/config';
import { engagementProblems } from '../engagementSpec';
import { managedRegistry } from '../registry';

export const SHAPES: Record<string, (n: number) => string> = {
  colons: (n) => ':'.repeat(n),
  'a-colon': (n) => 'a:'.repeat(Math.ceil(n / 2)).slice(0, n),
  eyJ: (n) => 'eyJ'.repeat(Math.ceil(n / 3)).slice(0, n),
  'eyJ-dashes': (n) => `eyJ${'-'.repeat(Math.max(0, n - 3))}`,
  'ligature (NFKC x18)': (n) => 'ﷺ'.repeat(n),
  'fullwidth (NFKC)': (n) => 'Ａ'.repeat(n),
  'fullwidth key id (NFKC)': (n) => [...(['AK', 'IA'].join('') + 'SYNTHETIC0000004')].map((c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0)).join('').repeat(Math.ceil(n / 20)).slice(0, n),
};

if (process.argv[1]?.endsWith('hostileChild.ts')) {
  const fixture = path.resolve(__dirname, '../../../../fixtures/engagement/example/engagement.json');
  const base = fs.readFileSync(fixture, 'utf8');
  const registered = managedRegistry.connectors();
  process.stdout.write('READY\n');
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const { side, field, shape, n } = JSON.parse(line) as { side: 'startup' | 'worker'; field: string; shape: string; n: number };
    const value = SHAPES[shape](n);
    const c = JSON.parse(base);
    c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', secretRef: 'aws/focus', params: { region: 'us-east-1', table: 'FOCUS_1_2_AWS', bucket: 'export-bucket', exportName: 'focus', [field]: value } };
    const t0 = performance.now();
    const problems = side === 'startup' ? ((r) => (r.ok ? [] : r.problems))(checkEngagementConfig(c)) : engagementProblems(c, registered);
    const ms = performance.now() - t0;
    const mine = problems.filter((p) => p.startsWith(`sources[0].retrieval.params.${field}:`));
    process.stdout.write(`${JSON.stringify({ ms, refused: mine.length > 0, echoed: problems.some((p) => p.includes(value.slice(0, 12))) })}\n`);
  });
}
