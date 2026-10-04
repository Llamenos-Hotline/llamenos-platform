import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import path from 'path'
import { readFileSync } from 'fs'

// Test builds: mock Tauri IPC so Playwright can run in a regular browser
const isTestBuild = !!process.env.PLAYWRIGHT_TEST

// Build-time constants for reproducible builds (Epic 79)
// CI sets SOURCE_DATE_EPOCH from git commit timestamp; dev builds use current time
const buildTime = process.env.SOURCE_DATE_EPOCH
  ? new Date(parseInt(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
  : new Date().toISOString()
const buildCommit = process.env.GITHUB_SHA || 'dev'
const buildVersion = JSON.parse(readFileSync('./package.json', 'utf-8')).version

/**
 * Where the browser's /api and /ws calls are proxied.
 *
 * `API_URL` wins when set. Otherwise follow `TEST_HUB_URL`, which is how every
 * Playwright invocation already names its backend (ci.yml's `e2e` step, and
 * playwright.config.ts's bdd / backend-bdd projects, which set it as their own
 * `baseURL`). Only then fall back to :3000.
 *
 * Without the TEST_HUB_URL step the two halves of a run can target DIFFERENT
 * servers without saying so: the `bdd` projects follow TEST_HUB_URL while the
 * Playwright `request` fixture follows the preview server, whose proxy went to
 * :3000 regardless. In a checkout with several worktrees — the normal state of
 * this repo, where another backend usually holds :3000 — that silently points
 * a suite at the wrong backend. It is not a harmless mix-up: `bootstrap.spec.ts`
 * opens with `POST /api/test-reset-no-admin`, so the first thing the run does is
 * wipe whichever database it landed on. That happened, against a 4-day-old dev
 * server on the shared `llamenos` database.
 *
 * CI is unaffected: it sets TEST_HUB_URL=http://localhost:3000, which is where
 * this already pointed.
 */
function apiProxyTarget(): string {
  return process.env.API_URL || process.env.TEST_HUB_URL || 'http://localhost:3000'
}

function wsProxyTarget(): string {
  return apiProxyTarget().replace(/^http/, 'ws')
}

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/client/routes',
      generatedRouteTree: './src/client/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
  ],
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/client'),
      '@shared': path.resolve(__dirname, './packages/shared'),
      '@protocol': path.resolve(__dirname, './packages/protocol'),
      '@llamenos/i18n': path.resolve(__dirname, './packages/i18n/index.ts'),
      // Test builds: route Tauri IPC to JS mock implementations
      ...(isTestBuild ? {
        '@tauri-apps/api/core': path.resolve(__dirname, 'tests/mocks/tauri-core.ts'),
        '@tauri-apps/api/path': path.resolve(__dirname, 'tests/mocks/tauri-path.ts'),
        '@tauri-apps/plugin-stronghold': path.resolve(__dirname, 'tests/mocks/tauri-stronghold.ts'),
        '@tauri-apps/plugin-store': path.resolve(__dirname, 'tests/mocks/tauri-store.ts'),
        '@tauri-apps/plugin-updater': path.resolve(__dirname, 'tests/mocks/tauri-updater.ts'),
        '@tauri-apps/plugin-process': path.resolve(__dirname, 'tests/mocks/tauri-process.ts'),
        // Note: @tauri-apps/api/event is handled inline by platformListen in platform.ts
        // for PLAYWRIGHT_TEST builds — no separate mock file needed.
      } : {}),
    },
    conditions: ['import', 'module', 'default'],
  },
  define: {
    '__BUILD_TIME__': JSON.stringify(buildTime),
    '__BUILD_COMMIT__': JSON.stringify(buildCommit),
    '__BUILD_VERSION__': JSON.stringify(buildVersion),
    '__VERSION_FLOOR__': JSON.stringify(buildVersion),
    // Make PLAYWRIGHT_TEST available as import.meta.env.PLAYWRIGHT_TEST in the browser
    ...(isTestBuild ? { 'import.meta.env.PLAYWRIGHT_TEST': JSON.stringify('true') } : {}),
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'esnext',
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react-dom') || id.includes('@radix-ui')) return 'vendor-ui'
            if (id.includes('@noble/')) return 'vendor-crypto'
          }
        },
      },
    },
  },
  server: {
    host: process.env.TAURI_DEV_HOST || '0.0.0.0',
    strictPort: true,
    // Proxy API/WS to the backend. Needed for test builds (no Tauri at all),
    // standalone dev, and Tauri dev mode — in `tauri:dev` the webview loads from
    // the Vite dev server (devUrl), so it's a browser and must proxy /api and /ws.
    // Only skip in Tauri production builds (frontendDist bundled, no dev server).
    ...(isTestBuild || !process.env.TAURI_ENV_PLATFORM || process.env.TAURI_ENV_DEBUG ? {
      proxy: {
        '/api': {
          target: apiProxyTarget(),
          changeOrigin: true,
        },
        '/ws': {
          target: wsProxyTarget(),
          ws: true,
          configure: (proxy) => {
            proxy.on('error', (err: Error) => {
              if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return
              console.error('[vite:ws-proxy]', err.message)
            })
          },
        },
      },
    } : {}),
  },
  // Preview proxy (for `vite preview` used by Playwright tests)
  preview: {
    proxy: {
      '/api': {
        target: apiProxyTarget(),
        changeOrigin: true,
      },
      '/ws': {
        target: wsProxyTarget(),
        ws: true,
        configure: (proxy) => {
          proxy.on('error', (err: Error) => {
            if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return
            console.error('[vite:ws-proxy]', err.message)
          })
        },
      },
    },
  },
})
