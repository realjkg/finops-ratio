import process from 'node:process';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setInterval, clearInterval } from 'node:timers';

const optional = (read) => { try { return read(); } catch { return null; } };

// flock locks the shared open-file description inherited as fd 3. The parent
// retains that description after flock exits. Kernel cleanup also covers SIGKILL.
// NEVER unlink/rename the lock: a second inode would permit simultaneous owners.
export function acquireLock(path) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path, 'a+', 0o600);
  const result = spawnSync('flock', ['--nonblock', '--conflict-exit-code', '75', '3'], {
    stdio: ['ignore', 'pipe', 'pipe', fd],
  });
  if (result.error || result.status !== 0) {
    fs.closeSync(fd);
    throw new Error(result.status === 75 ? `Lock busy: ${path}` : 'Kernel locking unavailable; refusing unsafe file-only locking.');
  }
  const owner = {
    version: 2, token: randomUUID(), host: hostname(), pid: process.pid,
    procPid: optional(() => Number(fs.readFileSync('/proc/self/stat', 'utf8').split(' ')[0])),
    namespace: optional(() => fs.readlinkSync('/proc/self/ns/pid')),
    boot: optional(() => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()),
    startedAt: new Date().toISOString(), state: 'held',
  };
  const write = () => { fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(owner) + '\n'); fs.fsyncSync(fd); };
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    try { owner.state = 'released'; owner.releasedAt = new Date().toISOString(); write(); }
    finally { fs.closeSync(fd); process.off('exit', release); }
  };
  try { write(); } catch (error) { fs.closeSync(fd); throw error; }
  process.once('exit', release);
  return { owner, release };
}

// A native-tool coding turn holds this process open across tool calls. Release
// requires the unique token returned by that turn; no PID guessing is involved.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, token] = process.argv.slice(2);
  const path = resolve('.ratio-build/continuation.lock');
  if (action === 'hold') {
    const lock = acquireLock(path);
    const request = `${path}.${lock.owner.token}.release`;
    process.stdout.write(JSON.stringify(lock.owner) + '\n');
    const finish = () => { clearInterval(timer); lock.release(); };
    const timer = setInterval(() => {
      if (fs.existsSync(request)) { fs.unlinkSync(request); finish(); }
    }, 200);
    process.once('SIGINT', finish); process.once('SIGTERM', finish);
  } else if (action === 'release' && /^[a-f0-9-]{36}$/.test(token ?? '')) {
    const owner = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (owner.token !== token || owner.state !== 'held') throw new Error('Continuation lock owner does not match.');
    fs.writeFileSync(`${path}.${token}.release`, '', { flag: 'wx', mode: 0o600 });
  } else throw new Error('Usage: node scripts/completion/lock.mjs hold | release TOKEN');
}
