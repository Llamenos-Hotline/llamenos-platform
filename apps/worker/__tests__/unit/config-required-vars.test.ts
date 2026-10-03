/**
 * `validateConfig` is the single place that declares what a deployment must
 * supply, and it is the only one that produces an operator-facing message:
 *
 *     [llamenos] Required environment variable X is missing or empty.
 *     Set it before starting the server.
 *
 * Its list drifting from what the server actually needs to boot is #1438:
 * STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY were required by
 * `createBlobStorage()` — called unconditionally from `src/server/index.ts` —
 * and absent here, so a deployment missing them passed validation, ran its
 * migrations, seeded its admin, and only then died on a raw stack trace from
 * a factory.
 *
 * This rail calls the REAL function with a real env object rather than
 * reimplementing the rule, because a test that re-states the logic cannot
 * catch the logic being wrong.
 */
import { describe, it, expect } from 'vitest'
import { validateConfig } from '@worker/lib/config'

const HEX64 = 'a'.repeat(64)

/** A deployment that should boot: every required var, nothing optional. */
function completeEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://user:pw@localhost:5432/llamenos',
    HMAC_SECRET: HEX64,
    SERVER_SECRET: HEX64,
    HOTLINE_NAME: 'Test Hotline',
    ENVIRONMENT: 'staging',
    STORAGE_ACCESS_KEY: 'rustfsadmin',
    STORAGE_SECRET_KEY: 'rustfsadmin',
  }
}

/** Everything the server cannot start without. */
const REQUIRED = [
  'DATABASE_URL',
  'HMAC_SECRET',
  'SERVER_SECRET',
  'HOTLINE_NAME',
  'ENVIRONMENT',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
] as const

describe('validateConfig: the required-variable list', () => {
  it('accepts a complete deployment env', () => {
    expect(() => validateConfig(completeEnv())).not.toThrow()
  })

  it.each(REQUIRED)('refuses to start without %s, and names it', (key) => {
    const env = completeEnv()
    delete env[key]
    // The name must appear in the message: an operator reading a boot failure
    // needs to know WHICH variable, and "[llamenos] Required environment
    // variable …" is the form every other required var already uses.
    expect(() => validateConfig(env)).toThrow(new RegExp(key))
  })

  it.each(REQUIRED)('treats an empty or whitespace-only %s as missing', (key) => {
    for (const blank of ['', '   ']) {
      const env = completeEnv()
      env[key] = blank
      expect(() => validateConfig(env), `${key}=${JSON.stringify(blank)} was accepted`).toThrow()
    }
  })

  it('leaves STORAGE_ENDPOINT optional — createBlobStorage defaults it', () => {
    const env = completeEnv()
    delete env['STORAGE_ENDPOINT']
    expect(() => validateConfig(env)).not.toThrow()
  })

  it('leaves ADMIN_PUBKEY optional, but rejects a malformed one', () => {
    const ok = completeEnv()
    expect(() => validateConfig(ok)).not.toThrow()
    const bad = { ...completeEnv(), ADMIN_PUBKEY: 'not-a-pubkey' }
    expect(() => validateConfig(bad)).toThrow(/ADMIN_PUBKEY/)
  })
})
