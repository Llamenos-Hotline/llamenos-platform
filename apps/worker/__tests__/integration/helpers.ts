/**
 * Test helpers for Durable Object integration tests.
 *
 * Provides an in-memory DurableObjectState mock and a mock Env,
 * allowing direct instantiation and testing of DO classes without
 * the Cloudflare runtime (@cloudflare/vitest-pool-workers requires
 * vitest 2/3 and is not compatible with vitest 4).
 *
 * The storage mock implements the full DurableObjectStorage interface
 * subset that our DOs actually use (get, put, delete, list, deleteAll,
 * setAlarm, getAlarm).
 */
import type { Env } from '@worker/types'
import { ed25519AuthPubkey, hpkeRecipientPubkey } from '@worker/lib/hpke-recipient'

/** In-memory storage that mimics DurableObjectStorage. */
export class MockStorage {
  private data = new Map<string, unknown>()
  private alarm: number | null = null

  async get<T = unknown>(key: string): Promise<T | undefined>
  async get<T = unknown>(keys: string[]): Promise<Map<string, T>>
  async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(keyOrKeys)) {
      const result = new Map<string, T>()
      for (const key of keyOrKeys) {
        if (this.data.has(key)) {
          result.set(key, structuredClone(this.data.get(key)) as T)
        }
      }
      return result
    }
    const value = this.data.get(keyOrKeys)
    return value !== undefined ? structuredClone(value) as T : undefined
  }

  async put(key: string, value: unknown): Promise<void>
  async put(entries: Record<string, unknown>): Promise<void>
  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrEntries === 'string') {
      this.data.set(keyOrEntries, structuredClone(value))
    } else {
      for (const [k, v] of Object.entries(keyOrEntries)) {
        this.data.set(k, structuredClone(v))
      }
    }
  }

  async delete(key: string): Promise<boolean>
  async delete(keys: string[]): Promise<number>
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      let count = 0
      for (const key of keyOrKeys) {
        if (this.data.delete(key)) count++
      }
      return count
    }
    return this.data.delete(keyOrKeys)
  }

  async deleteAll(): Promise<void> {
    this.data.clear()
    this.alarm = null
  }

  async list<T = unknown>(options?: { prefix?: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>> {
    const result = new Map<string, T>()
    const prefix = options?.prefix || ''
    const entries = Array.from(this.data.entries())
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))

    if (options?.reverse) entries.reverse()

    const limited = options?.limit ? entries.slice(0, options.limit) : entries
    for (const [key, value] of limited) {
      result.set(key, structuredClone(value) as T)
    }
    return result
  }

  setAlarm(scheduledTime: number | Date): void {
    this.alarm = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime()
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm
  }
}

/** Create a mock DurableObjectState wrapping an in-memory storage. */
export function createMockState(): { storage: MockStorage } & Record<string, unknown> {
  return {
    storage: new MockStorage(),
    id: { toString: () => 'test-id', name: 'test' },
    waitUntil: () => {},
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  }
}

/** Create a mock Env with all required bindings. */
export function createMockEnv(overrides?: Partial<Env>): Env {
  const defaultEnv: Env = {
    AI: { run: async () => ({}) } as unknown as Env['AI'],
    BLOB_STORAGE: { put: async () => ({}), get: async () => null, delete: async () => {} } as unknown as Env['BLOB_STORAGE'],
    STORAGE_MANAGER: undefined,
    STORAGE_ADMIN: undefined,
    TWILIO_ACCOUNT_SID: 'AC-test',
    TWILIO_AUTH_TOKEN: 'test-auth-token',
    TWILIO_PHONE_NUMBER: '+15551234567',
    // The two admin keys are two different keys. This fixture previously set
    // only ADMIN_PUBKEY, commented "X25519 pubkey used for HPKE encryption" —
    // the exact conflation #1283 is about — and relied on the route falling
    // back to it as an HPKE recipient. Both are now supplied, under their own
    // branded types, from the test admin seed in tests/api-helpers.ts.
    ADMIN_PUBKEY: ed25519AuthPubkey('79215a4c04f08fcd817c6f820c87169beb8cddf96dfa590a1315556b78af9183')!,
    ADMIN_DECRYPTION_PUBKEY: hpkeRecipientPubkey('27f9c3be4b64aa793509386bc20da41a1ce70df8f360d574f20035a17726a177')!,
    HOTLINE_NAME: 'Test Hotline',
    ENVIRONMENT: 'test',
    // Valid 32-byte hex — needed by hashPhone() which calls hexToBytes(secret)
    HMAC_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    DEMO_MODE: 'false',
  }
  return { ...defaultEnv, ...overrides }
}

/**
 * Helper to construct a DO instance and provide a fetch wrapper.
 * Constructs the DO class with mock state and env, then returns
 * helpers for making requests against its internal routes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDOTestHarness<T extends { fetch(request: Request): Promise<Response> }, C = any>(
  DOClass: new (ctx: C, env: Env) => T,
  envOverrides?: Partial<Env>,
) {
  const state = createMockState()
  const env = createMockEnv(envOverrides)
  // The DurableObject constructor expects (DurableObjectState, Env).
  // Our mock state is structurally compatible.
  const instance = new DOClass(state as C, env)

  async function doFetch(path: string, options?: RequestInit): Promise<Response> {
    return instance.fetch(new Request(`http://do${path}`, options))
  }

  async function doJSON<R = unknown>(path: string, options?: RequestInit): Promise<R> {
    const res = await doFetch(path, options)
    return res.json() as Promise<R>
  }

  function postJSON(path: string, body: unknown): Promise<Response> {
    return doFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function patchJSON(path: string, body: unknown): Promise<Response> {
    return doFetch(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function putJSON(path: string, body: unknown): Promise<Response> {
    return doFetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  return { instance, state, env, doFetch, doJSON, postJSON, patchJSON, putJSON }
}
