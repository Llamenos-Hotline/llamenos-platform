/**
 * Guards the desktop IPC trust boundary across the three files that must agree
 * for a Tauri command to actually work in a packaged build:
 *
 *   1. `apps/desktop/src/lib.rs` — `tauri::generate_handler![...]` registers the
 *      command on the Rust side.
 *   2. `apps/desktop/isolation/index.html` — `ALLOWED_COMMANDS` is the isolation
 *      pattern's allowlist. Anything the webview invokes that is NOT listed there
 *      is rejected before it ever reaches Rust — but ONLY in a packaged build
 *      (`tauri:dev` and the Playwright IPC mock both bypass the isolation iframe),
 *      so a missing entry passes every local and E2E test and breaks in the
 *      shipped app. PR #772 shipped five `net_*` commands that way.
 *   3. `src/client/lib/platform.ts` — the single module allowed to invoke IPC.
 *
 * These are static reads of the real source files, not a mock: the property
 * under test ("the three lists agree") lives in the files themselves.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')

/** App (non-plugin) commands from the isolation allowlist. */
function isolationAllowedCommands(): { app: Set<string>; plugin: Set<string> } {
  const html = read('apps/desktop/isolation/index.html')
  const match = html.match(/const ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\)/)
  if (!match) throw new Error('ALLOWED_COMMANDS not found in apps/desktop/isolation/index.html')
  const body = match[1].replace(/\/\/.*$/gm, '')
  const all = [...body.matchAll(/'([^']+)'/g)].map(m => m[1])
  expect(all.length).toBeGreaterThan(0)
  return {
    app: new Set(all.filter(c => !c.startsWith('plugin:'))),
    plugin: new Set(all.filter(c => c.startsWith('plugin:'))),
  }
}

/** Commands registered in `tauri::generate_handler![...]`, path prefix stripped. */
function registeredCommands(): Set<string> {
  const rs = read('apps/desktop/src/lib.rs')
  const match = rs.match(/generate_handler!\[([\s\S]*?)\]/)
  if (!match) throw new Error('generate_handler![...] not found in apps/desktop/src/lib.rs')
  const body = match[1].replace(/\/\/.*$/gm, '')
  const names = body
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.split('::').pop() as string)
  expect(names.length).toBeGreaterThan(0)
  for (const n of names) expect(n).toMatch(/^[a-z0-9_]+$/)
  return new Set(names)
}

