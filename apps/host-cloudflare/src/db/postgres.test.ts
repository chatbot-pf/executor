// ---------------------------------------------------------------------------
// Postgres seam integration test
// ---------------------------------------------------------------------------
//
// Exercises createPostgresExecutorDb end-to-end against a real Postgres wire
// protocol: an in-process PGlite exposed over a TCP socket (the same approach
// apps/cloud's test harness uses), reached through postgres.js exactly as the
// deployed Worker reaches Neon through Hyperdrive. This proves:
//   - the runtime `ensure` bring-up works under provider "postgresql"
//   - a write/read round-trip works through the FumaDB orm
//   - REAL interactive transactions work (the D1 `interactiveTransactions:
//     false` workaround is gone): a committed tx persists both rows, a failed
//     tx rolls BOTH back — atomicity D1 could not give.
//
// PGlite is in-process (no Docker / external DB), so this runs unconditionally.

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { withQueryContext } from "@executor-js/fumadb/query";

import type { ExecutorDbHandle } from "@executor-js/api/server";

import type { CloudflareEnv } from "../config";
import { createPostgresExecutorDb } from "./postgres";

const PORT = Number(process.env.HOST_CF_TEST_DB_PORT ?? 5437);

let pglite: PGlite;
let server: PGLiteSocketServer;
let handle: ExecutorDbHandle;
// The executor tables carry a tenant policy (see core-schema.ts); the scoped
// executor binds the tenant context via withQueryContext, so the test does the
// same to write through the orm.
let db: ExecutorDbHandle["db"];

const integration = (slug: string) => ({
  tenant: "org_1",
  slug,
  plugin_id: "openapi",
  name: null,
  description: `desc-${slug}`,
  config: { kind: "test" },
  can_remove: true,
  can_refresh: false,
  created_at: new Date(),
  updated_at: new Date(),
});

beforeAll(async () => {
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, port: PORT, host: "127.0.0.1" });
  await server.start();

  // oxlint-disable-next-line executor/no-double-cast -- test: only the db-connection fields are read by createPostgresExecutorDb
  const env = {
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
    EXECUTOR_DIRECT_DATABASE_URL: "true",
  } as unknown as CloudflareEnv;
  handle = await createPostgresExecutorDb(env);
  db = withQueryContext(handle.db, { tenant: "org_1", subject: undefined });
});

afterAll(async () => {
  await handle?.close();
  await server?.stop();
  await pglite?.close();
});

describe("createPostgresExecutorDb", () => {
  it("brings up the schema and round-trips a row through the orm", async () => {
    const created = await db.create("integration", integration("round-trip"));
    expect(created.slug).toBe("round-trip");

    const found = await db.findFirst("integration", {
      where: (b) => b("slug", "=", "round-trip"),
    });
    expect(found?.plugin_id).toBe("openapi");
  });

  it("commits a real interactive transaction (no D1 auto-commit workaround)", async () => {
    await db.transaction(async (tx) => {
      await tx.create("integration", integration("tx-a"));
      await tx.create("integration", integration("tx-b"));
    });

    const a = await db.findFirst("integration", {
      where: (b) => b("slug", "=", "tx-a"),
    });
    const b = await db.findFirst("integration", {
      where: (b) => b("slug", "=", "tx-b"),
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it("rolls back BOTH writes when a transaction throws (atomicity)", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.create("integration", integration("rollback-1"));
        await tx.create("integration", integration("rollback-2"));
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- test: the tx callback must throw to exercise transaction rollback
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const one = await db.findFirst("integration", {
      where: (b) => b("slug", "=", "rollback-1"),
    });
    const two = await db.findFirst("integration", {
      where: (b) => b("slug", "=", "rollback-2"),
    });
    expect(one).toBeNull();
    expect(two).toBeNull();
  });
});
