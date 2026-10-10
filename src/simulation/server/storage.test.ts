import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { SimulationDatabase } from "./database";
it("backs up an open WAL database, restores workspace and command history, revokes sessions, and refuses overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratio-recovery-"));
  const file = join(dir, "live.sqlite"),
    snapshot = join(dir, "backup.sqlite"),
    restored = join(dir, "restored.sqlite");
  const actor = {
    tenant: "acme",
    user: "Recovery test",
    persona: "technical" as const,
  };
  const script = "scripts/simulation/storage.mjs";
  const db = new SimulationDatabase(file);
  try {
    const session = db.createSession(actor);
    const s = db.read("acme");
    const c = { type: "queue-agent-review", workloadId: s.workloads[0].id };
    const saved = db.command(actor, 0, "backup-command", c);
    execFileSync(process.execPath, [script, "backup", file, snapshot]);
    expect(statSync(snapshot).mode & 0o777).toBe(0o600);
    expect(existsSync(`${snapshot}-wal`)).toBe(false);
    expect(existsSync(`${snapshot}-shm`)).toBe(false);
    const inspection = new DatabaseSync(snapshot, { readOnly: true });
    try { expect(inspection.prepare("SELECT count(*) AS n FROM sessions").get()?.n).toBe(0); }
    finally { inspection.close(); }
    expect(db.session(session.token)).not.toBeNull();
    expect(readdirSync(dir).some(name => name.startsWith(".ratio-snapshot-"))).toBe(false);
    execFileSync(process.execPath, [script, "restore", snapshot, restored]);
    const recovery = new SimulationDatabase(restored);
    try {
      expect(recovery.read("acme")).toEqual(saved);
      expect(recovery.session(session.token)).toBeNull();
      expect(recovery.command(actor, 0, "backup-command", c)).toEqual(saved);
      expect(recovery.integrity()).toBe(true);
    } finally {
      recovery.close();
    }
    expect(() =>
      execFileSync(process.execPath, [script, "restore", snapshot, restored], {
        stdio: "pipe",
      }),
    ).toThrow();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("failed snapshot sanitization leaves no published destination or staging files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratio-recovery-failure-"));
  const source = join(dir, "incomplete.sqlite");
  const destination = join(dir, "snapshot.sqlite");
  const broken = new DatabaseSync(source);
  broken.exec(`CREATE TABLE workspaces (tenant TEXT PRIMARY KEY, state TEXT NOT NULL);
    INSERT INTO workspaces VALUES ('acme', '{"schema":2,"ledger":[],"audit":[]}');`);
  broken.close();
  const original = readFileSync(source);
  try {
    expect(() => execFileSync(process.execPath, ["scripts/simulation/storage.mjs", "backup", source, destination], { stdio: "pipe" })).toThrow();
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(dir)).toEqual(["incomplete.sqlite"]);
    expect(readFileSync(source)).toEqual(original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("refuses restoration from an active WAL source without leaving a destination", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratio-live-restore-"));
  const source = join(dir, "live.sqlite");
  const destination = join(dir, "restored.sqlite");
  const db = new SimulationDatabase(source);
  try {
    const expected = db.read("acme");
    expect(existsSync(`${source}-wal`)).toBe(true);
    expect(() => execFileSync(process.execPath, ["scripts/simulation/storage.mjs", "restore", source, destination], { stdio: "pipe" })).toThrow();
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(dir).some(name => name.startsWith(".ratio-snapshot-"))).toBe(false);
    expect(db.read("acme")).toEqual(expected);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
