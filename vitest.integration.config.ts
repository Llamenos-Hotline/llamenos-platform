import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "worker-integration",
    include: ["apps/worker/__tests__/integration/**/*.test.ts"],
    // No `passWithNoTests`. This tier ran in no workflow at all until #1641,
    // and a tier that reports success on an empty collection is the same
    // absent signal in a smaller form: a renamed directory or a bad rebase
    // would land as a green job that measured nothing. The ci.yml job also
    // compares vitest's own file count against the directory listing.
    environment: "node",
  },
  resolve: {
    alias: [
      { find: /^@shared\/(.*)/, replacement: path.resolve(__dirname, "packages/shared/$1") },
      { find: /^@worker\/(.*)/, replacement: path.resolve(__dirname, "apps/worker/$1") },
      { find: /^@protocol\/(.*)/, replacement: path.resolve(__dirname, "packages/protocol/$1") },
      { find: /^@\/(.*)/, replacement: path.resolve(__dirname, "src/client/$1") },
      // Integration tests run with drizzle-orm/postgres-js (Node.js compatible).
      // postgres-js installs transparent serializers for JSONB, so drizzle relies
      // on mapToDriverValue. The production bun-jsonb.ts has no toDriver (correct
      // for Bun SQL which handles object→JSONB natively). This alias substitutes a
      // postgres-js-compatible column that adds toDriver: JSON.stringify.
      {
        find: /^.*\/bun-jsonb$/,
        replacement: path.resolve(__dirname, "apps/worker/__tests__/helpers/test-jsonb.ts"),
      },
      // Same substitution vitest.unit.config.ts makes, and for the same
      // reason: the real packages/crypto/ffi.ts dlopens a native library
      // through `bun:ffi`, a scheme Node's ESM loader has no resolver for, so
      // any test importing code that transitively reaches apps/worker/lib/
      // crypto.ts aborts at collection with "Cannot find package 'bun:ffi'".
      // The mock is a full @noble implementation of the same contract, not a
      // stub. Missing here, response-conformance.test.ts failed at import and
      // contributed zero tests for as long as this tier went unrun (#1641).
      { find: "@llamenos/crypto/ffi", replacement: path.resolve(__dirname, "apps/worker/__tests__/mocks/llamenos-crypto-ffi.ts") },
    ],
  },
});
