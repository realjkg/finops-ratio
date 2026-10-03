// Machine-readable evidence record emitted by every worker command (deployment
// pipeline requirement): command, git SHA, artifact digest, timing, results,
// pass/fail. Always redacted.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { redactDeep } from './redact';

export interface EvidenceRecord {
  type: 'ratio.evidence';
  version: 1;
  command: string;
  args: Record<string, unknown>;
  gitSha: string | null;
  artifactDigest: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  results: Record<string, unknown>;
  pass: boolean;
  exitCode: number;
}

export interface EvidenceInput {
  command: string;
  args: Record<string, unknown>;
  gitSha: string | null;
  artifactDigest: string | null;
  startedAt: Date;
  finishedAt: Date;
  results: Record<string, unknown>;
  pass: boolean;
  exitCode: number;
  secrets?: readonly string[];
}

export function buildEvidenceRecord(input: EvidenceInput): EvidenceRecord {
  const secrets = input.secrets ?? [];
  return {
    type: 'ratio.evidence',
    version: 1,
    command: input.command,
    args: redactDeep(input.args, secrets),
    gitSha: input.gitSha,
    artifactDigest: input.artifactDigest,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    results: redactDeep(input.results, secrets),
    pass: input.pass,
    exitCode: input.exitCode,
  };
}

const SHA_RE = /^[0-9a-f]{7,40}$/;

function readBuildInfoSha(): string | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')) as { gitSha?: unknown };
    return typeof info.gitSha === 'string' && SHA_RE.test(info.gitSha) ? info.gitSha : null;
  } catch {
    return null;
  }
}

function gitRevParse(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
    return SHA_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** RATIO_GIT_SHA (validated) → build-info.json (written by worker:build) → git rev-parse → null. */
export function resolveGitSha(
  env: Record<string, string | undefined>,
  deps: { buildInfoSha?: string | null; gitLookup?: () => string | null } = {},
): string | null {
  const fromEnv = (env.RATIO_GIT_SHA ?? '').trim().toLowerCase();
  if (SHA_RE.test(fromEnv)) return fromEnv;
  const fromBuild = deps.buildInfoSha !== undefined ? deps.buildInfoSha : readBuildInfoSha();
  if (fromBuild && SHA_RE.test(fromBuild)) return fromBuild;
  const lookup = deps.gitLookup ?? gitRevParse;
  const fromGit = lookup();
  return fromGit && SHA_RE.test(fromGit) ? fromGit : null;
}

/** Appends one JSON line to the evidence file, if configured. Never throws. */
export function appendEvidenceFile(file: string | undefined, record: EvidenceRecord, serialize: (v: unknown) => string = JSON.stringify): void {
  if (!file) return;
  try {
    fs.appendFileSync(file, serialize(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // The stdout record is authoritative; a missing evidence file is reported by the caller's pipeline.
  }
}