/** App commands the frontend invokes (all IPC goes through platform.ts's `tauriInvoke`). */
function invokedCommands(): Set<string> {
  const src = read('src/client/lib/platform.ts')
  const names = [...src.matchAll(/tauriInvoke(?:<[\s\S]*?>)?\(\s*'([a-z0-9_]+)'/g)].map(m => m[1])
  expect(names.length).toBeGreaterThan(0)
  return new Set(names)
}

/**
 * Run the REAL isolation script (the `<script>` body of isolation/index.html) in a
 * VM and return the hook the Tauri isolation iframe would call. The payload shape
 * mirrors what the webview sends: `{cmd, callback, error, payload: <args>}`.
 */
function loadIsolationHook(): (payload: unknown) => unknown {
  const html = read('apps/desktop/isolation/index.html')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('no <script> in apps/desktop/isolation/index.html')
  const sandbox: { window: { __TAURI_ISOLATION_HOOK__?: (p: unknown) => unknown } } = { window: {} }
  vm.runInNewContext(script, sandbox)
  const hook = sandbox.window.__TAURI_ISOLATION_HOOK__
  if (!hook) throw new Error('isolation script did not install __TAURI_ISOLATION_HOOK__')
  return hook
}

/** Event names the frontend subscribes to via `listen(...)` from `@tauri-apps/api/event`. */
function listenedEventNames(): string[] {
  const src = read('src/client/lib/platform.ts')
  const fixed = [...src.matchAll(/platformListen\(\s*'([^']+)'/g)].map(m => m[1])
  const updater = read('src/client/lib/updater.ts')
  const fromUpdater = [...updater.matchAll(/platformListen\(\s*'([^']+)'/g)].map(m => m[1])
  return [...new Set([...fixed, ...fromUpdater])]
}

function sorted(s: Set<string>): string[] {
  return [...s].sort()
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

describe('desktop IPC boundary', () => {
  it('isolation ALLOWED_COMMANDS and generate_handler! register exactly the same app commands', () => {
    const allowed = isolationAllowedCommands().app
    const registered = registeredCommands()
    const allowedNotRegistered = sorted(allowed).filter(c => !registered.has(c))
    const registeredNotAllowed = sorted(registered).filter(c => !allowed.has(c))
    expect({ allowedNotRegistered, registeredNotAllowed }).toEqual({
      allowedNotRegistered: [],
      registeredNotAllowed: [],
    })
  })

  it('every command the frontend invokes is registered (and therefore allowlisted)', () => {
    const registered = registeredCommands()
    const missing = sorted(invokedCommands()).filter(c => !registered.has(c))
    expect(missing).toEqual([])
  })

  it('the net proxy and backend-address commands are allowlisted for packaged builds', () => {
    const allowed = isolationAllowedCommands().app
    for (const cmd of [
      'net_fetch',
      'net_probe_health',
      'net_ws_connect',
      'net_ws_send',
      'net_ws_close',
      'api_config_get',
      'api_config_set',
      'api_config_request_clear',
      'api_config_clear',
    ]) {
      expect(allowed.has(cmd), `${cmd} missing from ALLOWED_COMMANDS`).toBe(true)
    }
  })

  it('no module other than platform.ts touches the Tauri IPC/event API at runtime', () => {
    const offenders = listSourceFiles(path.join(ROOT, 'src/client'))
      .filter(f => !f.endsWith(path.join('lib', 'platform.ts')))
      .filter(f => /import\(\s*'@tauri-apps\/api\/(core|event)'\s*\)|from\s+'@tauri-apps\/api\/(core|event)'/.test(readFileSync(f, 'utf8')))
      .map(f => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })

  it('the isolation hook lets the relay subscribe to its net-ws channel (#2107)', async () => {
    const hook = loadIsolationHook()
    const channel = `net-ws:${'0b6f3c1e-8a52-4d0e-9f41-0c2d7a9e5b13'}`
    for (const cmd of ['plugin:event|listen', 'plugin:event|unlisten']) {
      const msg = { cmd, callback: 1, error: 2, payload: { event: channel } }
      await expect(Promise.resolve(hook(msg))).resolves.toBe(msg)
    }
  })

  it('the isolation hook lets every event the frontend listens for through', async () => {
    const hook = loadIsolationHook()
    const events = listenedEventNames()
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      const msg = { cmd: 'plugin:event|listen', callback: 1, error: 2, payload: { event } }
      await expect(Promise.resolve(hook(msg)), `listen('${event}') blocked`).resolves.toBe(msg)
    }
  })

  it('the isolation hook still refuses arbitrary event subscriptions and any emit', async () => {
    const hook = loadIsolationHook()
    const blocked = [
      { cmd: 'plugin:event|listen', payload: { event: 'tauri://window-created' } },
      { cmd: 'plugin:event|listen', payload: { event: 'net-ws:' } },
      { cmd: 'plugin:event|listen', payload: { event: 'net-ws:x y' } },
      { cmd: 'plugin:event|listen', payload: { event: 'xnet-ws:abc' } },
      { cmd: 'plugin:event|listen', payload: {} },
      { cmd: 'plugin:event|unlisten', payload: { event: 'anything', eventId: 1 } },
      { cmd: 'plugin:event|emit', payload: { event: 'net-ws:abc' } },
      { cmd: 'plugin:event|emit_to', payload: { event: 'net-ws:abc' } },
    ]
    for (const m of blocked) {
      await expect(Promise.resolve(hook({ callback: 1, error: 2, ...m })), JSON.stringify(m)).rejects.toThrow(/isolation policy/)
    }
  })

  it('backend address persistence needs no store plugin capability', () => {
    // `apps/desktop/capabilities/default.json` grants no `store:*` permission, and
    // tauri-plugin-store 2.x has no per-file scope to grant one narrowly. The
    // backend address is therefore persisted by the Rust `api_config_*` commands
    // (fixed file, validated value) — the webview must never reach for the store
    // plugin to read or write it, or the first-run screen is dead in a packaged build.
    const apiConfig = read('src/client/lib/api-config.ts')
    const net = read('src/client/lib/net.ts')
    expect(apiConfig).not.toMatch(/@tauri-apps\/plugin-store/)
    expect(net).not.toMatch(/@tauri-apps\/plugin-store/)

    const capabilities = JSON.parse(read('apps/desktop/capabilities/default.json')) as { permissions: unknown[] }
    const storeGrants = capabilities.permissions.filter(p => typeof p === 'string' ? p.startsWith('store:') : JSON.stringify(p).includes('"store:'))
    expect(storeGrants).toEqual([])
  })
})
