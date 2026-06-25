import { describe, expect, it } from "@effect/vitest";
import type { Hyperdrive } from "@cloudflare/workers-types";

import type { CloudflareEnv } from "../config";
import { isPostgresConfigured } from "./index";
import { resolveConnectionString } from "./postgres";

// The base env carries only what the db selector reads; the rest of
// CloudflareEnv is irrelevant to these pure decisions, so cast a minimal shape.
const env = (overrides: Partial<CloudflareEnv>): CloudflareEnv =>
  // oxlint-disable-next-line executor/no-double-cast -- test: minimal env shape; only the db-selector fields are read
  overrides as unknown as CloudflareEnv;

const fakeHyperdrive = (connectionString: string): Hyperdrive =>
  // oxlint-disable-next-line executor/no-double-cast -- test: only Hyperdrive.connectionString is read by the selector
  ({ connectionString }) as unknown as Hyperdrive;

const NEON = "postgresql://user:pass@ep-x.neon.tech/neondb?sslmode=require";
const DIRECT = "postgresql://postgres:postgres@127.0.0.1:5433/postgres";

describe("isPostgresConfigured", () => {
  it("is false with no Postgres credentials (D1 default)", () => {
    expect(isPostgresConfigured(env({}))).toBe(false);
  });

  it("is true when a Hyperdrive binding is present", () => {
    expect(isPostgresConfigured(env({ HYPERDRIVE: fakeHyperdrive(NEON) }))).toBe(true);
  });

  it("is true when DATABASE_URL + EXECUTOR_DIRECT_DATABASE_URL=true", () => {
    expect(
      isPostgresConfigured(env({ DATABASE_URL: DIRECT, EXECUTOR_DIRECT_DATABASE_URL: "true" })),
    ).toBe(true);
  });

  it("is false when DATABASE_URL is set without the direct escape hatch", () => {
    // A bare DATABASE_URL must NOT silently flip the seam to Postgres — the
    // operator has to opt in explicitly (HYPERDRIVE binding, or the flag).
    expect(isPostgresConfigured(env({ DATABASE_URL: DIRECT }))).toBe(false);
  });
});

describe("resolveConnectionString", () => {
  it("prefers the Hyperdrive connection string", () => {
    expect(
      resolveConnectionString(env({ HYPERDRIVE: fakeHyperdrive(NEON), DATABASE_URL: DIRECT })),
    ).toBe(NEON);
  });

  it("uses DATABASE_URL directly only behind EXECUTOR_DIRECT_DATABASE_URL=true", () => {
    expect(
      resolveConnectionString(
        env({
          HYPERDRIVE: fakeHyperdrive(NEON),
          DATABASE_URL: DIRECT,
          EXECUTOR_DIRECT_DATABASE_URL: "true",
        }),
      ),
    ).toBe(DIRECT);
  });

  it("falls back to DATABASE_URL when no Hyperdrive binding exists", () => {
    expect(resolveConnectionString(env({ DATABASE_URL: DIRECT }))).toBe(DIRECT);
  });

  it("returns empty string when nothing is configured (the fallback-to-D1 signal)", () => {
    expect(resolveConnectionString(env({}))).toBe("");
  });
});
