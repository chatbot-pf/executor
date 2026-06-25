import { HttpEffect, HttpRouter } from "effect/unstable/http";

import { ExecutorApp, textFailureStrategy } from "@executor-js/api/server";

import { loadConfig, type CloudflareEnv } from "./config";
import { makeCloudflarePlugins } from "./plugins";
import { selectDbSeam } from "./db";
import { cloudflareAccessIdentityLayer } from "./auth/cloudflare-access";
import {
  CloudflareCodeExecutorProvider,
  makeCloudflareHostConfig,
  makeCloudflarePluginsProvider,
} from "./execution";
import { ErrorCaptureLive } from "./observability";
import { cloudflareAccountMiddleware } from "./account/account-provider";
import { makeCloudflareMcpSeams } from "./mcp";
import { preloadQuickJs } from "./quickjs";

// ===========================================================================
// The Cloudflare host, as ONE `ExecutorApp.make` call — the 4th app alongside
// cloud / self-host / local, differing only by the injected Layers.
//
// The whole scenario in 60 seconds: Cloudflare Access is the identity (validate
// the Cf-Access-Jwt-Assertion JWT — no Better Auth, no WorkOS, no app login),
// D1 is the SQLite store (same FumaDB assembly as self-host), QuickJS is the
// in-process code substrate, no billing, single-tenant. `diff` against
// host-selfhost/src/app.ts is three injected Layers: identity, db, plugins/config.
//
// Built per isolate (async) so the D1 schema bring-up happens once at first
// fetch; `env` arrives with that fetch (a Worker has no module-scope bindings),
// so the providers close over it instead of reading process.env.
// ===========================================================================

export const makeCloudflareApp = async (env: CloudflareEnv) => {
  const config = loadConfig(env);
  const plugins = makeCloudflarePlugins(config.secretKey);

  // Load the Workers-compatible (WASM-inlined) QuickJS variant before any
  // executor is built — the default variant can't fetch its .wasm on Workers.
  await preloadQuickJs();

  // The db seam: D1 by default (one memoized handle); a Hyperdrive binding /
  // DATABASE_URL switches it to Postgres, where the schema is brought up once
  // here and each request gets a fresh connection in its own fiber scope via
  // `requestScoped` (Cloudflare forbids sharing a socket across requests).
  const seam = await selectDbSeam(env);
  const identityLayer = cloudflareAccessIdentityLayer(config);
  // MCP runs through the `MCP_SESSION` Durable Object (cross-isolate sessions);
  // each session DO opens its own db handle, so it takes `env`, not a handle.
  const mcp = makeCloudflareMcpSeams(config, env);

  // Everything but the db provider + (Postgres-only) request scope is identical
  // across the two seams.
  const commonProviders = {
    identity: identityLayer,
    engine: { codeExecutor: CloudflareCodeExecutorProvider }, // decorator defaults to no-op
    plugins: {
      provider: makeCloudflarePluginsProvider(config),
      config: makeCloudflareHostConfig(config),
    },
    errorCapture: ErrorCaptureLive,
    // The account API (`/api/account/*`) backs the shared multiplayer shell's
    // auth context; `me` reflects the Access principal. Members/keys are
    // Access-managed, so the rest of the surface is stubbed.
    account: cloudflareAccountMiddleware(config),
    // The MCP serving envelope: Access-JWT auth + the shared in-process session
    // store over the QuickJS engine.
    mcp: { auth: mcp.auth, sessions: mcp.sessions, reporter: mcp.reporter },
  };
  const common = {
    plugins,
    extensions: {
      routes: [
        // Browser approval of paused MCP executions: the console resume page
        // reads paused detail (GET) and records the decision (POST .../resume),
        // Access-gated, routed to the owning session's Durable Object.
        HttpRouter.add("*", "/api/mcp-sessions/*", HttpEffect.fromWebHandler(mcp.approvalHandler)),
      ],
    },
    config: { mountPrefix: "/api" as const, failure: textFailureStrategy },
    boot: identityLayer,
  };

  // Postgres provides its per-request connection through `requestScoped` so the
  // socket's acquire/release spans the whole request fiber; D1 needs no request
  // scope. Two `make` calls (rather than a conditional field) keep the residual
  // types exact: Postgres's `db` carries a `CfPgConnection` requirement that
  // only `requestScoped` satisfies.
  const { appLayer, toWebHandler } =
    seam.kind === "postgres"
      ? ExecutorApp.make({
          ...common,
          providers: { ...commonProviders, db: seam.db },
          requestScoped: seam.requestScoped,
        })
      : ExecutorApp.make({
          ...common,
          providers: { ...commonProviders, db: seam.db },
        });

  return { appLayer, toWebHandler };
};
