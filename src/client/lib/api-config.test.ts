import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({
  getConfiguredApiBase: vi.fn(async (): Promise<string | null> => null),
  persistApiBase: vi.fn(async (origin: string) => origin),
  clearConfiguredApiBase: vi.fn(async () => {}),
}))
vi.mock('./platform', async importOriginal => ({ ...(await importOriginal<typeof import('./platform')>()), ...platform }))

type ApiConfig = typeof import('./api-config')

/** Fresh module instance: `useTauri` and the cached base are module-level state. */
async function loadApiConfig(opts: { tauri: boolean }): Promise<ApiConfig> {
  vi.resetModules()
  const win = window as unknown as Record<string, unknown>
  if (opts.tauri) win.__TAURI_INTERNALS__ = {}
  else delete win.__TAURI_INTERNALS__
  return import('./api-config')
}

/** A shippable build: neither the Vite dev server nor the Playwright mock build. */
function releaseBuild() {
  vi.stubEnv('DEV', false)
  vi.stubEnv('PLAYWRIGHT_TEST', '')
}

describe('normalizeServerInput', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('release build (no dev flag)', () => {
    beforeEach(releaseBuild)

    it('infers https:// and reduces the address to its origin', async () => {
      const { normalizeServerInput } = await loadApiConfig({ tauri: false })
      expect(normalizeServerInput('app.example.org')).toBe('https://app.example.org')
      expect(normalizeServerInput('  https://App.Example.org/some/path/?q=1  ')).toBe('https://app.example.org')
      expect(normalizeServerInput('https://app.example.org:443')).toBe('https://app.example.org')
      expect(normalizeServerInput('app.example.org:8443')).toBe('https://app.example.org:8443')
    })

    it('gives private-range and loopback hosts no plain-http exception', async () => {
      const { normalizeServerInput } = await loadApiConfig({ tauri: false })
      expect(normalizeServerInput('192.168.1.10:8443')).toBe('https://192.168.1.10:8443')
      expect(normalizeServerInput('10.0.0.5')).toBe('https://10.0.0.5')
      expect(normalizeServerInput('localhost:3000')).toBe('https://localhost:3000')
    })

    it('rejects every non-https address, loopback included', async () => {
      const { normalizeServerInput, ServerAddressError } = await loadApiConfig({ tauri: false })
      for (const addr of [
        'http://app.example.org',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://[::1]:3000',
        'http://10.0.0.5',
        'ftp://app.example.org',
        'wss://app.example.org',
        'https://user:pw@app.example.org',
        '',
      ]) {
        expect(() => normalizeServerInput(addr), addr).toThrow(ServerAddressError)
      }
    })
  })

  describe('dev build (import.meta.env.DEV)', () => {
    beforeEach(() => {
      vi.stubEnv('DEV', true)
      vi.stubEnv('PLAYWRIGHT_TEST', '')
    })

    it('allows plain http:// to localhost, 127.0.0.1 and [::1] only', async () => {
      const { normalizeServerInput } = await loadApiConfig({ tauri: false })
      expect(normalizeServerInput('localhost:3000')).toBe('http://localhost:3000')
      expect(normalizeServerInput('127.0.0.1:1')).toBe('http://127.0.0.1:1')
      expect(normalizeServerInput('[::1]:3000')).toBe('http://[::1]:3000')
      expect(normalizeServerInput('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000')
      // Explicit https to loopback is still fine.
      expect(normalizeServerInput('https://localhost:3000')).toBe('https://localhost:3000')
    })

    it('still rejects plain http:// to anything that is not exactly loopback', async () => {
      const { normalizeServerInput, ServerAddressError } = await loadApiConfig({ tauri: false })
      for (const addr of [
        'http://10.0.0.5',
        'http://192.168.1.10',
        'http://127.0.0.2',
        'http://localhost.attacker.com',
        'http://app.example.org',
      ]) {
        expect(() => normalizeServerInput(addr), addr).toThrow(ServerAddressError)
      }
      expect(normalizeServerInput('192.168.1.10')).toBe('https://192.168.1.10')
    })
  })

  it('treats the Playwright mock build like a dev build', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('PLAYWRIGHT_TEST', 'true')
    const { normalizeServerInput } = await loadApiConfig({ tauri: false })
    expect(normalizeServerInput('127.0.0.1:4000')).toBe('http://127.0.0.1:4000')
  })
})

describe('setApiBase / initApiBase (Tauri)', () => {
  beforeEach(() => {
    releaseBuild()
    platform.getConfiguredApiBase.mockReset().mockResolvedValue(null)
    platform.persistApiBase.mockReset().mockImplementation(async (origin: string) => origin)
    platform.clearConfiguredApiBase.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('refuses an insecure address before anything is persisted', async () => {
    const api = await loadApiConfig({ tauri: true })
    await expect(api.setApiBase('http://app.example.org')).rejects.toBeInstanceOf(api.ServerAddressError)
    await expect(api.setApiBase('http://localhost:3000')).rejects.toBeInstanceOf(api.ServerAddressError)
    expect(platform.persistApiBase).not.toHaveBeenCalled()
    expect(api.getApiBase()).toBe('')
  })

  it('persists the canonical https origin through Rust and caches what Rust stored', async () => {
    platform.persistApiBase.mockResolvedValue('https://app.example.org')
    const api = await loadApiConfig({ tauri: true })
    await api.setApiBase('app.example.org/')
    expect(platform.persistApiBase).toHaveBeenCalledWith('https://app.example.org')
    expect(api.getApiBase()).toBe('https://app.example.org')
    expect(api.getApiUrl('/config')).toBe('https://app.example.org/api/config')
  })

  it('loads the configured origin at boot', async () => {
    platform.getConfiguredApiBase.mockResolvedValue('https://app.example.org')
    const api = await loadApiConfig({ tauri: true })
    await api.initApiBase()
    expect(api.getApiBase()).toBe('https://app.example.org')
    expect(api.deriveWsBase()).toBe('wss://app.example.org')
  })

  it('logs (does not swallow) a failure to load the configured origin', async () => {
    platform.getConfiguredApiBase.mockRejectedValue('IPC command rejected')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const api = await loadApiConfig({ tauri: true })
    await api.initApiBase()
    expect(api.getApiBase()).toBe('')
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[api-config]'), 'IPC command rejected')
    error.mockRestore()
  })

  it('resetApiBase clears the persisted address', async () => {
    const api = await loadApiConfig({ tauri: true })
    await api.setApiBase('https://app.example.org')
    await api.resetApiBase()
    expect(platform.clearConfiguredApiBase).toHaveBeenCalledTimes(1)
    expect(api.getApiBase()).toBe('')
  })
})
