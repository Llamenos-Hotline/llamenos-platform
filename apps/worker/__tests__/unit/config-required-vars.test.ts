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
import { validateConfig as validateConfigWithFiles } from '@worker/lib/config'
import { secretFiles, TEST_BAN_HASH_KEY, TEST_MESSAGING_HASH_KEY } from '../helpers/secret-files'

const validateConfig = (env: Parameters<typeof validateConfigWithFiles>[0]) =>
  validateConfigWithFiles(env, secretFiles())

const HEX64 = 'a'.repeat(64)

/** A deployment that should boot: every required var, nothing optional. */
function completeEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://user:pw@localhost:5432/llamenos',
    // Three roles, three values: validateConfig refuses a repeated one.
    HMAC_SECRET: HEX64,
    SERVER_SECRET: 'b'.repeat(64),
    SERVER_KEK: 'c'.repeat(64),
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
  'SERVER_KEK',
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

describe('validateConfig: one role per secret (D6, #2171)', () => {
  it.each([
    ['HMAC_SECRET', 'SERVER_SECRET'],
    ['HMAC_SECRET', 'SERVER_KEK'],
    ['SERVER_SECRET', 'SERVER_KEK'],
  ] as const)('refuses %s and %s sharing a value', (a, b) => {
    const env = completeEnv()
    env[b] = env[a]!
    expect(() => validateConfig(env)).toThrow(/identical/)
  })

  it.each(['HMAC_SECRET', 'SERVER_SECRET', 'SERVER_KEK'] as const)(
    'refuses the ban-hash-key file sharing a value with %s',
    (key) => {
      const env = completeEnv()
      env[key] = TEST_BAN_HASH_KEY
      expect(() => validateConfig(env)).toThrow(/ban-hash-key.*identical|identical/)
    },
  )

  it.each(['HMAC_SECRET', 'SERVER_SECRET', 'SERVER_KEK'] as const)(
    'refuses the messaging-hash-key file sharing a value with %s',
    (key) => {
      const env = completeEnv()
      env[key] = TEST_MESSAGING_HASH_KEY
      expect(() => validateConfig(env)).toThrow(/messaging-hash-key.*identical|identical/)
    },
  )

  it('refuses the ban-hash-key and messaging-hash-key files sharing a value', () => {
    expect(() => validateConfigWithFiles(
      completeEnv(),
      secretFiles({ 'ban-hash-key': TEST_BAN_HASH_KEY, 'messaging-hash-key': TEST_BAN_HASH_KEY }),
    )).toThrow(/ban-hash-key and messaging-hash-key are identical/)
  })

  it('refuses SERVER_KEK that is not 64 lowercase hex characters', () => {
    expect(() => validateConfig({ ...completeEnv(), SERVER_KEK: 'c'.repeat(32) })).toThrow(/SERVER_KEK/)
    expect(() => validateConfig({ ...completeEnv(), SERVER_KEK: 'Z'.repeat(64) })).toThrow(/SERVER_KEK/)
  })
})

describe('validateConfig: MESSAGING_HASH_KEY is a secret file, never an env var', () => {
  it('refuses to start without the messaging-hash-key file, and names it', () => {
    expect(() => validateConfigWithFiles(completeEnv(), secretFiles({ 'ban-hash-key': TEST_BAN_HASH_KEY })))
      .toThrow(/messaging-hash-key/)
  })

  it('refuses an empty or malformed messaging-hash-key file', () => {
    const files = (v: string) => secretFiles({ 'ban-hash-key': TEST_BAN_HASH_KEY, 'messaging-hash-key': v })
    expect(() => validateConfigWithFiles(completeEnv(), files(''))).toThrow(/messaging-hash-key/)
    expect(() => validateConfigWithFiles(completeEnv(), files('abc'))).toThrow(/messaging-hash-key must be exactly 64 lowercase hex/)
  })

  it('refuses MESSAGING_HASH_KEY supplied as an environment variable, even alongside a valid file', () => {
    const env = { ...completeEnv(), MESSAGING_HASH_KEY: TEST_MESSAGING_HASH_KEY }
    expect(() => validateConfig(env)).toThrow(/MESSAGING_HASH_KEY must not be set as an environment variable/)
  })
})

describe('validateConfig: BAN_HASH_KEY is a secret file, never an env var', () => {
  it('refuses to start without the ban-hash-key file, and names it', () => {
    expect(() => validateConfigWithFiles(completeEnv(), secretFiles({}))).toThrow(/ban-hash-key/)
  })

  it('refuses an empty or malformed ban-hash-key file', () => {
    expect(() => validateConfigWithFiles(completeEnv(), secretFiles({ 'ban-hash-key': '' }))).toThrow(/ban-hash-key/)
    expect(() => validateConfigWithFiles(completeEnv(), secretFiles({ 'ban-hash-key': 'abc' }))).toThrow(/64 lowercase hex/)
  })

  it('refuses BAN_HASH_KEY supplied as an environment variable, even alongside a valid file', () => {
    const env = { ...completeEnv(), BAN_HASH_KEY: 'f'.repeat(64) }
    expect(() => validateConfig(env)).toThrow(/must not be set as an environment variable/)
  })
})
