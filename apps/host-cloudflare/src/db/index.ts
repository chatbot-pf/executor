import { Effect, Layer } from "effect";

import { DbProvider, dbProviderLayer, type ExecutorDbHandle } from "@executor-js/api/server";

import type { CloudflareEnv } from "../config";
import { createD1ExecutorDb } from "./d1";
import {
  CfPgConnection,
  createPostgresExecutorDb,
  ensurePostgresSchema,
  makeCfPgConnectionLayer,
  postgresDbProviderLayer,
  resolveConnectionString,
} from "./postgres";

// ---------------------------------------------------------------------------
// DB seam selector. D1 (SQLite) is the default: the template's
// zero-external-dependency single-Worker premise. The Postgres seam
// (Neon via Hyperdrive, see ./postgres.ts) activates ONLY when the operator has
// wired up credentials: a Hyperdrive binding, or a direct DATABASE_URL behind
// EXECUTOR_DIRECT_DATABASE_URL=true. Presence of credentials IS the signal, no
// separate provider flag, so doing nothing keeps D1.
// ---------------------------------------------------------------------------

export const isPostgresConfigured = (env: CloudflareEnv): boolean => {
  if (env.HYPERDRIVE) return true;
  if (env.EXECUTOR_DIRECT_DATABASE_URL === "true" && env.DATABASE_URL) return true;
  return false;
};

const warnPostgresMisconfigured = (): void => {
  console.error(
    "[executor-cloudflare] Postgres looked configured but no usable connection string was found " +
      "(set EXECUTOR_DIRECT_DATABASE_URL=true to use DATABASE_URL directly, or bind a Hyperdrive " +
      "config in wrangler.jsonc). Falling back to D1.",
  );
};

// Single handle for the MCP Durable Object (one long-lived connection held for
// the session). The HTTP path uses selectDbSeam instead.
export const createExecutorDb = async (env: CloudflareEnv): Promise<ExecutorDbHandle> => {
  if (isPostgresConfigured(env)) {
    if (resolveConnectionString(env)) return createPostgresExecutorDb(env);
    warnPostgresMisconfigured();
  }
  return createD1ExecutorDb(env.DB, env.BLOBS);
};

// The HTTP db wiring, as a discriminated union the app composes into
// ExecutorApp.make. Postgres carries a `requestScoped` connection layer (the
// socket lives in the request fiber's scope; Cloudflare forbids sharing it
// across requests); the DbProvider reads it with a no-op close. D1 has no
// request scope (the binding is not a socket) and reuses one memoized handle.
export type CloudflareDbSeam =
  | { readonly kind: "d1"; readonly db: Layer.Layer<DbProvider> }
  | {
      readonly kind: "postgres";
      readonly db: Layer.Layer<DbProvider, never, CfPgConnection>;
      readonly requestScoped: Layer.Layer<CfPgConnection>;
    };

export const selectDbSeam = async (env: CloudflareEnv): Promise<CloudflareDbSeam> => {
  if (isPostgresConfigured(env) && resolveConnectionString(env)) {
    // Bring the schema up ONCE per isolate; per-request connections never DDL.
    await ensurePostgresSchema(env);
    return {
      kind: "postgres",
      db: postgresDbProviderLayer(env),
      requestScoped: makeCfPgConnectionLayer(env),
    };
  }
  if (isPostgresConfigured(env)) warnPostgresMisconfigured();
  const handle = await createD1ExecutorDb(env.DB, env.BLOBS);
  return { kind: "d1", db: dbProviderLayer(Effect.succeed(handle)) };
};
