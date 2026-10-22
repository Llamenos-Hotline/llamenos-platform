/**
 * Signal contact registration — the zero-knowledge boundary and its atomicity.
 *
 * Commit 4b099de2e removed the app-server route that accepted a plaintext Signal
 * identifier, so that the app server could never read one. Nothing guarded that
 * property on the client: the old client still tried to send plaintext there, and
 * only the missing route stopped it. These tests record every request the client
 * makes and assert, over the whole flow:
 *
 *  1. the plaintext identifier never appears in anything sent to the app server;
 *  2. it goes to the sidecar, with the sidecar token and without the app's
 *     session credentials;
 *  3. registration is all-or-nothing — a failed sidecar step deletes the stored
 *     hash again, and a failed rollback is reported as such.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerSignalContactEverywhere } from './signal'
import { ApiError } from './client'

const PLAINTEXT = '+15550001234'
const SIDECAR = 'https://notifier.example.test'
const APP_ORIGIN = ''

const CONTACT = {
  identifierHash: 'a'.repeat(64),
  identifierCiphertext: 'ciphertext-not-the-plaintext',
  identifierEnvelope: [{ recipientPubkey: 'b'.repeat(64), encryptedKey: 'wrapped-key' }],
  identifierType: 'phone' as const,
}

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

let sent: Recorded[]
let sidecarStatus: number
let deleteStatus: number

/**
 * True when the request targets the sidecar's origin. Compares parsed origins, not a
 * string prefix: a prefix match would also accept `https://notifier.example.test.evil`,
 * which would let a request to a look-alike host be counted as "the sidecar" and so
 * excluded from the app-server assertions. App-server URLs are relative, hence the base.
 */
function isSidecarUrl(url: string): boolean {
  return new URL(url, 'http://app.invalid').origin === new URL(SIDECAR).origin
}

function appRequests(): Recorded[] {
  return sent.filter((r) => !isSidecarUrl(r.url))
}

function sidecarRequests(): Recorded[] {
  return sent.filter((r) => isSidecarUrl(r.url))
}

beforeEach(() => {
  sent = []
  sidecarStatus = 200
  deleteStatus = 204
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = String(input)
      sent.push({
        url,
        method: (init.method ?? 'GET').toUpperCase(),
        headers: Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
        ),
        body: typeof init.body === 'string' ? init.body : '',
      })
      if (isSidecarUrl(url)) {
        return new Response(sidecarStatus === 200 ? '{"ok":true}' : '{"error":"nope"}', { status: sidecarStatus })
      }
      if (url.endsWith('/signal-notification/contact/sidecar-token')) {
        return new Response(JSON.stringify({ token: 'sidecar-token', sidecarUrl: SIDECAR }), { status: 200 })
      }
      if ((init.method ?? 'GET') === 'DELETE') return new Response(null, { status: deleteStatus })
      return new Response('{"ok":true}', { status: 200 })
    }),
  )
  // Give request() a session credential so a leak onto the sidecar would be visible.
  sessionStorage.setItem('llamenos-session-token', 'app-session-secret')
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('registerSignalContactEverywhere', () => {
  it('never sends the plaintext identifier to the app server', async () => {
    await registerSignalContactEverywhere(CONTACT, PLAINTEXT)

    const toApp = appRequests()
    expect(toApp.length).toBeGreaterThan(0)
    for (const r of toApp) {
      expect(r.url).not.toContain(PLAINTEXT)
      expect(r.url).not.toContain(encodeURIComponent(PLAINTEXT))
      expect(r.body).not.toContain(PLAINTEXT)
      expect(r.body).not.toContain('plaintextIdentifier')
    }
  })

  it('stores the hash, then registers the plaintext with the sidecar using the token', async () => {
    await registerSignalContactEverywhere(CONTACT, PLAINTEXT)

    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      `PUT ${APP_ORIGIN}/api/signal-notification/contact`,
      `POST ${APP_ORIGIN}/api/signal-notification/contact/sidecar-token`,
      `POST ${SIDECAR}/api/register-client`,
    ])
    expect(JSON.parse(sidecarRequests()[0].body)).toEqual({
      token: 'sidecar-token',
      plaintextIdentifier: PLAINTEXT,
      identifierType: 'phone',
    })
  })

  it('does not forward the app session credentials to the sidecar', async () => {
    await registerSignalContactEverywhere(CONTACT, PLAINTEXT)

    expect(appRequests()[0].headers.authorization).toBe('Session app-session-secret')
    for (const r of sidecarRequests()) {
      expect(r.headers).not.toHaveProperty('authorization')
      expect(r.headers).not.toHaveProperty('x-api-version')
    }
  })

  it('rolls the stored hash back when the sidecar refuses the registration', async () => {
    sidecarStatus = 401

    await expect(registerSignalContactEverywhere(CONTACT, PLAINTEXT)).rejects.toBeInstanceOf(ApiError)

    const last = sent[sent.length - 1]
    expect(`${last.method} ${last.url}`).toBe(`DELETE ${APP_ORIGIN}/api/signal-notification/contact`)
    // And the rollback still keeps the plaintext off the app server.
    for (const r of appRequests()) expect(r.body).not.toContain(PLAINTEXT)
  })

  it('rolls back when the sidecar cannot be reached at all', async () => {
    const fetchMock = vi.mocked(fetch)
    const base = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      if (isSidecarUrl(String(input))) throw new TypeError('refused: not the configured origin')
      return base(input, init)
    })

    await expect(registerSignalContactEverywhere(CONTACT, PLAINTEXT)).rejects.toBeInstanceOf(TypeError)

    expect(sent.filter((r) => r.method === 'DELETE')).toHaveLength(1)
  })

  it('does not contact the sidecar, or roll anything back, when storing the hash fails', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementationOnce(async () => new Response('{"error":"bad"}', { status: 400 }))

    await expect(registerSignalContactEverywhere(CONTACT, PLAINTEXT)).rejects.toBeInstanceOf(ApiError)

    expect(sidecarRequests()).toHaveLength(0)
    expect(sent.filter((r) => r.method === 'DELETE')).toHaveLength(0)
  })

  it('reports a failed rollback instead of masquerading as a clean failure', async () => {
    sidecarStatus = 500
    deleteStatus = 500

    const failure = await registerSignalContactEverywhere(CONTACT, PLAINTEXT).catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/could not be rolled back/)
    expect((failure as Error).cause).toBeInstanceOf(AggregateError)
  })
})
