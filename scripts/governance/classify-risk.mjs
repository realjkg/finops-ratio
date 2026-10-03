#!/usr/bin/env node
// PR risk classifier (governance track). Plain Node, no dependencies.
//
// Input : changed file paths (+ optional diff text for content rules).
// Output: { risk: "low" | "restricted", classes: [...], reasons: [{ path, class, rule }] }
//
// Rules live in risk-rules.json so they are reviewable as data. The classifier
// is FAIL-CLOSED: a path matching no restricted rule is low only when it is on
// the explicit low allow-list; anything else is restricted:unclassified.
//
// CLI:
//   node scripts/governance/classify-risk.mjs [paths...]
//        [--paths-file <file>]   newline-separated paths
//        [--diff-file <file>]    unified diff (git diff) for content rules
//        [--git <range>]         take paths + diff from `git diff <range>`
//   Always exits 0 with JSON on stdout (it reports; it never blocks).
import fs from 'node:fs';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { URL, fileURLToPath } from 'node:url';

const RULES_URL = new URL('./risk-rules.json', import.meta.url);

/** Convert a glob (**, *, ?, {a,b}) to an anchored RegExp over a full path. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) throw new Error(`unbalanced brace in glob: ${glob}`);
      const alts = glob.slice(i + 1, end).split(',').map(escapeRe);
      re += `(?:${alts.join('|')})`;
      i = end;
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s) {
  return s.replace(/[.+^$()|[\]\\{}*?]/g, '\\$&');
}

/** A glob without '/' matches the basename anywhere (gitignore-style). */
function compileGlob(glob) {
  const re = globToRegExp(glob);
  const basenameOnly = !glob.includes('/');
  return (p) => re.test(basenameOnly ? p.slice(p.lastIndexOf('/') + 1) : p);
}

function anyGlob(globs) {
  const ms = globs.map(compileGlob);
  return (p) => ms.some((m) => m(p));
}

/** Load and compile the rules file (or a rules object supplied by a caller). */
export function loadRules(raw) {
  const data = raw ?? JSON.parse(fs.readFileSync(RULES_URL, 'utf8'));
  if (!Array.isArray(data.restricted) || !Array.isArray(data.low)) {
    throw new Error('risk-rules.json must define "restricted" and "low" arrays');
  }
  const restricted = data.restricted.map((r) => {
    if (!r.id || !r.class || !r.kind) throw new Error(`rule missing id/class/kind: ${JSON.stringify(r)}`);
    const inScope = r.scope ? anyGlob(r.scope) : () => true;
    switch (r.kind) {
      case 'path-glob':
        return { ...r, inScope, matchPath: anyGlob(r.patterns) };
      case 'path-regex': {
        const re = new RegExp(r.pattern, r.flags ?? '');
        return { ...r, inScope, matchPath: (p) => re.test(p) };
      }
      case 'added-line-regex': {
        const re = new RegExp(r.pattern, r.flags ?? '');
        return { ...r, inScope, matchLine: (l) => re.test(l) };
      }
      default:
        throw new Error(`unknown rule kind "${r.kind}" in ${r.id}`);
    }
  });
  const low = data.low.map((r) => {
    const inc = anyGlob(r.patterns);
    const exc = r.except ? anyGlob(r.except) : () => false;
    return { ...r, matchPath: (p) => inc(p) && !exc(p) };
  });
  return { version: data.version, restricted, low };
}

/**
 * Parse a unified diff (git diff output, or a bare per-file hunk) into
 * { path: [addedLine, ...] }. Header lines are never treated as content.
 */
export function parseUnifiedDiff(text, defaultPath) {
  const out = {};
  let current = defaultPath ?? null;
  let inHeader = false;
  const push = (line) => {
    if (current == null) return;
    (out[current] ??= []).push(line);
  };
  for (const line of String(text).split('\n')) {
    const git = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (git) {
      current = git[2];
      inHeader = true;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('+++ ')) {
        const target = line.slice(4).trim();
        if (target !== '/dev/null') current = target.replace(/^b\//, '');
        inHeader = false;
      } else if (line.startsWith('@@')) {
        inHeader = false;
      }
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) push(line.slice(1));
  }
  return out;
}

/**
 * Paths whose diff is binary ("Binary files ... differ" / "GIT binary patch"):
 * content rules cannot see them, so the classifier treats them as uninspectable.
 */
