// ---------------------------------------------------------------------------
// Local dev Postgres via PGlite (no Docker, no install)
// ---------------------------------------------------------------------------
//
// Exposes an in-process PGlite instance over a TCP socket so Hyperdrive's
// `localConnectionString` can connect to it like a real Postgres server, for
// exercising the opt-in Postgres seam (src/db/postgres.ts) under `wrangler dev`.
//
// Unlike apps/cloud (which applies generated drizzle-kit migrations), the
// Cloudflare host brings its schema up at RUNTIME via
// `ensureDrizzleRuntimeSchemaFromTables`, so this script does the same here:
// the dev DB and the deployed Worker share one schema bring-up code path.

import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import {
  createDrizzleRuntimeSchemaFromTables,
  ensureDrizzleRuntimeSchemaFromTables,
} from "@executor-js/fumadb/adapters/drizzle";
import { collectTables } from "@executor-js/api/server";

import { CLOUDFLARE_NAMESPACE, CLOUDFLARE_SCHEMA_VERSION } from "../src/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Port + data dir default to the dev values but are env-overridable so a second
// throwaway instance can run alongside `bun dev`.
const PORT = Number(process.env.DEV_DB_PORT ?? 5433);
const DB_PATH = process.env.DEV_DB_PATH
  ? resolve(process.env.DEV_DB_PATH)
  : resolve(__dirname, "../.dev-db");

// Reap any orphan dev-db from a previous run that didn't shut down cleanly,
// otherwise the new instance can't bind to PORT.
function reapStaleDevDb() {
  const out = execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN 2>/dev/null || true`, {
    encoding: "utf8",
  });
  const pids = out.trim().split("\n").filter(Boolean);
  if (pids.length === 0) return false;

  for (const pid of pids) {
    const cmd = execSync(`ps -p ${pid} -o args= 2>/dev/null || true`, {
      encoding: "utf8",
    }).trim();
    // The PID can exit between `lsof` and `ps` (the stale instance shutting down
    // on its own): an empty cmd means it is already gone and the port is free, so
    // skip it rather than misreading it as an unexpected process and bailing.
    if (cmd === "") continue;
    if (!cmd.includes("dev-db.ts")) {
      console.error(`[dev-db] Port ${PORT} is held by an unexpected process (pid ${pid}): ${cmd}`);
      console.error(`[dev-db] Refusing to kill it. Free the port and retry.`);
      process.exit(1);
    }
    console.log(`[dev-db] Reaping stale dev-db (pid ${pid})`);
    // process.kill (a Node built-in, no subshell) instead of `kill -KILL`;
    // tolerate ESRCH if the process exited between the check above and here.
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // already gone
    }
  }
  return true;
}

if (reapStaleDevDb()) {
  // Give the kernel a beat to release the socket before we try to bind.
  await sleep(200);
}

console.log(`[dev-db] Starting PGlite at ${DB_PATH}`);
const db = await PGlite.create(DB_PATH);

console.log("[dev-db] Ensuring runtime schema (provider=postgresql)");
const options = {
  tables: collectTables(),
  namespace: CLOUDFLARE_NAMESPACE,
  version: CLOUDFLARE_SCHEMA_VERSION,
  provider: "postgresql" as const,
};
const schema = createDrizzleRuntimeSchemaFromTables(options);
await ensureDrizzleRuntimeSchemaFromTables(drizzle(db, { schema }), options);

const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
await server.start();
console.log(`[dev-db] Listening on postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);

const shutdown = async () => {
  console.log("\n[dev-db] Shutting down");
  await server.stop();
  await db.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
