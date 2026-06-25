import { Context, Effect, Layer } from "effect";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import {
  createDrizzleRuntimeSchemaFromTables,
  ensureDrizzleRuntimeSchemaFromTables,
} from "@executor-js/fumadb/adapters/drizzle";

import {
  collectTables,
  createExecutorFumaDb,
  DbProvider,
  type ExecutorDbHandle,
} from "@executor-js/api/server";
import { makeR2BlobStore } from "@executor-js/cloudflare/blob-store";

import { CLOUDFLARE_NAMESPACE, CLOUDFLARE_SCHEMA_VERSION, type CloudflareEnv } from "../config";
import { runCloudflarePostgresDataMigrations } from "./data-migrations";

// ---------------------------------------------------------------------------
// Postgres (Neon via Hyperdrive) DbProvider — the opt-in alternative to the D1
// seam (see ./d1.ts). Selected by ./index.ts when a Hyperdrive binding or a
// direct DATABASE_URL is present; D1 stays the default.
//
// Modelled on the proven postgres.js + Hyperdrive path apps/cloud runs
// (apps/cloud/src/db/db.ts + fuma.ts + mcp/session-durable-object.ts). The
// critical constraint is that Cloudflare Workers forbid reusing an I/O object
// across request handlers, so the two host execution models differ:
//
//   - HTTP (stateless Worker): the connection lives in a REQUEST-SCOPED service
//     (`CfPgConnection`, acquired/released per request via `requestScoped` in
//     ExecutorApp.make). The DbProvider just assembles the FumaDB handle over
//     it and its `close` is a NO-OP — releasing the socket is the request
//     scope's job, NOT the executor-build scope's (which closes before the
//     handler runs). The schema is brought up ONCE at boot
//     (`ensurePostgresSchema`), never per request.
//   - MCP Durable Object (one persistent isolate per session): ONE long-lived
//     connection held for the session (`createPostgresExecutorDb`); the DO base
//     disposes it via its `end()` contract.
//
// host-cloudflare keeps RUNTIME `ensure` (no out-of-band migration step). Unlike
// D1, Postgres has transactional DDL and no 100-bound-parameter cap, so the D1
// workarounds (`interactiveTransactions: false`, `maxBoundParameters: 100`) are
// dropped and the bring-up runs with the FULL drizzle handle (DDL in a tx).
// ---------------------------------------------------------------------------

// postgres.js options. Shared base; the two lifetimes differ only in
// socket-hygiene timeouts, matching apps/cloud (db.ts vs mcp/session-do.ts).
const BASE_OPTS = {
  max: 1,
  connect_timeout: 10,
  fetch_types: false,
  prepare: true,
  onnotice: () => undefined,
} as const;
// Per-request (HTTP): no idle reaping; the request scope closes it explicitly.
const EPHEMERAL_OPTS = { idle_timeout: 0, max_lifetime: 60 } as const;
// Per-session (DO): hold the socket across the session's requests, recycling it
// on a short idle/lifetime so an idle session doesn't pin a backend connection.
const LONG_LIVED_OPTS = { idle_timeout: 5, max_lifetime: 120 } as const;

type Lifetime = "ephemeral" | "long-lived";

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

const makeSql = (env: CloudflareEnv, lifetime: Lifetime): Sql =>
  postgres(resolveConnectionString(env), {
    ...BASE_OPTS,
    ...(lifetime === "ephemeral" ? EPHEMERAL_OPTS : LONG_LIVED_OPTS),
  });

// The runtime Drizzle schema is pure and env-independent (derived from the fixed
// executor table set), so build it once and reuse it across every connection.
const options = {
  tables: collectTables(),
  namespace: CLOUDFLARE_NAMESPACE,
  version: CLOUDFLARE_SCHEMA_VERSION,
  provider: "postgresql" as const,
};
let cachedSchema: Record<string, unknown> | undefined;
const runtimeSchema = (): Record<string, unknown> =>
  (cachedSchema ??= createDrizzleRuntimeSchemaFromTables(options));

