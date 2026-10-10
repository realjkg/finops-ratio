import { spawn } from 'node:child_process';
import process from 'node:process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { expect, it } from 'vitest';
import { acquireLock } from './lock.mjs';

it('excludes competing owners, preserves the inode, and reuses released metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ratio-lock-'));
  const path = join(dir, 'lock');
  try {
    writeFileSync(path, 'old completed runner metadata');
    const inode = statSync(path).ino;
    const first = acquireLock(path);
    try { expect(() => acquireLock(path)).toThrow(/busy/); }
    finally { first.release(); }
    const second = acquireLock(path);
    try {
      expect(second.owner.token).not.toBe(first.owner.token);
      expect(statSync(path).ino).toBe(inode);
    } finally { second.release(); }
    expect(JSON.parse(readFileSync(path)).state).toBe('released');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('releases a killed owner in the kernel even when its metadata still says held', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ratio-lock-crash-'));
  const path = join(dir, 'lock');
  const module = new URL('./lock.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {acquireLock} from ${JSON.stringify(module)}; acquireLock(${JSON.stringify(path)}); console.log('ready'); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout, 'data');
    expect(() => acquireLock(path)).toThrow(/busy/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    expect(JSON.parse(readFileSync(path)).state).toBe('held');
    const next = acquireLock(path);
    next.release();
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});
