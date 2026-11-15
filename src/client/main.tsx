import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { AuthProvider } from '@/lib/auth'
import { ConfigProvider } from '@/lib/config'
import * as testApiConfig from '@/lib/api-config'
import { initApiBase } from '@/lib/api-config'
import { ThemeProvider } from '@/lib/theme'
import { ToastProvider } from '@/lib/toast'
import { NoteSheetProvider } from '@/lib/note-sheet-context'
import { installGlobalErrorHandlers, uploadPendingReports, isCrashReportingEnabled } from '@/lib/crash-reporting'
import * as testPlatform from '@/lib/platform'
import * as testKeyManager from '@/lib/key-manager'
import * as testApi from '@/lib/api'
import { offlineQueue as testOfflineQueue } from '@/lib/offline-queue'
import '@/lib/i18n'
import '@/app.css'

// Install global error handlers for crash reporting (respects consent)
installGlobalErrorHandlers()

// Upload any pending crash reports from previous sessions. Failures keep the
// reports pending; where uploads are unavailable (desktop app) the reason is
// logged by uploadPendingReports itself.
if (isCrashReportingEnabled()) {
  uploadPendingReports().catch(() => {})
}

const router = createRouter({ routeTree })

// Expose router and key-manager for E2E test navigation
declare global {
  interface Window {
    __TEST_ROUTER: typeof router
    __TEST_KEY_MANAGER: typeof import('./lib/key-manager')
    __TEST_PLATFORM: typeof import('./lib/platform')
    __TEST_SET_ACTIVE_HUB: (id: string | null) => void
    __TEST_GET_ACTIVE_HUB: () => string | null
    __TEST_API_CONFIG: typeof import('./lib/api-config')
    __TEST_OFFLINE_QUEUE: typeof import('./lib/offline-queue').offlineQueue
    /** Set via page.addInitScript to exercise packaged-desktop-only behavior (#738/#739) under the Playwright mock. */
    __TEST_SIMULATE_PACKAGED_TAURI__?: boolean
  }
}
if (typeof window !== 'undefined' && (import.meta.env.DEV || import.meta.env.PLAYWRIGHT_TEST)) {
  // Assigned synchronously from static imports (not dynamic import()) so tests
  // waiting on window.__TEST_PLATFORM never race a chunk-load — see e2e shard 1
  // flake where `waitForFunction(() => !!window.__TEST_PLATFORM)` timed out
  // under CI load because the dynamic import resolved too slowly.
  window.__TEST_ROUTER = router
  window.__TEST_KEY_MANAGER = testKeyManager
  window.__TEST_PLATFORM = testPlatform
  window.__TEST_SET_ACTIVE_HUB = testApi.setActiveHub
  window.__TEST_GET_ACTIVE_HUB = testApi.getActiveHub
  window.__TEST_API_CONFIG = testApiConfig
  window.__TEST_OFFLINE_QUEUE = testOfflineQueue
}

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// Must resolve before first render: `RootLayout` reads `needsServerAddress()`
// synchronously at mount to decide whether to show the first-run "Server
// address" screen (#738), and that check depends on the persisted config
// having already been loaded from the Tauri Store.
await initApiBase()

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root not found — check index.html')
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <ConfigProvider>
        <ToastProvider>
          <AuthProvider>
            <NoteSheetProvider>
              <RouterProvider router={router} />
            </NoteSheetProvider>
          </AuthProvider>
        </ToastProvider>
      </ConfigProvider>
    </ThemeProvider>
  </StrictMode>,
)