export function binaryPathsInDiff(text) {
  const out = new Set();
  let current = null;
  for (const line of String(text).split('\n')) {
    const git = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (git) {
      current = git[2];
      continue;
    }
    if (current && (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch')) out.add(current);
  }
  return [...out];
}

/**
 * Paths a git diff turns into symlinks (mode 120000). A symlink can point a
 * "low" path at anything (e.g. docs/x.md -> ../.env), so it is restricted.
 */
export function symlinkPathsInDiff(text) {
  const out = new Set();
  let current = null;
  for (const line of String(text).split('\n')) {
    const git = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (git) {
      current = git[2];
      continue;
    }
    if (current && /^(?:new file mode|new mode) 120000$/.test(line)) out.add(current);
  }
  return [...out];
}

/**
 * Classify a change set.
 * @param {{ files: Array<{ path: string, previousPath?: string, patch?: string,
 *           patchUnavailable?: boolean }>, diff?: string, truncated?: boolean }} input
 */
export function classify(input, rules = loadRules()) {
  const files = input?.files ?? [];
  const fromDiff = input?.diff ? parseUnifiedDiff(input.diff) : {};
  const binary = new Set(input?.diff ? binaryPathsInDiff(input.diff) : []);
  const symlinks = new Set(input?.diff ? symlinkPathsInDiff(input.diff) : []);
  const reasons = [];
  const seen = new Set();
  const add = (path, cls, rule) => {
    const key = `${path}\0${cls}\0${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    reasons.push({ path, class: cls, rule });
  };

  if (files.length === 0) add('', 'unclassified', 'empty-change-set');
  if (input?.truncated) add('', 'unclassified', 'file-list-truncated');
  // File modes (symlinks) come from the git tree in Actions; unknown ⇒ fail closed.
  if (input?.treeStatus && input.treeStatus !== 'ok') add('', 'unclassified', `tree-${input.treeStatus}`);

  for (const f of files) {
    const candidatePaths = [f.path, f.previousPath].filter((p) => typeof p === 'string' && p.length > 0);
    const added = [
      ...(f.patch ? parseUnifiedDiff(f.patch, f.path)[f.path] ?? [] : []),
      ...(fromDiff[f.path] ?? []),
    ];
    let hit = false;
    if (String(f.mode ?? '') === '120000' || symlinks.has(f.path)) {
      add(f.path, 'unclassified', 'symlink');
      hit = true;
    }
    for (const rule of rules.restricted) {
      if (rule.matchPath) {
        for (const p of candidatePaths) {
          if (rule.inScope(p) && rule.matchPath(p)) {
            add(f.path, rule.class, rule.id);
            hit = true;
          }
        }
      } else if (rule.matchLine && rule.inScope(f.path) && added.some(rule.matchLine)) {
        add(f.path, rule.class, rule.id);
        hit = true;
      }
    }
    if (hit) continue;
    const isLow = candidatePaths.every((p) => rules.low.some((l) => l.matchPath(p)));
    if (!isLow) add(f.path, 'unclassified', 'fail-closed-default');
    else if (f.patchUnavailable || binary.has(f.path)) add(f.path, 'unclassified', 'diff-unavailable');
  }

  const classes = [...new Set(reasons.map((r) => r.class))].sort();
  return { risk: reasons.length === 0 ? 'low' : 'restricted', classes, reasons };
}

// ---------------------------------------------------------------- CLI

function parseNameStatus(text) {
  const files = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    if (/^[RC]/.test(status)) files.push({ path: parts[2], previousPath: parts[1] });
    else files.push({ path: parts[1] });
  }
  return files;
}

function main(argv) {
  const files = [];
  let diff = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--paths-file') {
      for (const p of fs.readFileSync(argv[++i], 'utf8').split('\n')) if (p.trim()) files.push({ path: p.trim() });
    } else if (a === '--diff-file') {
      diff += fs.readFileSync(argv[++i], 'utf8');
    } else if (a === '--git') {
      const range = argv[++i];
      const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      files.push(...parseNameStatus(git(['diff', '--name-status', '-M', range])));
      diff += git(['diff', '-M', '--no-color', '--no-ext-diff', range]);
    } else if (a.startsWith('--')) {
      process.stderr.write(`unknown option ${a}\n`);
      process.exit(2);
    } else {
      files.push({ path: a });
    }
  }
  process.stdout.write(`${JSON.stringify(classify({ files, diff }), null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2));
}
