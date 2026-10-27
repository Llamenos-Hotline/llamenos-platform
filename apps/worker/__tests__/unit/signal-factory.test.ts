/**
 * Unit tests for apps/worker/messaging/signal/factory.ts
 *
 * Tests createSignalAdapter validation of required config fields.
 */
import { describe, it, expect } from 'vitest'
import { createSignalAdapter } from '@worker/messaging/signal/factory'

describe('createSignalAdapter', () => {
  const validConfig = {
    bridgeUrl: 'https://bridge.example.com',
    bridgeApiKey: 'api-key-123',
    webhookSecret: 'secret-456',
    registeredNumber: '+15551234567',
  }

  it('creates adapter with valid config', () => {
    const adapter = createSignalAdapter(validConfig)
    expect(adapter).toBeDefined()
    expect(typeof adapter.sendMessage).toBe('function')
  })

  it('throws when bridgeUrl is empty', () => {
    expect(() =>
      createSignalAdapter({ ...validConfig, bridgeUrl: '' })
    ).toThrow('Signal bridge configuration is incomplete')
  })

  it('throws when bridgeApiKey is empty', () => {
    expect(() =>
      createSignalAdapter({ ...validConfig, bridgeApiKey: '' })
    ).toThrow('Signal bridge configuration is incomplete')
  })

  it('throws when webhookSecret is empty', () => {
    expect(() =>
      createSignalAdapter({ ...validConfig, webhookSecret: '' })
    ).toThrow('Signal bridge configuration is incomplete')
  })

  it('throws when registeredNumber is empty', () => {
    expect(() =>
      createSignalAdapter({ ...validConfig, registeredNumber: '' })
    ).toThrow('Signal bridge configuration is incomplete')
  })

  it('throws when bridgeUrl is undefined', () => {
    const broken = { ...validConfig, bridgeUrl: undefined as unknown as string }
    expect(() =>
      createSignalAdapter(broken)
    ).toThrow('Signal bridge configuration is incomplete')
  })
})
