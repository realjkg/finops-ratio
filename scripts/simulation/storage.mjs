/* global process, console */
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  copyFileSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  linkSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
const [action, sourceArg, destinationArg] = process.argv.slice(2);
if (!["backup", "restore"].includes(action) || !sourceArg || !destinationArg)
  throw new Error(
    "Usage: node scripts/simulation/storage.mjs backup|restore SOURCE DESTINATION",
  );
const source = resolve(sourceArg),
  destination = resolve(destinationArg);
if (!existsSync(source) || existsSync(destination))
  throw new Error("Source must exist and destination must be new.");
function verify(db) {
  if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
    throw new Error("SQLite integrity check failed.");
  const rows = db.prepare("SELECT state FROM workspaces").all();
  for (const row of rows) {
    const state = JSON.parse(String(row.state));
    if (
      ![1, 2].includes(state.schema) ||
      !Array.isArray(state.ledger) ||
      !Array.isArray(state.audit)
    )
      throw new Error("Unsupported simulation snapshot.");
  }
  return rows.length;
}
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
// Stage beside the destination so publication is atomic on the same filesystem.
// The private directory prevents exposure of session material before sanitization.
const staging = mkdtempSync(resolve(dirname(destination), ".ratio-snapshot-"));
chmodSync(staging, 0o700);
const staged = resolve(staging, "snapshot.sqlite");
let tenants;
try {
  const original = new DatabaseSync(source, { readOnly: true });
  try {
    verify(original);
    if (action === "backup") original.prepare("VACUUM INTO ?").run(staged);
    else {
      // Never copy a partially checkpointed live database.
      if (existsSync(`${source}-wal`) || existsSync(`${source}-shm`))
        throw new Error("Restore requires a standalone backup, not an active database.");
      copyFileSync(source, staged, constants.COPYFILE_EXCL);
    }
  } finally {
    original.close();
  }
  chmodSync(staged, 0o600);
  const target = new DatabaseSync(staged);
  try {
    target.exec("DELETE FROM sessions;");
    // Publish a standalone file even when the source database uses WAL mode.
    target.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
    tenants = verify(target);
  } finally {
    target.close();
  }
  // link() is atomic and refuses an existing destination, including one created
  // after the initial check. rename() would silently overwrite that file.
  linkSync(staged, destination);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log(
  JSON.stringify({ action, tenants, verified: true, sessionsRestored: false }),
);
