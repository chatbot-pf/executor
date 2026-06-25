import { Effect, Layer } from "effect";

import {
  CodeExecutorProvider,
  DbProvider,
  dbProviderLayer,
  EngineDecorator,
  EngineDecoratorNoop,
  HostConfig,
  PluginsProvider,
  type ExecutorDbHandle,
} from "@executor-js/api/server";
import { makeDynamicWorkerExecutor } from "@executor-js/runtime-dynamic-worker";

import type { CloudflareConfig } from "./config";
import { makeCloudflarePlugins } from "./plugins";

// ---------------------------------------------------------------------------
// Cloudflare execution-stack seams. The plugins + host config are built from the
// per-request `env`-derived config rather than process.env, with a no-op engine
// decorator (no billing).
//
// The code substrate is the dynamic-worker executor (the same one cloud uses):
// each execution loads a fresh workerd isolate through the `LOADER` Worker Loader
// binding. Unlike cloud, which reads the ambient `cloudflare:workers` env, the
// host threads `env.LOADER` explicitly through the seam (the host's deliberate
// pattern: a Worker receives its bindings per request, so providers close over
// `env` rather than a module-scope import).
// ---------------------------------------------------------------------------

export { makeExecutionStack } from "@executor-js/api/server";
export { EngineDecoratorNoop };

export const makeCloudflareCodeExecutorProvider = (
  loader: WorkerLoader,
): Layer.Layer<CodeExecutorProvider> =>
  Layer.sync(CodeExecutorProvider, () => makeDynamicWorkerExecutor({ loader }));

export const makeCloudflarePluginsProvider = (
  config: CloudflareConfig,
): Layer.Layer<PluginsProvider> =>
  Layer.succeed(PluginsProvider)({
    plugins: () => makeCloudflarePlugins(config.secretKey),
  });

export const makeCloudflareHostConfig = (config: CloudflareConfig): Layer.Layer<HostConfig> =>
  Layer.succeed(HostConfig)({
    allowLocalNetwork: config.allowLocalNetwork,
    webBaseUrl: config.webBaseUrl,
    oauthCallbackPath: "/api/oauth/callback",
  });

/**
 * The five execution-stack seams the shared `makeExecutionStack` reads from,
 * bundled into one Layer over the long-lived D1 handle. Mirrors self-host's
 * `SelfHostExecutionStackLayer`. The HTTP path wires these seams individually
 * through `ExecutorApp.make`; the MCP session store provides this whole Layer to
 * build a per-session engine off the envelope's request pipeline.
 */
export const makeCloudflareExecutionStackLayer = (
  config: CloudflareConfig,
  dbHandle: ExecutorDbHandle,
  loader: WorkerLoader,
): Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator
> =>
  Layer.mergeAll(
    dbProviderLayer(Effect.succeed(dbHandle)),
    makeCloudflarePluginsProvider(config),
    makeCloudflareHostConfig(config),
    makeCloudflareCodeExecutorProvider(loader),
    EngineDecoratorNoop,
  );
