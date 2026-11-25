/**
 * The webhook IP allowlist must never be silently absent (#1622).
 *
 * The middleware returns next() when `<PROVIDER>_WEBHOOK_IPS` is unset, so an
 * unconfigured allowlist and a passed one look identical at request time. The
 * only place the difference can be made observable is startup, which is what
 * `validateConfig` does: in production the operator must either configure an
 * allowlist or write `WEBHOOK_IP_ALLOWLIST=disabled`.
 *
 * These tests call the REAL validator and the REAL middleware -- the
 * "allowlist configured" half of the verification (listed address accepted,
 * unlisted refused, spoofed X-Forwarded-For refused) is only worth anything
 * if it runs against the middleware that is actually mounted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { validateConfig as validateConfigWithFiles } from '@worker/lib/config'
import { webhookIpAllowlist } from '@worker/middleware/webhook-ip-allowlist'
import { secretFiles } from '../helpers/secret-files'

const validateConfig = (env: Parameters<typeof validateConfigWithFiles>[0]) =>
  validateConfigWithFiles(env, secretFiles())

function productionEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://llamenos:dev@localhost:5432/llamenos',
    HMAC_SECRET: 'a'.repeat(64),
    SERVER_SECRET: 'b'.repeat(64),
    SERVER_KEK: 'c'.repeat(64),
    HOTLINE_NAME: 'Test Hotline',
    ENVIRONMENT: 'production',
    STORAGE_ACCESS_KEY: 'rustfsadmin',
    STORAGE_SECRET_KEY: 'rustfsadmin',
    WEBHOOK_BASE_URL: 'https://hotline.example.org',
    ...extra,
  }
}

describe('validateConfig: the webhook allowlist posture is explicit in production', () => {
  it('refuses to boot when no allowlist is configured and none was disabled on purpose', () => {
    expect(() => validateConfig(productionEnv())).toThrow(/No <PROVIDER>_WEBHOOK_IPS is configured in production/)
  })

  it('names the opt-out in the refusal, so the operator can act on it', () => {
    expect(() => validateConfig(productionEnv())).toThrow(/WEBHOOK_IP_ALLOWLIST=disabled/)
  })

  it('treats a blank allowlist as unset', () => {
    expect(() => validateConfig(productionEnv({ TELEPHONY_WEBHOOK_IPS: '   ' }))).toThrow(/No <PROVIDER>_WEBHOOK_IPS/)
  })

  it('boots with an allowlist configured for any provider', () => {
    expect(() => validateConfig(productionEnv({ TELEPHONY_WEBHOOK_IPS: '203.0.113.0/24' }))).not.toThrow()
    expect(() => validateConfig(productionEnv({ MESSAGING_WEBHOOK_IPS: '198.51.100.0/24' }))).not.toThrow()
  })

  it('boots with the explicit opt-out', () => {
    expect(() => validateConfig(productionEnv({ WEBHOOK_IP_ALLOWLIST: 'disabled' }))).not.toThrow()
  })

  it('refuses a value that is not the opt-out, rather than reading a typo as "off"', () => {
    for (const value of ['disable', 'false', '0', 'off', 'DISABLED-ish']) {
      expect(() => validateConfig(productionEnv({ WEBHOOK_IP_ALLOWLIST: value })), value)
        .toThrow(/not a recognised value/)
    }
  })

  it('refuses an allowlist that is both configured and disabled', () => {
    expect(() =>
      validateConfig(productionEnv({ WEBHOOK_IP_ALLOWLIST: 'disabled', TELEPHONY_WEBHOOK_IPS: '203.0.113.0/24' })),
    ).toThrow(/contradicts TELEPHONY_WEBHOOK_IPS/)
  })

  it('refuses the contradiction outside production too: the operator meant one of them', () => {
    expect(() =>
      validateConfig(productionEnv({
        ENVIRONMENT: 'staging',
        WEBHOOK_IP_ALLOWLIST: 'disabled',
        TELEPHONY_WEBHOOK_IPS: '203.0.113.0/24',
      })),
    ).toThrow(/contradicts/)
  })

  it('still boots a non-production host with no allowlist (warns, does not refuse)', () => {
    expect(() => validateConfig(productionEnv({ ENVIRONMENT: 'staging' }))).not.toThrow()
    expect(() => validateConfig(productionEnv({ ENVIRONMENT: 'development' }))).not.toThrow()
  })
})

describe('webhookIpAllowlist: with the control on (case 1, 2 and 4 of #1622)', () => {
  let savedTrust: string | undefined
  beforeEach(() => {
    savedTrust = process.env.TRUST_PROXY_HEADERS
    // Deployed hosts run behind Caddy, which SETS X-Forwarded-For to the
    // peer's address (caddy.j2) and the worker reads the right-most entry.
    process.env.TRUST_PROXY_HEADERS = 'true'
  })
  afterEach(() => {
    if (savedTrust === undefined) delete process.env.TRUST_PROXY_HEADERS
    else process.env.TRUST_PROXY_HEADERS = savedTrust
  })

  function call(env: Record<string, string>, xff: string): Promise<Response> {
    const app = new Hono()
    app.use('*', webhookIpAllowlist('telephony'))
    app.post('/hook', (c) => c.text('accepted'))
    return Promise.resolve(app.request('/hook', { method: 'POST', headers: { 'X-Forwarded-For': xff } }, env))
  }

  const allowlisted = { TELEPHONY_WEBHOOK_IPS: '203.0.113.0/24' }

  it('accepts a request from a listed address', async () => {
    const res = await call(allowlisted, '203.0.113.7')
    expect(res.status).toBe(200)
  })

  it('refuses a request from an unlisted address', async () => {
    const res = await call(allowlisted, '192.0.2.50')
    expect(res.status).toBe(403)
  })

  it('refuses an unlisted peer that spoofs a listed address at the left of X-Forwarded-For (#1609)', async () => {
    // What reaches the worker when a client sends its own header and the proxy
    // appends the peer: the listed address is the client's claim, the right-most
    // entry is the address the proxy saw.
    const res = await call(allowlisted, '203.0.113.7, 192.0.2.50')
    expect(res.status).toBe(403)
  })

  it('with the allowlist unset, passes everything -- which is why startup must say so (case 3)', async () => {
    const res = await call({}, '192.0.2.50')
    expect(res.status).toBe(200)
  })
})
