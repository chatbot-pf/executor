import type { ExecutorDbHandle } from "@executor-js/api/server";

import type { CloudflareEnv } from "../config";
import { createD1ExecutorDb } from "./d1";
import { createPostgresExecutorDb, resolveConnectionString } from "./postgres";

// ---------------------------------------------------------------------------
// DB seam selector. D1 (SQLite) is the default — the template's
// zero-external-dependency single-Worker premise. The Postgres seam
// (Neon via Hyperdrive, see ./postgres.ts) activates ONLY when the operator has
// wired up credentials: a Hyperdrive binding, or a direct DATABASE_URL behind
// EXECUTOR_DIRECT_DATABASE_URL=true. Presence of credentials IS the signal — no
// separate provider flag — so doing nothing keeps D1.
// ---------------------------------------------------------------------------

export const isPostgresConfigured = (env: CloudflareEnv): boolean => {
  if (env.HYPERDRIVE) return true;
  if (env.EXECUTOR_DIRECT_DATABASE_URL === "true" && env.DATABASE_URL) return true;
  return false;
};

export const createExecutorDb = async (env: CloudflareEnv): Promise<ExecutorDbHandle> => {
  if (isPostgresConfigured(env)) {
    // Guard against a partial Postgres config (e.g. DATABASE_URL set but neither
    // a Hyperdrive binding nor EXECUTOR_DIRECT_DATABASE_URL=true): rather than
    // let postgres.js fail with an opaque connect error, warn loudly and fall
    // back to D1 so a misconfigured deploy is obvious but still boots.
    if (resolveConnectionString(env)) {
      return createPostgresExecutorDb(env);
    }
    console.error(
      "[executor-cloudflare] Postgres looked configured but no usable connection string was found " +
        "(set EXECUTOR_DIRECT_DATABASE_URL=true to use DATABASE_URL directly, or bind a Hyperdrive " +
        "config in wrangler.jsonc). Falling back to D1.",
    );
  }
  return createD1ExecutorDb(env.DB, env.BLOBS);
};
