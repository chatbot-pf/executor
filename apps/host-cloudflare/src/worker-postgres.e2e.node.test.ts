import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

// ---------------------------------------------------------------------------
// End-to-end test for the Cloudflare host's POSTGRES seam on the REAL workerd
// runtime (wrangler `unstable_dev`/Miniflare). A local PGlite stands in for Neon
// over a TCP socket; the worker is booted with DATABASE_URL +
// EXECUTOR_DIRECT_DATABASE_URL=true so the db seam (selectDbSeam / createExecutorDb)
// takes the Postgres branch (no Hyperdrive binding needed for the direct path).
//
// The point this test pins that a node-only test CANNOT: Cloudflare Workers
// forbid reusing an I/O object across request handlers. The HTTP db seam opens a
// FRESH postgres connection per request scope; if it instead shared one
// connection across requests (the pre-fix bug), the SECOND db-touching request
// would fail with "Cannot perform I/O on behalf of a different request". So the
// assertions deliberately span multiple sequential requests.
// ---------------------------------------------------------------------------

const dir = fileURLToPath(new URL(".", import.meta.url));
const runId = randomUUID().slice(0, 8);
const PORT = Number(process.env.HOST_CF_E2E_DB_PORT ?? 5438);

const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Test", version: "1.0.0" },
  servers: [{ url: "https://example.com" }],
  paths: {
    "/ping": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } },
  },
});

describe("cloudflare host POSTGRES e2e (workerd/miniflare + PGlite)", () => {
  let pglite: PGlite;
  let server: PGLiteSocketServer;
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    pglite = await PGlite.create();
    server = new PGLiteSocketServer({ db: pglite, port: PORT, host: "127.0.0.1" });
    await server.start();

    // wrangler's assets validation needs ./dist/index.html present even though
    // this test only drives run_worker_first API paths (mirrors the D1 e2e).
    const distIndex = resolve(dir, "../dist/index.html");
    if (!existsSync(distIndex)) {
      mkdirSync(resolve(dir, "../dist"), { recursive: true });
      writeFileSync(distIndex, "<!doctype html><title>executor</title>");
    }

    worker = await unstable_dev(resolve(dir, "worker.ts"), {
      config: resolve(dir, "../wrangler.jsonc"),
      ip: "127.0.0.1",
      local: true,
      experimental: { disableExperimentalWarning: true },
      vars: {
        EXECUTOR_SECRET_KEY: "test-secret-key-0123456789abcdef",
        ENABLE_DEV_AUTH: "true",
        // The direct-connection escape hatch: take the Postgres branch without a
        // Hyperdrive binding, pointing at the local PGlite socket.
        DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
        EXECUTOR_DIRECT_DATABASE_URL: "true",
      },
    });
  }, 120_000);

  afterAll(async () => {
    await worker?.stop();
    await server?.stop();
    await pglite?.close();
  });

  it("adds an OpenAPI source then reads it back across SEPARATE requests (per-request Postgres connection)", async () => {
    const slug = `pgapi-${runId}`;
    // Request 1: a db write — opens a fresh connection, writes, releases it.
    const add = await worker.fetch("/api/openapi/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spec: { kind: "blob", value: SPEC },
        slug,
        description: "PG API",
        baseUrl: "https://example.com",
      }),
    });
    expect(add.status).toBe(200);
    const added = (await add.json()) as { toolCount: number };
    expect(added.toolCount).toBeGreaterThan(0);

    // Request 2: a db read on a NEW request. With a shared cross-request
    // connection this is exactly where workerd throws; with a per-request
    // connection it just works.
    const got = await worker.fetch(`/api/openapi/integrations/${slug}`);
    expect(got.status).toBe(200);
    const integration = (await got.json()) as { slug: string } | null;
    expect(integration?.slug).toBe(slug);
  }, 90_000);

  it("survives many sequential db-touching requests (no I/O-context reuse error)", async () => {
    // Several independent requests in a row, each must acquire+release its own
    // connection. A shared connection would fail on the 2nd here.
    for (let i = 0; i < 3; i++) {
      const slug = `pgloop-${runId}-${i}`;
      const add = await worker.fetch("/api/openapi/specs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spec: { kind: "blob", value: SPEC },
          slug,
          description: `loop ${i}`,
          baseUrl: "https://example.com",
        }),
      });
      expect(add.status).toBe(200);
    }
  }, 90_000);

  it("invokes the execute tool over MCP against Postgres (DO long-lived connection)", async () => {
    const accept = "application/json, text/event-stream";
    const rpc = (sessionId: string | null, body: unknown) =>
      worker.fetch("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept,
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(body),
      });

    const init = await rpc(null, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    await rpc(sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });

    // tools/call on a follow-up request: the DO holds ONE long-lived Postgres
    // connection for the session across these separate requests.
    const call = await rpc(sessionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "execute", arguments: { code: "export default 6 * 7" } },
    });
    expect(call.status).toBe(200);
    const result = (await call.json()) as {
      result?: { structuredContent?: { result?: number } };
    };
    expect(result.result?.structuredContent?.result).toBe(42);
  }, 90_000);
});