const blobStore = (env: CloudflareEnv) => (env.BLOBS ? makeR2BlobStore(env.BLOBS) : undefined);

// Boot-once schema bring-up on a short-lived connection that is closed
// immediately. The HTTP path runs this once per isolate (see ./index.ts) so the
// per-request connections never run DDL.
export const ensurePostgresSchema = async (env: CloudflareEnv): Promise<void> => {
  const sql = makeSql(env, "ephemeral");
  const drizzleDb = drizzle(sql, { schema: runtimeSchema() });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: release the boot connection even if DDL throws
  try {
    // Full drizzle handle (not D1's run-only view): Postgres supports
    // transactional DDL, so the idempotent `CREATE TABLE IF NOT EXISTS` bring-up
    // runs atomically. Postgres has no legacy D1 data, so the data-migration is
    // a no-op (see ./data-migrations.ts).
    await ensureDrizzleRuntimeSchemaFromTables(drizzleDb, options);
    await runCloudflarePostgresDataMigrations(sql, env.BLOBS);
  } finally {
    void sql.end({ timeout: 0 });
  }
};

// ---- HTTP path: request-scoped connection + no-op-close DbProvider ----------

interface CfPgConnectionShape {
  readonly sql: Sql;
  readonly db: ReturnType<typeof drizzle>;
}

// The per-request postgres socket, mirroring apps/cloud's `DbService`. Provided
// via `requestScoped` so its acquire/release spans the whole request fiber
// (Cloudflare I/O isolation), not the executor-build scope.
export class CfPgConnection extends Context.Service<CfPgConnection, CfPgConnectionShape>()(
  "@executor-js/host-cloudflare/CfPgConnection",
) {}

export const makeCfPgConnectionLayer = (env: CloudflareEnv): Layer.Layer<CfPgConnection> =>
  Layer.effect(CfPgConnection)(
    Effect.acquireRelease(
      Effect.sync((): CfPgConnectionShape => {
        const sql = makeSql(env, "ephemeral");
        return { sql, db: drizzle(sql, { schema: runtimeSchema() }) };
      }),
      ({ sql }) =>
        // oxlint-disable-next-line executor/no-promise-catch -- boundary: postgres.js close is best-effort at request-scope end
        Effect.promise(() => sql.end({ timeout: 0 }).catch(() => undefined)),
    ),
  );

// Assemble the FumaDB handle over the request-scoped connection. `close` is a
// no-op: CfPgConnection (request scope) owns the socket lifecycle.
export const postgresDbProviderLayer = (
  env: CloudflareEnv,
): Layer.Layer<DbProvider, never, CfPgConnection> =>
  Layer.effect(DbProvider)(
    Effect.map(CfPgConnection.asEffect(), ({ db }): ExecutorDbHandle => {
      const { db: fumaDb, fuma } = createExecutorFumaDb(db, options);
      return { db: fumaDb, fuma, close: async () => {}, blobs: blobStore(env) };
    }),
  );

// ---- MCP Durable Object path: one long-lived connection per session ---------

// One long-lived connection for the session, with the schema brought up on it
// (idempotent, once per session DO). The DO base manages teardown via `end()`.
export const createPostgresExecutorDb = async (env: CloudflareEnv): Promise<ExecutorDbHandle> => {
  const sql = makeSql(env, "long-lived");
  const drizzleDb = drizzle(sql, { schema: runtimeSchema() });
  await ensureDrizzleRuntimeSchemaFromTables(drizzleDb, options);
  await runCloudflarePostgresDataMigrations(sql, env.BLOBS);
  const { db: fumaDb, fuma } = createExecutorFumaDb(drizzleDb, options);
  return {
    db: fumaDb,
    fuma,
    close: async () => {
      void sql.end({ timeout: 0 });
    },
    blobs: blobStore(env),
  };
};
