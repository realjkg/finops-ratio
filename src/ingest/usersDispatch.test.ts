// R2 slice E: `cli.js users <cmd>` reaches the operator users command (src/engagement/auth/usersCli.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { main } from './cli';

it('dispatches `users list` to the users command (SYNTHETIC directory)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-users-dispatch-'));
  const users = path.join(dir, 'users.json');
  fs.writeFileSync(users, JSON.stringify({ version: 1, users: [{ id: 'admin', displayName: 'SYNTHETIC Admin', status: 'active' }] }));
  const out: string[] = [];
  const env = { RATIO_ENGAGEMENT_CONFIG: path.resolve(__dirname, '../../fixtures/engagement/example/engagement.json'), RATIO_ENGAGEMENT_USERS: users };
  try {
    expect(await main(['users', 'list'], env, { out: (l) => { out.push(l); }, err: () => {} })).toBe(0);
    expect(JSON.parse(out[0]).users.map((u: { id: string }) => u.id)).toEqual(['admin']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
