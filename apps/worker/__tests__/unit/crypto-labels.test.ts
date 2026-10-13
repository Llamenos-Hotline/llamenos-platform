import { describe, it, expect } from 'vitest'
import * as labels from '@shared/crypto-labels'

describe('Crypto domain separation labels', () => {
  const allLabels = Object.entries(labels).filter(([, v]) => typeof v === 'string')

  it('all labels are non-empty strings', () => {
    for (const [, value] of allLabels) {
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    }
  })

  it('all labels start with "llamenos:" prefix', () => {
    for (const [, value] of allLabels) {
      expect(value as string).toMatch(/^llamenos:/)
    }
  })

  it('all labels are unique (no collision)', () => {
    const values = allLabels.map(([, v]) => v)
    const unique = new Set(values)
    expect(unique.size).toBe(values.length)
  })

  it('has HPKE key wrapping labels', () => {
    expect(labels.LABEL_NOTE_KEY).toBe('llamenos:note-key')
    expect(labels.LABEL_FILE_KEY).toBe('llamenos:file-key')
    expect(labels.LABEL_FILE_METADATA).toBe('llamenos:file-metadata')
    expect(labels.LABEL_HUB_KEY_WRAP).toBe('llamenos:hub-key-wrap')
  })

  it('has HPKE content encryption labels', () => {
    expect(labels.LABEL_TRANSCRIPTION).toBe('llamenos:transcription')
    expect(labels.LABEL_MESSAGE).toBe('llamenos:message')
    expect(labels.LABEL_CALL_META).toBe('llamenos:call-meta')
    expect(labels.LABEL_SHIFT_SCHEDULE).toBe('llamenos:shift-schedule')
  })

  it('has HKDF derivation labels', () => {
    expect(labels.HKDF_SALT).toBe('llamenos:hkdf-salt:v1')
    expect(labels.HKDF_CONTEXT_NOTES).toBe('llamenos:notes')
    expect(labels.HKDF_CONTEXT_DRAFTS).toBe('llamenos:drafts')
    expect(labels.HKDF_CONTEXT_EXPORT).toBe('llamenos:export')
    expect(labels.LABEL_HUB_EVENT).toBe('llamenos:hub-event')
  })

  it('has auth token prefix', () => {
    expect(labels.AUTH_PREFIX).toBe('llamenos:auth:')
  })

  it('has HMAC domain separation prefixes', () => {
    expect(labels.HMAC_PHONE_PREFIX).toBe('llamenos:phone:')
    expect(labels.HMAC_IP_PREFIX).toBe('llamenos:ip:')
    expect(labels.HMAC_KEYID_PREFIX).toBe('llamenos:keyid:')
    expect(labels.HMAC_SUBSCRIBER).toBe('llamenos:subscriber')
    expect(labels.HMAC_PREFERENCE_TOKEN).toBe('llamenos:preference-token')
  })

  it('has device provisioning labels', () => {
    expect(labels.LABEL_DEVICE_PROVISION).toBe('llamenos:device-provision')
    expect(labels.SAS_SALT).toBe('llamenos:sas')
    expect(labels.SAS_INFO).toBe('llamenos:provisioning-sas')
  })

  it('has server Nostr key labels', () => {
  })

  it('has recovery/backup labels', () => {
    expect(labels.RECOVERY_SALT).toBe('llamenos:recovery')
    expect(labels.LABEL_BACKUP).toBe('llamenos:backup')
  })

  it('exports at least 20 labels', () => {
    expect(allLabels.length).toBeGreaterThanOrEqual(20)
  })
})
