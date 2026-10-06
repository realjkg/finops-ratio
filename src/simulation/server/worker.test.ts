import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { SimulationDatabase } from "./database";
it("runs a dedicated bounded worker against the persisted queue without processing other tenants", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratio-worker-")),
    file = join(dir, "jobs.sqlite");
  const db = new SimulationDatabase(file);
  try {
    for (const tenant of ["acme", "northstar"]) {
      const s = db.read(tenant);
      db.command(
        { tenant, user: "Requester", persona: "technical" },
        0,
        "worker-queue-id",
        { type: "queue-agent-review", workloadId: s.workloads[0].id },
      );
    }
    const env = {
      ...process.env,
      RATIO_ENV: "test",
      RATIO_SIMULATION: "1",
      RATIO_SIMULATION_DB: file,
      RATIO_WORKER_TENANT: "acme",
    };
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/simulation/worker.ts"],
      { env, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toMatchObject({ processed: 1, tenant: "acme" });
    expect(db.read("acme").agentJobs[0].status).toBe("review");
    expect(db.read("northstar").agentJobs[0].status).toBe("queued");
    const second = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/simulation/worker.ts"],
      { env, encoding: "utf8" },
    );
    expect(JSON.parse(second).processed).toBe(0);
    expect(() =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/simulation/worker.ts"],
        { env: { ...env, RATIO_ENV: "production" }, stdio: "pipe" },
      ),
    ).toThrow();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
