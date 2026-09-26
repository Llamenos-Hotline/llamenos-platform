import { defineConfig, devices } from "@playwright/test";
import { defineBddProject } from "playwright-bdd";

// ESM-safe worktree detection (no __dirname in ESM scope)
const configDir = new URL(".", import.meta.url).pathname;

// Desktop BDD: exclude tests/steps/backend/ to avoid loading backend-only step defs
// that use a different createBdd() instance.
const desktopStepDirs = [
  "admin", "auth", "calls", "cases", "common", "config", "contacts", "conversations",
  "crypto", "dashboard", "help", "hub", "messaging", "notes", "reports",
  "security", "settings", "shifts",
];

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
      workers: process.env.CI ? 4 : 3,
  reporter: process.env.CI
    ? [
        ["github"],
        ["json", { outputFile: "test-results/results.json" }],
        ["line"],
      ]
    : [["list"]],
  timeout: process.env.CI ? 60_000 : 30_000,
  globalSetup: './tests/global-setup.ts',
  expect: {
    timeout: process.env.CI ? 15_000 : 10_000,
  },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${process.env.PLAYWRIGHT_PORT || "8788"}`,
    trace: "on-first-retry",
    actionTimeout: process.env.CI ? 15_000 : 10_000,
    navigationTimeout: process.env.CI ? 30_000 : 15_000,
  },
  projects: [
    {
      // Bootstrap tests delete the admin user (test-reset-no-admin) and must run
      // before all parallel tests to avoid corrupting shared DB state.
      // The last bootstrap test restores normal state via resetTestState().
      name: "bootstrap",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/bootstrap.spec.ts"],
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // Exclude bootstrap tests and screenshots — bootstrap runs in its own project above,
      // screenshots are on-demand only (run via `bun run test:screenshots`).
      testIgnore: ["**/live/**", "**/desktop/**", "**/integration/**", "**/orchestrator/**", "**/bootstrap.spec.ts", "**/screenshots.*", "**/screenshots.spec.ts", "**/*.test.ts"],
      // `**/*.test.ts` are Bun tests (they `import { test } from "bun:test"`).
      // Node's ESM loader has no `bun:` scheme, so collecting one aborts the
      // entire run at load time before any spec executes — see #936. A global
      // `testMatch` cannot be used here: defineBddProject sets its own testDir
      // and emits generated `.feature.spec.js`, which a `*.spec.ts` matcher
      // starves ("No tests found" on backend-bdd).
      // Wait for bootstrap tests to complete and restore admin before parallel tests run.
      dependencies: ["bootstrap"],
    },
    {
      ...defineBddProject({
        name: "bdd",
        features: "packages/test-specs/features/**/*.feature",
        steps: [
          "tests/steps/*.ts",
          ...desktopStepDirs.map((d) => `tests/steps/${d}/**/*.ts`),
        ],
        featuresRoot: "packages/test-specs/features",
        tags: "@desktop and not @backend and not @wip and not @fixme and not @requires-camera and not @requires-live-calls and not @requires-demo",
        // Backend-only scenarios have steps not defined in desktop — skip them
        missingSteps: "skip-scenario",
      }),
      use: { ...devices["Desktop Chrome"] },
      fullyParallel: true,
      // Wait for bootstrap tests to complete and restore admin before BDD workers start.
      // workerHub fixture calls POST /api/hubs at worker startup — if bootstrap's
      // test-reset-no-admin runs concurrently, the admin user is missing and the call gets 401.
      dependencies: ["bootstrap"],
    },
    {
      ...defineBddProject({
        name: "backend-bdd",
        features: "packages/test-specs/features/**/*.feature",
        steps: "tests/steps/backend/**/*.ts",
        featuresRoot: "packages/test-specs/features",
        tags: "@backend and not @wip and not @fixme and not @global-setting and not @demo-mode and not @signed-webhooks",
        // Desktop/mobile-only scenarios have steps not defined in backend — skip them
        missingSteps: "skip-scenario",
      }),
      use: {
        baseURL: process.env.TEST_HUB_URL || "http://localhost:3000",
      },
      fullyParallel: true,
  workers: process.env.CI ? 4 : 3,
      // Wait for bootstrap tests to finish before starting.
      // backend-bdd scenarios create a hub per-scenario via workerHub fixture —
      // if bootstrap's test-reset-no-admin runs concurrently, the admin is gone
      // and hub creation returns 401.
      dependencies: ["bootstrap"],
    },
    {
      // Serial project for @global-setting scenarios (#676, follow-up to #672/#670/#671).
      // backend-bdd above runs fullyParallel against one shared server; some scenarios
      // mutate a *global*, server-wide system setting (not scenario- or hub-scoped), which
      // would poison every concurrent scenario the way #671 did. Those scenarios are tagged
      // @global-setting and excluded from backend-bdd's tag filter above — this is the only
      // project allowed to run them, one at a time, with workers:1 forcing serial execution.
      // Step files for these scenarios are responsible for resetting the setting through the
      // API in an `After` hook (see tests/steps/backend/webauthn-policy.steps.ts) — this
      // project intentionally has no separate teardown project, since a per-scenario reset
      // is required regardless (a later scenario in the same file must never inherit a prior
      // scenario's mutation either).
      ...defineBddProject({
        name: "backend-bdd-global-setting",
        features: "packages/test-specs/features/**/*.feature",
        steps: "tests/steps/backend/**/*.ts",
        featuresRoot: "packages/test-specs/features",
        tags: "@backend and @global-setting and not @wip and not @fixme",
        missingSteps: "skip-scenario",
      }),
      use: {
        baseURL: process.env.TEST_HUB_URL || "http://localhost:3000",
      },
      fullyParallel: false,
      workers: 1,
      dependencies: ["bootstrap"],
    },
    {
      // Serial project for @demo-mode scenarios (#723). They exercise the MockTelephonyAdapter,
      // which is only constructible on a server started with DEMO_MODE=true and
      // DEMO_MODE_CONFIRM set — so they are excluded from backend-bdd above (whose server is
      // not in demo mode) and run here, opt-in, via `BDD_DEMO_MODE=true bun run test:backend:bdd`
      // against a demo-mode server. They fail loudly (never skip) when the server is not.
      ...defineBddProject({
        name: "backend-bdd-demo-mode",
        features: "packages/test-specs/features/**/*.feature",
        steps: "tests/steps/backend/**/*.ts",
        featuresRoot: "packages/test-specs/features",
        tags: "@backend and @demo-mode and not @wip and not @fixme",
        missingSteps: "skip-scenario",
      }),
      use: {
        baseURL: process.env.TEST_HUB_URL || "http://localhost:3000",
      },
      fullyParallel: false,
      workers: 1,
      dependencies: ["bootstrap"],
    },
    {
      // Opt-in project for @signed-webhooks scenarios (#1036). They post REAL provider-signed
      // webhooks to /api/telephony/*, which needs the server's env-var Twilio provider
      // (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER) with the same values
      // exported to the test process. That is instance-wide config, so they are excluded from
      // backend-bdd above and run here via `BDD_SIGNED_WEBHOOKS=true bun run test:backend:bdd`.
      // The steps fail loudly (never skip) when that environment is missing.
      ...defineBddProject({
        name: "backend-bdd-signed-webhooks",
        features: "packages/test-specs/features/**/*.feature",
        steps: "tests/steps/backend/**/*.ts",
        featuresRoot: "packages/test-specs/features",
        tags: "@backend and @signed-webhooks and not @wip and not @fixme",
        missingSteps: "skip-scenario",
      }),
      use: {
        baseURL: process.env.TEST_HUB_URL || "http://localhost:3000",
      },
      fullyParallel: false,
      workers: 1,
      dependencies: ["bootstrap"],
    },
    {
      // On-demand screenshot capture — NOT included in default CI runs.
      // Run via: bun run test:screenshots
      name: "screenshots",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
      testMatch: ["**/screenshots.spec.ts"],
      retries: 0,
      dependencies: ["bootstrap"],
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // Build once, then serve static files — far more stable than Vite dev server
        // under parallel test load (4 workers × 535 tests).
        // Uses `vite preview` which serves the production build without HMR.
        // PLAYWRIGHT_PORT lets a worker whose worktree isn't under `.worktrees/`
        // (so the reuseExistingServer guard below doesn't trip) bind an isolated
        // port instead of silently reusing another checkout's stale build.
        command:
          `PLAYWRIGHT_TEST=true bun run build && PLAYWRIGHT_TEST=true bunx vite preview --port ${process.env.PLAYWRIGHT_PORT || "8788"} --strictPort`,
        url: `http://localhost:${process.env.PLAYWRIGHT_PORT || "8788"}`,
        // Never reuse a server from a different worktree or main checkout —
        // stale builds silently serve wrong code, causing hard-to-diagnose
        // test failures when testIds or API responses don't match the branch.
        reuseExistingServer: !process.env.CI && !configDir.includes("/.worktrees/"),
        timeout: 120_000, // Allow time for the build step
      },
});
