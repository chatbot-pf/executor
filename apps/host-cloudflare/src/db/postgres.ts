import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  createDrizzleRuntimeSchemaFromTables,
  ensureDrizzleRuntimeSchemaFromTables,
} from "@executor-js/fumadb/adapters/drizzle";

import {
  collectTables,
  createExecutorFumaDb,
  type ExecutorDbHandle,
} from "@executor-js/api/server";
import { makeR2BlobStore } from "@executor-js/cloudflare/blob-store";

import { CLOUDFLARE_NAMESPACE, CLOUDFLARE_SCHEMA_VERSION, type CloudflareEnv } from "../config";
import { runCloudflarePostgresDataMigrations } from "./data-migrations";

// ---------------------------------------------------------------------------
// Postgres (Neon via Hyperdrive) DbProvider handle — the opt-in alternative to
// the D1 seam (see ./d1.ts). Selected by ./index.ts when a Hyperdrive binding
// or a direct DATABASE_URL is present; D1 stays the default.
//
// This mirrors the proven postgres.js + Hyperdrive path apps/cloud already runs
// (apps/cloud/src/db/db.ts) but keeps host-cloudflare's RUNTIME `ensure`
// bring-up (no out-of-band migration step), so the template stays
// self-provisioning. Unlike D1, Postgres supports transactional DDL and has no
// 100-bound-parameter cap, so the two D1 workarounds
// (`interactiveTransactions: false`, `maxBoundParameters: 100`) are dropped and
// the schema bring-up runs with the FULL drizzle handle (DDL wrapped in a tx).
// ---------------------------------------------------------------------------

// Resolve the Postgres connection string, mirroring apps/cloud/src/db/db.ts.
// Production prefers the Hyperdrive binding's connection string; a direct
// DATABASE_URL is used only behind the explicit EXECUTOR_DIRECT_DATABASE_URL
// escape hatch (so a stray secret can't silently bypass Hyperdrive), and is the
// final fallback when no Hyperdrive binding exists.
export const resolveConnectionString = (env: CloudflareEnv): string => {
  if (env.EXECUTOR_DIRECT_DATABASE_URL === "true" && env.DATABASE_URL) {
    return env.DATABASE_URL;
  }
  return env.HYPERDRIVE?.connectionString || env.DATABASE_URL || "";
};

export const createPostgresExecutorDb = async (env: CloudflareEnv): Promise<ExecutorDbHandle> => {
  // postgres.js (not `pg`): Workers forbid sharing I/O across requests, and
  // `pg`'s CloudflareSocket hangs when reused. `max: 1` is right for Hyperdrive
  // (it pools behind the proxy); options match apps/cloud/src/db/db.ts. No
  // explicit `ssl` — Hyperdrive terminates TLS to the backend.
  const sql = postgres(resolveConnectionString(env), {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 60,
    connect_timeout: 10,
    fetch_types: false,
    prepare: true,
    onnotice: () => undefined,
  });

  const options = {
    tables: collectTables(),
    namespace: CLOUDFLARE_NAMESPACE,
    version: CLOUDFLARE_SCHEMA_VERSION,
    provider: "postgresql" as const,
  };

  const schema = createDrizzleRuntimeSchemaFromTables(options);
  const drizzleDb = drizzle(sql, { schema });

  // Pass the FULL drizzle handle (not D1's run-only view): Postgres supports
  // transactional DDL, so the idempotent `CREATE TABLE IF NOT EXISTS` bring-up
  // runs atomically. Postgres has no legacy D1 data, so the data-migration is a
  // no-op (see ./data-migrations.ts).
  await ensureDrizzleRuntimeSchemaFromTables(drizzleDb, options);
  await runCloudflarePostgresDataMigrations(sql, env.BLOBS);

  const { db: fumaDb, fuma } = createExecutorFumaDb(drizzleDb, options);

  return {
    db: fumaDb,
    fuma,
    // Fire-and-forget, like apps/cloud: the Worker/DO request context ends
    // before sql.end() resolves. In the Worker happy path this is never called
    // (isolate eviction is Cloudflare-managed); in the MCP DO it ends the
    // per-session connection at session teardown.
    close: async () => {
      void sql.end({ timeout: 0 });
    },
    // R2 stays useful for multi-MB blobs even under Postgres (TOAST handles
    // large values, but the R2 seam keeps them out of table rows). Falls back
    // to the FumaDB `blob` table when no bucket is bound.
    blobs: env.BLOBS ? makeR2BlobStore(env.BLOBS) : undefined,
  };
};
