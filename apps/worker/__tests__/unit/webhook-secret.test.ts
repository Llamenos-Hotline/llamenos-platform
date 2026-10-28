import { describe, it, expect } from 'vitest'
import type { RCSConfig, TelegramConfig } from '@shared/types'
import { createRCSAdapter } from '@worker/messaging/rcs/factory'
import { createTelegramAdapter } from '@worker/messaging/telegram/factory'
import { constantTimeEqual, hasWebhookSecret, webhookSecretProblem } from '@worker/messaging/webhook-secret'

const rcs: RCSConfig = {
  agentId: 'agent',
  serviceAccountKey: JSON.stringify({ type: 'service_account', private_key: 'x', client_email: 'a@b.c', token_uri: 'https://t.example' }),
  webhookSecret: 'rcs-secret',
  fallbackToSms: false,
}
const telegram: TelegramConfig = { enabled: true, botToken: '1:abc', webhookSecret: 'tg-secret' }

describe('hasWebhookSecret', () => {
  it.each([undefined, null, '', '  \t'])('rejects %j', (v) => expect(hasWebhookSecret(v)).toBe(false))
  it('accepts a real secret', () => expect(hasWebhookSecret('s3cret')).toBe(true))
})

describe('constantTimeEqual', () => {
  it('matches equal strings and rejects different ones of any length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
    expect(constantTimeEqual('', 'abc')).toBe(false)
  })
})

describe('webhookSecretProblem (configure-time)', () => {
  it('refuses an RCS config without a secret', () => {
    expect(webhookSecretProblem({ rcs: { ...rcs, webhookSecret: '' } })).toContain('RCS webhook secret is required')
  })
  it('refuses an enabled Telegram config without a secret', () => {
    expect(webhookSecretProblem({ telegram: { ...telegram, webhookSecret: '  ' } })).toContain('Telegram webhook secret is required')
  })
  it('does not judge a disabled Telegram channel or an untouched channel', () => {
    expect(webhookSecretProblem({ telegram: { ...telegram, enabled: false, webhookSecret: '' } })).toBeNull()
    expect(webhookSecretProblem({})).toBeNull()
    expect(webhookSecretProblem({ rcs: null, telegram: null })).toBeNull()
  })
  it('accepts configs that carry a secret', () => {
    expect(webhookSecretProblem({ rcs, telegram })).toBeNull()
  })
})

describe('adapter factories refuse a missing secret', () => {
  it('RCS', () => {
    expect(() => createRCSAdapter({ ...rcs, webhookSecret: '' })).toThrow('RCS webhook secret is required')
    expect(createRCSAdapter(rcs).channelType).toBe('rcs')
  })
  it('Telegram', () => {
    expect(() => createTelegramAdapter({ ...telegram, webhookSecret: '' })).toThrow('Telegram webhook secret is required')
    expect(createTelegramAdapter(telegram).channelType).toBe('telegram')
  })
})
