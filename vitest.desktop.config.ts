import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "desktop-unit",
    include: [
      "src/client/lib/**/*.test.ts",
      "src/client/lib/**/*.test.tsx",
      "src/client/components/**/__tests__/**/*.test.ts",
      "src/client/components/**/__tests__/**/*.test.tsx",
    ],
    environment: "happy-dom",
    setupFiles: ["./vitest.desktop.setup.ts"],
  },
  resolve: {
    alias: [
      { find: /^@shared\/(.*)/, replacement: path.resolve(__dirname, "packages/shared/$1") },
      { find: /^@protocol\/(.*)/, replacement: path.resolve(__dirname, "packages/protocol/$1") },
      { find: /^@\/(.*)/, replacement: path.resolve(__dirname, "src/client/$1") },
      { find: "@llamenos/crypto/ffi", replacement: path.resolve(__dirname, "apps/worker/__tests__/mocks/llamenos-crypto-ffi.ts") },
    ],
  },
});
