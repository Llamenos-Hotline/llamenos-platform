import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveStorageCredentials, STORAGE_NAMESPACES } from '@worker/lib/storage-manager'

describe('resolveStorageCredentials', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.STORAGE_ENDPOINT
    delete process.env.STORAGE_ACCESS_KEY
    delete process.env.STORAGE_SECRET_KEY
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('STORAGE_')) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, originalEnv)
  })

  it('uses STORAGE_ACCESS_KEY/STORAGE_SECRET_KEY as primary', () => {
    process.env.STORAGE_ACCESS_KEY = 'primary-key'
    process.env.STORAGE_SECRET_KEY = 'primary-secret'

    const result = resolveStorageCredentials()
    expect(result.accessKeyId).toBe('primary-key')
    expect(result.secretAccessKey).toBe('primary-secret')
  })

  it('throws when no credentials are configured', () => {
    expect(() => resolveStorageCredentials()).toThrow('Storage credentials required')
  })

  it('throws when only access key is set (no secret)', () => {
    process.env.STORAGE_ACCESS_KEY = 'key-only'

    expect(() => resolveStorageCredentials()).toThrow('Storage credentials required')
  })

  it('throws when only secret key is set (no access key)', () => {
    process.env.STORAGE_SECRET_KEY = 'secret-only'

    expect(() => resolveStorageCredentials()).toThrow('Storage credentials required')
  })

  it('uses STORAGE_ENDPOINT', () => {
    process.env.STORAGE_ENDPOINT = 'http://rustfs:9000'
    process.env.STORAGE_ACCESS_KEY = 'key'
    process.env.STORAGE_SECRET_KEY = 'secret'

    const result = resolveStorageCredentials()
    expect(result.endpoint).toBe('http://rustfs:9000')
  })

  it('defaults endpoint to localhost:9000', () => {
    process.env.STORAGE_ACCESS_KEY = 'key'
    process.env.STORAGE_SECRET_KEY = 'secret'

    const result = resolveStorageCredentials()
    expect(result.endpoint).toBe('http://localhost:9000')
  })
})

describe('STORAGE_NAMESPACES', () => {
  it('has voicemails with 365-day retention', () => {
    expect(STORAGE_NAMESPACES.voicemails.defaultRetentionDays).toBe(365)
  })

  it('has attachments with no retention (null)', () => {
    expect(STORAGE_NAMESPACES.attachments.defaultRetentionDays).toBeNull()
  })
})
