/**
 * Ambient `Window` augmentations for E2E test helpers (Playwright + WebdriverIO).
 *
 * These mirror the `__TEST_*` globals `src/client/main.tsx` assigns to `window`
 * in dev/test builds (see the `declare global` block there), plus the real
 * Tauri v2 webview bridge object the Tauri runtime itself injects. Kept as a
 * standalone tests-only file (rather than importing main.tsx, which has
 * module-level side effects) so specs can reference these types without
 * pulling in app bootstrap code.
 */

/** Minimal navigation surface used by test helpers — decoupled from the
 * app's generated route tree so this file has no build-time dependency on
 * TanStack Router codegen output. */
interface TestRouter {
  navigate: (opts: { to: string; search?: Record<string, unknown> }) => void | Promise<void>
}

/** The real Tauri v2 webview bridge, injected by the Tauri runtime itself
 * (not a mock) — only present when running against a packaged/dev desktop
 * build, exercised by the WebdriverIO specs under tests/desktop/. Shape is
 * Tauri's internal, undocumented `window.__TAURI_INTERNALS__` — kept to the
 * handful of fields these diagnostic specs actually read. */
interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  metadata?: {
    currentWindow?: { label?: string }
    windows?: unknown[]
  }
}

declare global {
  interface Window {
    __TEST_ROUTER?: TestRouter
    __TEST_GET_ACTIVE_HUB?: () => string | null
    __TEST_SET_ACTIVE_HUB?: (id: string | null) => void
    __TEST_PLATFORM?: typeof import('../src/client/lib/platform')
    __TAURI_INTERNALS__?: TauriInternals
  }
}

export {}
