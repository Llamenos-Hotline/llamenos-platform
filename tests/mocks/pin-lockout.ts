/**
 * localStorage key the Tauri IPC mock (tests/mocks/tauri-core.ts) uses to hold
 * PIN lockout state across page reloads inside a scenario. Shared so the
 * runner-side resets in tests/helpers.ts and the browser-side mock can never
 * drift apart, and named in the __TEST_* convention for app-hooks that are
 * part of the mock surface (not step-to-step state handoffs — those live in
 * scenario fixtures now).
 */
export const MOCK_PIN_LOCKOUT_STORAGE_KEY = '__TEST_MOCK_PIN_LOCKOUT_STATE__'
