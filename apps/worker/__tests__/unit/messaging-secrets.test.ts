import { describe, it, expect } from 'vitest'
import type { MessagingConfig } from '@shared/types'
import {
  carryOverSecrets,
  hasPlaintextSecrets,
  openMessagingConfig,
  redactMessagingConfig,
  sealMessagingConfig,
} from '@worker/services/messaging-secrets'

const KEK = 'ab'.repeat(32)
const telegram = { enabled: true, botToken: 'TOKEN', webhookSecret: 'HOOK', botUsername: 'bot' }

describe('messaging credential sealing (#3031)', () => {
  it('seals secrets out of the stored object and opens them back', () => {
    const stored = sealMessagingConfig({ inactivityTimeout: 30, telegram }, KEK)
    expect(JSON.stringify(stored)).not.toContain('TOKEN')
    expect(JSON.stringify(stored)).not.toContain('HOOK')
    expect(JSON.stringify(stored)).toContain('bot')
    expect(hasPlaintextSecrets(stored)).toBe(false)
    expect(openMessagingConfig(stored, KEK)).toEqual({ inactivityTimeout: 30, telegram })
  })

  it('stores a secret-free config as it is, without needing a key', () => {
    expect(sealMessagingConfig({ inactivityTimeout: 30, telegram: { enabled: false, botToken: '' } }, undefined)).toEqual({
      inactivityTimeout: 30,
      telegram: { enabled: false },
    })
  })

  it('refuses to seal or open without a key', () => {
    expect(() => sealMessagingConfig({ telegram }, undefined)).toThrow(/SERVER_KEK/)
    const stored = sealMessagingConfig({ telegram }, KEK)
    expect(() => openMessagingConfig(stored, undefined)).toThrow(/SERVER_KEK/)
  })

  it('refuses a ciphertext under the wrong key', () => {
    const stored = sealMessagingConfig({ telegram }, KEK)
    expect(() => openMessagingConfig(stored, 'cd'.repeat(32))).toThrow()
  })

  it('redacts every secret and reports whether it is set', () => {
    const redacted = redactMessagingConfig({ telegram, whatsapp: { integrationMode: 'twilio' } }) as {
      telegram: Record<string, unknown>
      whatsapp: Record<string, unknown>
    }
    expect(redacted.telegram).toEqual({ enabled: true, botUsername: 'bot', botTokenSet: true, webhookSecretSet: true })
    expect(redacted.whatsapp.accessTokenSet).toBe(false)
    expect(JSON.stringify(redacted)).not.toContain('TOKEN')
  })

  it('carries a stored secret over when the request omits or blanks it, and drops echoed flags', () => {
    const current = { telegram } as unknown as MessagingConfig
    const merged = carryOverSecrets(
      { telegram: { enabled: true, botToken: '', botTokenSet: true, botUsername: 'renamed' } as never },
      current,
    )
    expect(merged.telegram).toEqual({ enabled: true, botToken: 'TOKEN', webhookSecret: 'HOOK', botUsername: 'renamed' })
  })

  it('lets a request replace a secret, and leaves a null channel alone', () => {
    const current = { telegram } as unknown as MessagingConfig
    expect(carryOverSecrets({ telegram: { ...telegram, botToken: 'NEW' } }, current).telegram?.botToken).toBe('NEW')
    expect(carryOverSecrets({ telegram: null }, current).telegram).toBeNull()
  })
})
