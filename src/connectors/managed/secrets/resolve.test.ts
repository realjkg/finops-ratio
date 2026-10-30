// M0a: secrets are resolved by NAME from RATIO_SECRETS_DIR only (one file per
// secretRef, mounted read-only, mode 0600 or stricter, at most 64 KiB). Never
// from the process env, never from the config. Errors name the ref, never a value.
import fs from 'fs';
import os from 'os';
import path from 'path';
import util from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SECRET_BYTES, SecretError, resolveSecret, scrubSecrets, secretScrubTargets } from './resolve';

const VALUE = 'SYNTHETIC-secret-value-7f3a';
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-secrets-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name: string, body: string | Buffer, mode = 0o600) => {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, mode);
  return p;
};
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SecretError);
    expect(String((e as Error).message)).not.toContain(VALUE);
    return (e as SecretError).code;
  }
  return 'NO_ERROR';
};

describe('resolveSecret', () => {
  it('resolves a name (with sub-directories) to the file value, one trailing newline removed', () => {
    write('aws/focus-reader', `${VALUE}\n`);
    const s = resolveSecret('aws/focus-reader', { RATIO_SECRETS_DIR: dir });
    expect(s.ref).toBe('aws/focus-reader');
    expect(s.reveal()).toBe(VALUE);
  });

  it('the value never serializes, stringifies or inspects', () => {
    write('k', VALUE);
    const s = resolveSecret('k', { RATIO_SECRETS_DIR: dir });
    expect(JSON.stringify({ s })).toBe('{"s":"[secret]"}');
    expect(`${s}`).toBe('[secret]');
    expect(util.inspect(s)).not.toContain(VALUE);
  });

  it('a missing file is SECRET_MISSING naming the ref', () => {
    let msg = '';
    try {
      resolveSecret('openai/admin', { RATIO_SECRETS_DIR: dir });
    } catch (e) {
      msg = (e as Error).message;
      expect((e as SecretError).code).toBe('SECRET_MISSING');
    }
    expect(msg).toContain('openai/admin');
  });

  it('refuses a group- or world-readable file', () => {
    write('k', VALUE, 0o644);
    expect(codeOf(() => resolveSecret('k', { RATIO_SECRETS_DIR: dir }))).toBe('SECRET_PERMISSIONS');
    write('g', VALUE, 0o640);
    expect(codeOf(() => resolveSecret('g', { RATIO_SECRETS_DIR: dir }))).toBe('SECRET_PERMISSIONS');
    write('ro', VALUE, 0o400);
    expect(resolveSecret('ro', { RATIO_SECRETS_DIR: dir }).reveal()).toBe(VALUE);
  });

  it('refuses an oversized, empty or non-regular file', () => {
    write('big', Buffer.alloc(MAX_SECRET_BYTES + 1, 0x61));
    expect(codeOf(() => resolveSecret('big', { RATIO_SECRETS_DIR: dir }))).toBe('SECRET_TOO_LARGE');
    write('empty', '\n');
    expect(codeOf(() => resolveSecret('empty', { RATIO_SECRETS_DIR: dir }))).toBe('SECRET_EMPTY');
    fs.mkdirSync(path.join(dir, 'adir'));
    expect(codeOf(() => resolveSecret('adir', { RATIO_SECRETS_DIR: dir }))).toBe('SECRET_NOT_FILE');
  });

  it('refuses traversal, absolute and malformed names, and a link out of the directory', () => {
    for (const ref of ['../etc/passwd', 'a/../../b', '/abs', 'a//b', './a', 'a/', '', 'x y']) expect(codeOf(() => resolveSecret(ref, { RATIO_SECRETS_DIR: dir })), ref).toBe('SECRET_REF_INVALID');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'v'), VALUE, { mode: 0o600 });
      fs.symlinkSync(path.join(outside, 'v'), path.join(dir, 'link'));
      expect(codeOf(() => resolveSecret('link', { RATIO_SECRETS_DIR: dir }))).toBe('SECRET_REF_INVALID');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
    // A link inside the directory (the Kubernetes secret-volume layout) is fine.
    write('..data/k', VALUE);
    fs.symlinkSync(path.join(dir, '..data', 'k'), path.join(dir, 'k8s'));
    expect(resolveSecret('k8s', { RATIO_SECRETS_DIR: dir }).reveal()).toBe(VALUE);
  });

  it('never reads the process env: no RATIO_SECRETS_DIR (or a relative one) is refused even when an env var has the name', () => {
    expect(codeOf(() => resolveSecret('AWS_SECRET_ACCESS_KEY', { AWS_SECRET_ACCESS_KEY: VALUE } as Record<string, string>))).toBe('SECRETS_DIR_UNSET');
    expect(codeOf(() => resolveSecret('k', { RATIO_SECRETS_DIR: 'relative/dir' }))).toBe('SECRETS_DIR_UNSET');
  });
});

describe('scrubSecrets', () => {
  it('replaces every occurrence of each secret value, deep, in strings and objects', () => {
    expect(scrubSecrets(`token ${VALUE} and again ${VALUE}`, [VALUE])).toBe('token [redacted] and again [redacted]');
    expect(scrubSecrets({ a: [`x${VALUE}`], b: { c: VALUE }, n: 1 }, [VALUE])).toEqual({ a: ['x[redacted]'], b: { c: '[redacted]' }, n: 1 });
    expect(scrubSecrets('abc', ['', 'ab'])).toBe('abc'); // values shorter than 4 are not treated as secrets
  });
});

describe('scrub targets of structured secret files (review M1)', () => {
  it('a JSON secret registers every string field value, and each line of a multi-line one', () => {
    const json = JSON.stringify({ client_id: 'SYNTHETIC-client-4411', private_key: '-----BEGIN PRIVATE KEY-----\nSYNTHETICKEYLINEaaaaaaaaaaaaaaaa\n-----END PRIVATE KEY-----\n', nested: { token: 'SYNTHETIC-nested-tok' }, n: 12 });
    const t = secretScrubTargets(json);
    for (const v of [json, 'SYNTHETIC-client-4411', 'SYNTHETIC-nested-tok', 'SYNTHETICKEYLINEaaaaaaaaaaaaaaaa']) expect(t).toContain(v);
    expect(scrubSecrets('rejected client SYNTHETIC-client-4411', t)).toBe('rejected client [redacted]');
  });

  it('an id:secret or key=value;... secret registers its components (never the key names)', () => {
    const a = secretScrubTargets('SYNTHETIC-user:SYNTHETIC-pass-99');
    expect(a).toEqual(expect.arrayContaining(['SYNTHETIC-user:SYNTHETIC-pass-99', 'SYNTHETIC-user', 'SYNTHETIC-pass-99']));
    const b = secretScrubTargets('client_id=abcd1;private_key=PK-SYNTHETIC-123');
    expect(b).toEqual(expect.arrayContaining(['abcd1', 'PK-SYNTHETIC-123']));
    expect(b).not.toContain('private_key');
    expect(b).not.toContain('client_id');
  });

  it('scrubs object keys and the URL-encoded and JSON-escaped forms too', () => {
    const s = 'SYNTHETIC+a/b=c"d';
    expect(scrubSecrets({ [s]: 1 }, [s])).toEqual({ '[redacted]': 1 });
    expect(scrubSecrets(`q=${encodeURIComponent(s)}`, [s])).toBe('q=[redacted]');
    expect(scrubSecrets(JSON.stringify({ v: s }), [s])).toBe('{"v":"[redacted]"}');
  });
});
