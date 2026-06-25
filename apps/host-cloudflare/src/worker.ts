import { makeCloudflareApp } from "./app";
import type { CloudflareEnv } from "./config";

// The MCP session Durable Object class, bound as `MCP_SESSION` in wrangler.jsonc.
// Must be exported at the Worker entry module scope for the runtime to find it.
export { McpSessionDO } from "./mcp";

// ---------------------------------------------------------------------------
// The Worker fetch entry. `ExecutorApp.make`'s `toWebHandler()` produces a
// `(Request) => Promise<Response>` — exactly a Worker handler — so the entry is
// thin: build the app ONCE per isolate (memoized; the build runs the D1 schema
// bring-up), then forward every request to its handler. `env` (the D1 binding +
// Access vars) arrives with the request and is captured at build time.
// ---------------------------------------------------------------------------

let handlerPromise: Promise<(request: Request) => Promise<Response>> | null = null;

const resolveHandler = async (
  env: CloudflareEnv,
): Promise<(request: Request) => Promise<Response>> => {
  if (!handlerPromise) {
    handlerPromise = makeCloudflareApp(env).then(({ toWebHandler }) => toWebHandler().handler);
  }
  // oxlint-disable executor/no-try-catch-or-throw -- boundary: a boot failure (e.g. Postgres unreachable during schema bring-up) must not permanently poison the isolate; the memoized promise would replay the same rejection for every later request. Clear the memo on failure so the next request reattempts boot. D1 boots never hit this (a built-in binding does not fail); the Postgres path makes it a real network failure mode.
  try {
    return await handlerPromise;
  } catch (err) {
    handlerPromise = null;
    throw err;
  }
  // oxlint-enable executor/no-try-catch-or-throw
};

export default {
  fetch: async (request: Request, env: CloudflareEnv): Promise<Response> => {
    const serve = await resolveHandler(env);
    return serve(request);
  },
};
