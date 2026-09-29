import { describe, it, expect } from 'vitest'
import { validateConfig } from './config'

describe('validateConfig', () => {
  const validEnv = {
    DATABASE_URL: 'postgresql://llamenos:dev@localhost:5432/llamenos',
    HMAC_SECRET: 'a'.repeat(64),
    SERVER_SECRET: 'b'.repeat(64),
    ADMIN_PUBKEY: 'c'.repeat(64),
    ADMIN_DECRYPTION_PUBKEY: 'd'.repeat(64),
    HOTLINE_NAME: 'Test Hotline',
    ENVIRONMENT: 'test',
  }

  it('passes with all required vars present', () => {
    expect(() => validateConfig(validEnv)).not.toThrow()
  })

  it('throws if DATABASE_URL is missing', () => {
    expect(() => validateConfig({ ...validEnv, DATABASE_URL: '' })).toThrow(/DATABASE_URL/)
  })

  it('throws if DATABASE_URL is whitespace only', () => {
    expect(() => validateConfig({ ...validEnv, DATABASE_URL: '   ' })).toThrow(/DATABASE_URL/)
  })

  it('throws if DATABASE_URL does not start with postgres', () => {
    expect(() => validateConfig({ ...validEnv, DATABASE_URL: 'mysql://bad' })).toThrow(/DATABASE_URL/)
  })

  it('throws if HMAC_SECRET is missing', () => {
    expect(() => validateConfig({ ...validEnv, HMAC_SECRET: '' })).toThrow(/HMAC_SECRET/)
  })

  it('throws if HMAC_SECRET is whitespace only', () => {
    expect(() => validateConfig({ ...validEnv, HMAC_SECRET: '   ' })).toThrow(/HMAC_SECRET/)
  })

  it('throws if HMAC_SECRET is wrong length (32 chars)', () => {
    expect(() => validateConfig({ ...validEnv, HMAC_SECRET: 'a'.repeat(32) })).toThrow(/HMAC_SECRET/)
  })

  it('throws if HMAC_SECRET contains non-hex chars', () => {
    expect(() => validateConfig({ ...validEnv, HMAC_SECRET: 'z'.repeat(64) })).toThrow(/HMAC_SECRET/)
  })

  it('throws if SERVER_SECRET is missing', () => {
    expect(() => validateConfig({ ...validEnv, SERVER_SECRET: '' })).toThrow(/SERVER_SECRET/)
  })

  it('throws if SERVER_SECRET is wrong length', () => {
    expect(() => validateConfig({ ...validEnv, SERVER_SECRET: 'a'.repeat(63) })).toThrow(/SERVER_SECRET/)
  })

  it('warns if ADMIN_PUBKEY is missing but does not throw', () => {
    expect(() => validateConfig({ ...validEnv, ADMIN_PUBKEY: '' })).not.toThrow()
  })

  // #1283 — the server used to boot happily with ADMIN_DECRYPTION_PUBKEY unset and
  // silently alias the Ed25519 ADMIN_PUBKEY as the HPKE recipient for every admin
  // envelope, producing ciphertext nobody could decrypt. It must fail closed instead.
  describe('ADMIN_DECRYPTION_PUBKEY (#1283)', () => {
    it('throws when ADMIN_PUBKEY is set but ADMIN_DECRYPTION_PUBKEY is not', () => {
      expect(() => validateConfig({ ...validEnv, ADMIN_DECRYPTION_PUBKEY: '' }))
        .toThrow(/ADMIN_DECRYPTION_PUBKEY/)
    })

    it('throws when ADMIN_DECRYPTION_PUBKEY is whitespace only', () => {
      expect(() => validateConfig({ ...validEnv, ADMIN_DECRYPTION_PUBKEY: '   ' }))
        .toThrow(/ADMIN_DECRYPTION_PUBKEY/)
    })

    it('throws when ADMIN_DECRYPTION_PUBKEY equals ADMIN_PUBKEY', () => {
      expect(() => validateConfig({ ...validEnv, ADMIN_DECRYPTION_PUBKEY: validEnv.ADMIN_PUBKEY }))
        .toThrow(/must not equal ADMIN_PUBKEY/)
    })

    it('throws when ADMIN_DECRYPTION_PUBKEY is not 64 hex chars', () => {
      expect(() => validateConfig({ ...validEnv, ADMIN_DECRYPTION_PUBKEY: 'd'.repeat(32) }))
        .toThrow(/ADMIN_DECRYPTION_PUBKEY/)
      expect(() => validateConfig({ ...validEnv, ADMIN_DECRYPTION_PUBKEY: 'z'.repeat(64) }))
        .toThrow(/ADMIN_DECRYPTION_PUBKEY/)
    })

    it('does not require it when no admin identity is configured at all', () => {
      expect(() => validateConfig({ ...validEnv, ADMIN_PUBKEY: '', ADMIN_DECRYPTION_PUBKEY: '' }))
        .not.toThrow()
    })

    it('still validates its format when set without ADMIN_PUBKEY', () => {
      expect(() => validateConfig({ ...validEnv, ADMIN_PUBKEY: '', ADMIN_DECRYPTION_PUBKEY: 'nope' }))
        .toThrow(/ADMIN_DECRYPTION_PUBKEY/)
    })
  })

  it('throws if ADMIN_PUBKEY is wrong length', () => {
    expect(() => validateConfig({ ...validEnv, ADMIN_PUBKEY: 'a'.repeat(32) })).toThrow(/ADMIN_PUBKEY/)
  })

  it('throws if HOTLINE_NAME is missing', () => {
    expect(() => validateConfig({ ...validEnv, HOTLINE_NAME: '' })).toThrow(/HOTLINE_NAME/)
  })

  it('throws if HOTLINE_NAME is whitespace only', () => {
    expect(() => validateConfig({ ...validEnv, HOTLINE_NAME: '   ' })).toThrow(/HOTLINE_NAME/)
  })

  it('throws if ENVIRONMENT is missing', () => {
    expect(() => validateConfig({ ...validEnv, ENVIRONMENT: '' })).toThrow(/ENVIRONMENT/)
  })
})
