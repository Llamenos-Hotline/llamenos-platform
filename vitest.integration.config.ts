import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "worker-integration",
    include: ["apps/worker/__tests__/integration/**/*.test.ts"],
    // passWithNoTests is deliberately NOT set (#1167). It was `true`, which
    // made the whole suite report success when the `include` glob matched
    // nothing — a renamed directory or a typo in the pattern read as a pass.
    // With it absent (vitest's default is false) an empty match is a hard
    // failure. The *count* floor is enforced one level up, by
    // scripts/test-worker-integration.ts, because vitest cannot assert
    // "N files actually ran" from inside its own config.
    environment: "node",
    // vitest's default testTimeout is 5s and hookTimeout 10s. Four of these
    // files spawn a subprocess (`run-migrations.ts`, the real server entry
    // point) and every one of them creates and drops its own database, so
    // those defaults are not reachable budgets on a hosted runner. In
    // particular startup-init.test.ts declares its own BOOT_TIMEOUT_MS of
    // 60s, which only means anything if vitest allows the test to live that
    // long. The job's own `timeout-minutes` remains the outer bound.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: [
      { find: /^@shared\/(.*)/, replacement: path.resolve(__dirname, "packages/shared/$1") },
      { find: /^@worker\/(.*)/, replacement: path.resolve(__dirname, "apps/worker/$1") },
      { find: /^@protocol\/(.*)/, replacement: path.resolve(__dirname, "packages/protocol/$1") },
      { find: /^@\/(.*)/, replacement: path.resolve(__dirname, "src/client/$1") },
      // Map the Rust FFI module to a pure-TypeScript mock for the Node/Vitest
      // environment, exactly as vitest.unit.config.ts does. The real ffi.ts
      // imports `bun:ffi`, which does not exist outside Bun, so any test whose
      // import graph reaches apps/worker/lib/crypto.ts (every route module
      // does) failed to LOAD with `Cannot find package 'bun:ffi'` and
      // contributed zero tests. That is what took response-conformance.test.ts
      // out of the suite entirely (#1167).
      //
      // This affects in-process imports only. startup-init.test.ts boots
      // src/server/index.ts as a real Bun subprocess, which is unaffected by
      // vitest aliases and loads the genuine native library — so that file
      // still needs packages/crypto/dist/server/libllamenos_core.so to exist
      // (`packages/crypto/scripts/build-server.sh`).
      {
        find: "@llamenos/crypto/ffi",
        replacement: path.resolve(__dirname, "apps/worker/__tests__/mocks/llamenos-crypto-ffi.ts"),
      },
      // Integration tests run with drizzle-orm/postgres-js (Node.js compatible).
      // postgres-js installs transparent serializers for JSONB, so drizzle relies
      // on mapToDriverValue. The production bun-jsonb.ts has no toDriver (correct
      // for Bun SQL which handles object→JSONB natively). This alias substitutes a
      // postgres-js-compatible column that adds toDriver: JSON.stringify.
      {
        find: /^.*\/bun-jsonb$/,
        replacement: path.resolve(__dirname, "apps/worker/__tests__/helpers/test-jsonb.ts"),
      },
    ],
  },
});
