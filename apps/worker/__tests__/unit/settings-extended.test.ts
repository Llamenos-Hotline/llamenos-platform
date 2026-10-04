/**
 * Extended unit tests for SettingsService covering methods not tested in settings.test.ts.
 * Targets: ensureInit, transcription, call settings, IVR, fallback group, custom fields,
 * messaging config, setup state, enabled channels, report types, telephony provider,
 * IVR audio, roles CRUD, captcha, TTL overrides, cleanup metrics, archiveHub, deleteHub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsService, invalidateRolesCache } from '@worker/services/settings'
import { createMockDb } from './mock-db'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettingsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    spamSettings: {
      voiceCaptchaEnabled: false,
      rateLimitEnabled: true,
      maxCallsPerMinute: 3,
      blockDurationMinutes: 30,
    },
    callSettings: { queueTimeoutSeconds: 90, voicemailMaxSeconds: 120 },
    ivrLanguages: ['en'],
    fallbackGroup: [],
    setupState: null,
    messagingConfig: null,
    reportCategories: null,
    reportTypes: null,
    ttlOverrides: null,
    cleanupMetrics: null,
    transcriptionEnabled: true,
    allowUserTranscriptionOptOut: false,
    webauthnSettings: null,
    ...overrides,
  }
}

function makeHub(overrides: Record<string, unknown> = {}) {
  const now = new Date()
  return {
    id: 'hub-1',
    name: 'Test Hub',
    slug: 'test-hub',
    description: 'A test hub',
    status: 'active',
    phoneNumber: null,
    createdBy: 'admin-pubkey',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeRole(overrides: Record<string, unknown> = {}) {
  const now = new Date()
  return {
    id: 'role-1',
    name: 'Volunteer',
    slug: 'volunteer',
    permissions: ['calls.answer'],
    isDefault: false,
    isSystem: false,
    description: 'Volunteer role',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function setup() {
  const { db } = createMockDb()
  const service = new SettingsService(db as any)
  return { db, service }
}

// ---------------------------------------------------------------------------
// ensureInit
// ---------------------------------------------------------------------------

describe('SettingsService.ensureInit', () => {
  it('seeds spam settings when row has empty spamSettings', async () => {
    const { db, service } = setup()
    // First select: returns row with empty spamSettings
    // Second select: roles check (empty)
    db.$setSelectResults([
      [makeSettingsRow({ spamSettings: {} })],
      [], // roles empty → seed defaults
    ])
    await service.ensureInit()
    expect(db.update).toHaveBeenCalled()
  })

  it('seeds default roles when no roles exist', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [makeSettingsRow({})],
      [], // no roles
    ])
    await service.ensureInit()
    expect(db.insert).toHaveBeenCalled()
  })

  it('skips role seeding when roles already exist', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [makeSettingsRow({})],
      [makeRole()], // roles exist
    ])
    await service.ensureInit()
    // insert should NOT be called for roles (update may be called for spam settings)
    const insertCalls = (db.insert as ReturnType<typeof vi.fn>).mock.calls.length
    expect(insertCalls).toBe(0)
  })

  it('marks setup complete in demo mode when not already completed', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [makeSettingsRow({ setupState: null, messagingConfig: null })],
      [makeRole()],
    ])
    await service.ensureInit({ DEMO_MODE: 'true' })
    expect(db.update).toHaveBeenCalled()
  })

  it('skips seeding on second call (idempotent via initialized flag)', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [makeSettingsRow()],
      [makeRole()],
    ])
    await service.ensureInit()
    const firstInsertCount = (db.insert as ReturnType<typeof vi.fn>).mock.calls.length
    await service.ensureInit() // second call — initialized flag is set
    const secondInsertCount = (db.insert as ReturnType<typeof vi.fn>).mock.calls.length
    expect(secondInsertCount).toBe(firstInsertCount) // no additional calls
  })

  it('still applies demo seeding after a default-mode init (server boot, then demo seeder)', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [makeSettingsRow()],
      [makeRole()],
      [makeSettingsRow({ setupState: null, messagingConfig: null })],
      [makeRole()],
    ])
    await service.ensureInit() // boot
    const updatesAfterBoot = (db.update as ReturnType<typeof vi.fn>).mock.calls.length
    await service.ensureInit({ DEMO_MODE: 'true' })
    expect((db.update as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(updatesAfterBoot)
  })
})

// ---------------------------------------------------------------------------
// getTranscriptionSettings
// ---------------------------------------------------------------------------

describe('SettingsService.getTranscriptionSettings', () => {
  it('returns transcription settings from DB', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ transcriptionEnabled: false, allowUserTranscriptionOptOut: true })])

    const result = await service.getTranscriptionSettings()
    expect(result.globalEnabled).toBe(false)
    expect(result.allowUserOptOut).toBe(true)
  })

  it('returns defaults when fields are null', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ transcriptionEnabled: null, allowUserTranscriptionOptOut: null })])

    const result = await service.getTranscriptionSettings()
    expect(result.globalEnabled).toBe(true) // default true
    expect(result.allowUserOptOut).toBe(false) // default false
  })
})

describe('SettingsService.updateTranscriptionSettings', () => {
  it('updates globalEnabled', async () => {
    const { db, service } = setup()
    // updateTranscriptionSettings calls getSettings() once at the end (in getTranscriptionSettings())
    // Set up the mock to return the post-update state on that read
    db.$setSelectResult([makeSettingsRow({ transcriptionEnabled: false, allowUserTranscriptionOptOut: false })])

    const result = await service.updateTranscriptionSettings({ globalEnabled: false })
    expect(db.update).toHaveBeenCalled()
    expect(result.globalEnabled).toBe(false)
  })

  it('updates allowUserOptOut', async () => {
    const { db, service } = setup()
    // Return post-update state for the single getSettings() call
    db.$setSelectResult([makeSettingsRow({ transcriptionEnabled: true, allowUserTranscriptionOptOut: true })])

    const result = await service.updateTranscriptionSettings({ allowUserOptOut: true })
    expect(result.allowUserOptOut).toBe(true)
  })

  it('does not call update when no fields provided', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow()])

    await service.updateTranscriptionSettings({})
    expect(db.update).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getCallSettings / updateCallSettings
// ---------------------------------------------------------------------------

describe('SettingsService.getCallSettings', () => {
  it('returns call settings from DB', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ callSettings: { queueTimeoutSeconds: 60, voicemailMaxSeconds: 90 } })])

    const result = await service.getCallSettings()
    expect(result.queueTimeoutSeconds).toBe(60)
    expect(result.voicemailMaxSeconds).toBe(90)
  })

  it('returns defaults when callSettings is null', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ callSettings: null })])

    const result = await service.getCallSettings()
    expect(result.queueTimeoutSeconds).toBe(90)
    expect(result.voicemailMaxSeconds).toBe(120)
  })
})

describe('SettingsService.updateCallSettings', () => {
  it('clamps queueTimeoutSeconds to min 30', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow()])

    const result = await service.updateCallSettings({ queueTimeoutSeconds: 5 })
    expect(result.queueTimeoutSeconds).toBe(30)
  })

  it('clamps queueTimeoutSeconds to max 300', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow()])

    const result = await service.updateCallSettings({ queueTimeoutSeconds: 9999 })
    expect(result.queueTimeoutSeconds).toBe(300)
  })

  it('accepts value within valid range', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow()])

    const result = await service.updateCallSettings({ queueTimeoutSeconds: 120 })
    expect(result.queueTimeoutSeconds).toBe(120)
  })

  it('preserves existing value when field is not in update', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ callSettings: { queueTimeoutSeconds: 60, voicemailMaxSeconds: 90 } })])

    const result = await service.updateCallSettings({ voicemailMaxSeconds: 60 })
    expect(result.queueTimeoutSeconds).toBe(60) // preserved
    expect(result.voicemailMaxSeconds).toBe(60) // updated
  })

  it('persists changes to database', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow()])

    await service.updateCallSettings({ queueTimeoutSeconds: 100 })
    expect(db.update).toHaveBeenCalled()
  })
})

describe('SettingsService per-hub call settings (#1051)', () => {
  it('reads the hub override layered over the platform values', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [makeSettingsRow()],
      [{ hubId: 'hub-a', settings: { callSettings: { queueTimeoutSeconds: 45 } } }],
    ])
    const result = await service.getCallSettings('hub-a')
    expect(result.queueTimeoutSeconds).toBe(45)
    expect(result.voicemailMaxSeconds).toBe(120)
  })

  it('hub update clamps, persists to hub_settings and never touches system_settings', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ hubId: 'hub-a', settings: {} }],
      [{ hubId: 'hub-a', settings: {} }],
      [makeSettingsRow()],
      [{ hubId: 'hub-a', settings: { callSettings: { queueTimeoutSeconds: 30 } } }],
    ])
    await service.updateCallSettings({ queueTimeoutSeconds: 5 }, 'hub-a')
    expect(db.insert).toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getIvrLanguages / updateIvrLanguages
// ---------------------------------------------------------------------------

describe('SettingsService.getIvrLanguages', () => {
  it('returns IVR languages from DB', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ ivrLanguages: ['en', 'es'] })])

    const result = await service.getIvrLanguages()
    expect(result.enabledLanguages).toEqual(['en', 'es'])
  })

  it('returns all IVR languages as defaults when null', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ ivrLanguages: null })])

    const result = await service.getIvrLanguages()
    expect(result.enabledLanguages.length).toBeGreaterThan(0)
    expect(result.enabledLanguages).toContain('en')
  })
})

describe('SettingsService.updateIvrLanguages', () => {
  it('throws 400 for empty array', async () => {
    const { service } = setup()
    await expect(
      service.updateIvrLanguages({ enabledLanguages: [] }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('throws 400 for invalid language codes', async () => {
    const { service } = setup()
    await expect(
      service.updateIvrLanguages({ enabledLanguages: ['klingon', 'elvish'] }),
    ).rejects.toMatchObject({ status: 400, message: 'No valid IVR language codes provided' })
  })

  it('filters out invalid codes, saves only valid ones', async () => {
    const { db, service } = setup()

    const result = await service.updateIvrLanguages({ enabledLanguages: ['en', 'invalid_xyz'] })
    expect(result.enabledLanguages).toEqual(['en'])
    expect(db.update).toHaveBeenCalled()
  })

  it('accepts valid language codes', async () => {
    const { service } = setup()

    const result = await service.updateIvrLanguages({ enabledLanguages: ['en', 'es'] })
    expect(result.enabledLanguages).toContain('en')
    expect(result.enabledLanguages).toContain('es')
  })
})

// ---------------------------------------------------------------------------
// Per-hub IVR language override (#732)
// ---------------------------------------------------------------------------

describe('SettingsService.getHubIvrLanguages (per-hub override cascade)', () => {
  it('returns the hub override when hub_settings.settings.ivrLanguages is set', async () => {
    const { service } = setup()
    vi.spyOn(service, 'getHubSettings').mockResolvedValue({ ivrLanguages: ['fr', 'de'] })

    const result = await service.getHubIvrLanguages('hub-1')
    expect(result).toEqual(['fr', 'de'])
  })

  it('falls back to the instance-wide list when the hub has no override', async () => {
    const { db, service } = setup()
    vi.spyOn(service, 'getHubSettings').mockResolvedValue({})
    db.$setSelectResult([makeSettingsRow({ ivrLanguages: ['en', 'es'] })])

    const result = await service.getHubIvrLanguages('hub-1')
    expect(result).toEqual(['en', 'es'])
  })

  it('falls back to the IVR_LANGUAGES constant when neither hub nor instance has a list', async () => {
    const { db, service } = setup()
    vi.spyOn(service, 'getHubSettings').mockResolvedValue({})
    db.$setSelectResult([makeSettingsRow({ ivrLanguages: null })])

    const result = await service.getHubIvrLanguages('hub-1')
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain('en')
  })
})

describe('SettingsService.updateIvrLanguages — provider speakability (#732)', () => {
  it('rejects a hub override naming a language the hub-specific provider cannot speak', async () => {
    const { service } = setup()
    vi.spyOn(service, 'getHubTelephonyProvider').mockResolvedValue({
      type: 'vonage',
      phoneNumber: '+15551234567',
    } as any)

    // Vonage's catalog has no entry for 'ht' (Haitian Creole) — see vonage.ts.
    await expect(
      service.updateIvrLanguages({ enabledLanguages: ['en', 'ht'] }, 'hub-1'),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('tells a self-hosted operator which language a caller hears instead, and that recordings fix it (#1347)', async () => {
    const { service } = setup()
    vi.spyOn(service, 'getHubTelephonyProvider').mockResolvedValue({
      type: 'asterisk',
      phoneNumber: '+15551234567',
    } as any)

    // Generated speech has no Tagalog or Mixtec voice (ivr-speech/voices.ts).
    const refused = service.updateIvrLanguages({ enabledLanguages: ['en', 'tl', 'mix'] }, 'hub-1')
    await expect(refused).rejects.toMatchObject({ status: 400 })
    await expect(refused).rejects.toThrow(/cannot speak: tl, mix\. No offline voice exists for them: .*\(tl → en, mix → es\) unless you upload recordings/)
  })

  it('accepts a hub override where every language is in the provider catalog', async () => {
    const { service } = setup()
    vi.spyOn(service, 'getHubTelephonyProvider').mockResolvedValue({
      type: 'vonage',
      phoneNumber: '+15551234567',
    } as any)

    const result = await service.updateIvrLanguages(
      { enabledLanguages: ['en', 'es'] },
      'hub-1',
    )
    expect(result.enabledLanguages).toEqual(['en', 'es'])
  })

  it('falls back to the global provider when the hub has none configured', async () => {
    const { service } = setup()
    vi.spyOn(service, 'getHubTelephonyProvider').mockResolvedValue(null)
    vi.spyOn(service, 'getTelephonyProvider').mockResolvedValue({
      type: 'vonage',
      phoneNumber: '+15551234567',
    } as any)

    await expect(
      service.updateIvrLanguages({ enabledLanguages: ['en', 'ht'] }, 'hub-1'),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('does not constrain by provider speakability when no provider is configured yet', async () => {
    const { service } = setup()
    vi.spyOn(service, 'getHubTelephonyProvider').mockResolvedValue(null)
    vi.spyOn(service, 'getTelephonyProvider').mockResolvedValue(null)

    const result = await service.updateIvrLanguages(
      { enabledLanguages: ['en', 'ht'] },
      'hub-1',
    )
    expect(result.enabledLanguages).toEqual(['en', 'ht'])
  })
})

// ---------------------------------------------------------------------------
// getFallbackGroup / setFallbackGroup
// ---------------------------------------------------------------------------

describe('SettingsService.getFallbackGroup', () => {
  it('returns fallback group from global settings', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ fallbackGroup: ['pk1', 'pk2'] })])

    const result = await service.getFallbackGroup()
    expect(result.userPubkeys).toEqual(['pk1', 'pk2'])
  })

  it('returns empty array when fallbackGroup is null', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ fallbackGroup: null })])

    const result = await service.getFallbackGroup()
    expect(result.userPubkeys).toEqual([])
  })
})

describe('SettingsService.setFallbackGroup', () => {
  it('updates global fallback group', async () => {
    const { db, service } = setup()

    const result = await service.setFallbackGroup({ userPubkeys: ['pk1', 'pk2'] })
    expect(result).toEqual({ ok: true })
    expect(db.update).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getCustomFields / updateCustomFields
// ---------------------------------------------------------------------------

describe('SettingsService.getCustomFields', () => {
  it('returns all fields for admin role', async () => {
    const now = new Date()
    const { db, service } = setup()
    db.$setSelectResult([
      {
        id: 'field-1',
        name: 'notes_category',
        label: 'Category',
        fieldType: 'select',
        required: false,
        options: ['A', 'B'],
        validation: null,
        visibleToUsers: false,
        editableByUsers: true,
        context: 'call-notes',
        maxFileSize: null,
        allowedMimeTypes: null,
        maxFiles: 1,
        sortOrder: 0,
        createdAt: now,
      },
    ])

    const result = await service.getCustomFields('admin')
    expect(result.fields).toHaveLength(1)
    expect(result.fields[0].name).toBe('notes_category')
  })

  it('filters out non-visible fields for non-admin role', async () => {
    const now = new Date()
    const { db, service } = setup()
    db.$setSelectResult([
      {
        id: 'field-1',
        name: 'admin_only',
        label: 'Admin Only',
        fieldType: 'text',
        required: false,
        options: null,
        validation: null,
        visibleToUsers: false, // hidden from users
        editableByUsers: false,
        context: 'all',
        maxFileSize: null,
        allowedMimeTypes: null,
        maxFiles: 1,
        sortOrder: 0,
        createdAt: now,
      },
    ])

    const result = await service.getCustomFields('volunteer')
    expect(result.fields).toHaveLength(0)
  })
})

describe('SettingsService.updateCustomFields', () => {
  const validField = {
    id: 'field-1',
    name: 'severity',
    label: 'Severity',
    type: 'select' as const,
    required: false,
    options: ['low', 'medium', 'high'],
    visibleToUsers: true,
    editableByUsers: true,
    context: 'all' as const,
    order: 0,
    createdAt: new Date().toISOString(),
  }

  it('throws 400 when fields is not an array', async () => {
    const { service } = setup()
    await expect(
      service.updateCustomFields({ fields: null as any }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('throws 400 when field name is invalid (special characters)', async () => {
    const { service } = setup()
    await expect(
      service.updateCustomFields({
        fields: [{ ...validField, name: 'bad-name!' }],
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('throws 400 for duplicate field names', async () => {
    const { service } = setup()
    await expect(
      service.updateCustomFields({
        fields: [
          { ...validField, name: 'duplicate' },
          { ...validField, id: 'field-2', name: 'duplicate' },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Duplicate') })
  })

  it('throws 400 for select field without options', async () => {
    const { service } = setup()
    await expect(
      service.updateCustomFields({
        fields: [{ ...validField, type: 'select' as const, options: [] }],
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('throws 400 for invalid field type', async () => {
    const { service } = setup()
    await expect(
      service.updateCustomFields({
        fields: [{ ...validField, type: 'audio' as any }],
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('saves valid fields in a transaction, taking the replace lock before deleting', async () => {
    const { db, service } = setup()
    const tx = {
      execute: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([]),
      }),
    }
    ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx))

    const result = await service.updateCustomFields({ fields: [validField] })
    expect((db as any).transaction).toHaveBeenCalled()
    expect(result.fields).toHaveLength(1)
    // Concurrency itself is covered against real PostgreSQL in
    // __tests__/integration/custom-fields-concurrency.test.ts (#686).
    expect(tx.execute).toHaveBeenCalledTimes(1)
    expect(tx.execute.mock.invocationCallOrder[0]).toBeLessThan(
      tx.delete.mock.invocationCallOrder[0],
    )
  })

  it('normalizes "both" context to "all"', async () => {
    const { db, service } = setup()
    const tx = {
      execute: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
    }
    ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx))

    const result = await service.updateCustomFields({
      fields: [{ ...validField, context: 'both' as any }],
    })
    expect(result.fields[0].context).toBe('all')
  })
})

// ---------------------------------------------------------------------------
// getMessagingConfig / updateMessagingConfig
// ---------------------------------------------------------------------------

describe('SettingsService.getMessagingConfig', () => {
  it('returns messaging config from DB', async () => {
    const { db, service } = setup()
    const config = {
      inactivityTimeout: 60,
      maxConcurrentPerUser: 5,
      enabledChannels: ['sms', 'signal'],
      requireAssignment: false,
    }
    db.$setSelectResult([makeSettingsRow({ messagingConfig: config })])

    const result = await service.getMessagingConfig()
    expect(result.inactivityTimeout).toBe(60)
    expect(result.enabledChannels).toContain('sms')
  })

  it('returns defaults when messagingConfig is null', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ messagingConfig: null })])

    const result = await service.getMessagingConfig()
    expect(result).toBeDefined()
    expect(typeof result.inactivityTimeout).toBe('number')
  })
})

describe('SettingsService.updateMessagingConfig', () => {
  it('throws 400 when inactivityTimeout is out of range', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({
      messagingConfig: { inactivityTimeout: 60, maxConcurrentPerUser: 5, enabledChannels: [], requireAssignment: false },
    })])

    await expect(
      service.updateMessagingConfig({ inactivityTimeout: 3 }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('throws 400 when maxConcurrentPerUser is out of range', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({
      messagingConfig: { inactivityTimeout: 60, maxConcurrentPerUser: 5, enabledChannels: [], requireAssignment: false },
    })])

    await expect(
      service.updateMessagingConfig({ maxConcurrentPerUser: 25 }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('merges partial update and persists', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({
      messagingConfig: { inactivityTimeout: 60, maxConcurrentPerUser: 5, enabledChannels: ['sms'], requireAssignment: false },
    })])

    const result = await service.updateMessagingConfig({ inactivityTimeout: 30 })
    expect(result.inactivityTimeout).toBe(30)
    expect(result.maxConcurrentPerUser).toBe(5) // preserved
    expect(db.update).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getSetupState / updateSetupState
// ---------------------------------------------------------------------------

describe('SettingsService.getSetupState', () => {
  it('returns setup state from DB', async () => {
    const { db, service } = setup()
    const state = {
      setupCompleted: true,
      completedSteps: ['welcome'],
      pendingChannels: [],
      selectedChannels: ['voice'],
    }
    db.$setSelectResult([makeSettingsRow({ setupState: state })])

    const result = await service.getSetupState()
    expect(result.setupCompleted).toBe(true)
  })

  it('returns default setup state when null', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ setupState: null })])

    const result = await service.getSetupState()
    expect(result).toBeDefined()
    expect(typeof result.setupCompleted).toBe('boolean')
  })
})

describe('SettingsService.updateSetupState', () => {
  it('merges partial update', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({
      setupState: { setupCompleted: false, completedSteps: [], pendingChannels: [], selectedChannels: [] },
    })])

    const result = await service.updateSetupState({ setupCompleted: true })
    expect(result.setupCompleted).toBe(true)
    expect(db.update).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getEnabledChannels
// ---------------------------------------------------------------------------

describe('SettingsService.getEnabledChannels', () => {
  it('returns voice enabled when telephony provider configured', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [makeSettingsRow({
        messagingConfig: { enabledChannels: ['sms'], inactivityTimeout: 60, maxConcurrentPerUser: 5, requireAssignment: false },
        setupState: { selectedChannels: ['voice', 'sms', 'reports'], completedSteps: [], pendingChannels: [], setupCompleted: true },
      })],
      [{ id: 'pc-1', hubId: '', providerType: 'twilio', credentials: JSON.stringify({ type: 'twilio', accountSid: 'AC123', authToken: 'tok', phoneNumber: '+15551234567' }), status: 'connected', capabilities: [], phoneNumbers: ['+15551234567'] }],
    ])

    const result = await service.getEnabledChannels({})
    expect(result.voice).toBe(true)
    expect(result.sms).toBe(true)
    expect(result.reports).toBe(true)
    expect(result.signal).toBe(false)
  })

  it('returns voice enabled via env vars when no provider configured', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [makeSettingsRow({ messagingConfig: null, setupState: null })],
      [],
    ])

    const result = await service.getEnabledChannels({
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'tok',
      TWILIO_PHONE_NUMBER: '+15551234567',
    })
    expect(result.voice).toBe(true)
  })

  it('returns voice disabled when neither provider nor env vars present', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [makeSettingsRow({})],
      [],
    ])

    const result = await service.getEnabledChannels({})
    expect(result.voice).toBe(false)
  })

  /**
   * On a real deployment `system_settings.setup_state` is `{}` — that is what
   * `getSettings()` upserts for the singleton row, so it is the shape every
   * fresh install has until the setup wizard writes to it. `getEnabledChannels`
   * read `row.setupState` directly and cast it `as SetupState | null`, then did
   * `setupState?.selectedChannels.includes(...)`: the `?.` guards a null row but
   * not a present-and-empty one, so `{}` threw a TypeError.
   *
   * `GET /api/config` catches that and returns every channel `false`, and the
   * desktop gates its whole Conversations page on those flags
   * (`src/client/lib/config.tsx` `hasAnyMessaging`) — so a deployment with
   * `enabledChannels: ['signal']` persisted rendered "No messaging channels
   * enabled" and the messaging UI was unreachable.
   *
   * Every other test here supplies a complete `setupState` or `null`, which is
   * exactly why this was never caught. Do not "fix" this case by giving the
   * fixture a fuller object than production has.
   */
  it('reads channels when setupState is the empty object a fresh install stores', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [makeSettingsRow({
        messagingConfig: { enabledChannels: ['signal'], inactivityTimeout: 60, maxConcurrentPerUser: 5, requireAssignment: false },
        setupState: {},
      })],
      [],
    ])

    const result = await service.getEnabledChannels({})
    expect(result.signal).toBe(true)
    expect(result.reports).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getReportCategories / updateReportCategories
// ---------------------------------------------------------------------------

describe('SettingsService.getReportCategories', () => {
  it('returns categories from DB', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ reportCategories: ['Incident', 'Observation'] })])

    const result = await service.getReportCategories()
    expect(result.categories).toEqual(['Incident', 'Observation'])
  })

  it('returns default categories when null', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ reportCategories: null })])

    const result = await service.getReportCategories()
    expect(result.categories).toContain('Incident Report')
  })
})

describe('SettingsService.updateReportCategories', () => {
  it('throws 400 when categories is not an array', async () => {
    const { service } = setup()
    await expect(
      service.updateReportCategories({ categories: 'wrong' as any }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('truncates to 50 categories and saves', async () => {
    const { db, service } = setup()
    const categories = Array.from({ length: 60 }, (_, i) => `Category ${i}`)

    const result = await service.updateReportCategories({ categories })
    expect(result.categories).toHaveLength(50)
    expect(db.update).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getReportTypes / createReportType / updateReportType / archiveReportType
// ---------------------------------------------------------------------------

describe('SettingsService.getReportTypes', () => {
  it('returns report types from DB', async () => {
    const { db, service } = setup()
    const types = [{ id: 'rt-1', name: 'Incident', description: '', fields: [], isDefault: true, isArchived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]
    db.$setSelectResult([makeSettingsRow({ reportTypes: types })])

    const result = await service.getReportTypes()
    expect(result.reportTypes).toHaveLength(1)
    expect(result.reportTypes[0].name).toBe('Incident')
  })

  it('seeds default report types when null', async () => {
    const { db, service } = setup()
    // First: getSettings returns row with null reportTypes
    // After update, second getSettings in the same call doesn't happen (method returns directly)
    db.$setSelectResult([makeSettingsRow({ reportTypes: null })])

    const result = await service.getReportTypes()
    expect(result.reportTypes.length).toBeGreaterThan(0)
    expect(db.update).toHaveBeenCalled()
  })
})

describe('SettingsService.createReportType', () => {
  it('throws 400 when name is missing', async () => {
    const { service } = setup()
    await expect(
      service.createReportType({ description: 'No name' }),
    ).rejects.toMatchObject({ status: 400, message: 'Name is required' })
  })

  it('throws 400 when name is empty string', async () => {
    const { service } = setup()
    await expect(
      service.createReportType({ name: '   ' }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('creates a report type and returns it', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ reportTypes: [] })])

    const result = await service.createReportType({ name: 'New Report', description: 'Test' })
    expect(result.name).toBe('New Report')
    expect(result.id).toBeDefined()
    expect(result.isArchived).toBe(false)
    expect(db.update).toHaveBeenCalled()
  })

  it('clears other isDefault flags when isDefault is true', async () => {
    const { db, service } = setup()
    const existing = [{ id: 'rt-0', name: 'Old', description: '', fields: [], isDefault: true, isArchived: false, createdAt: '', updatedAt: '' }]
    db.$setSelectResult([makeSettingsRow({ reportTypes: existing })])

    await service.createReportType({ name: 'New Default', isDefault: true })
    expect(db.update).toHaveBeenCalled()
  })
})

describe('SettingsService.updateReportType', () => {
  it('throws 404 when report type not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ reportTypes: [] })])

    await expect(
      service.updateReportType('nonexistent', { name: 'Updated' }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('throws 400 when updating name to empty string', async () => {
    const { db, service } = setup()
    const types = [{ id: 'rt-1', name: 'Incident', description: '', fields: [], isDefault: true, isArchived: false, createdAt: '', updatedAt: '' }]
    db.$setSelectResult([makeSettingsRow({ reportTypes: types })])

    await expect(
      service.updateReportType('rt-1', { name: '' }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('updates name and returns updated type', async () => {
    const { db, service } = setup()
    const types = [{ id: 'rt-1', name: 'Old Name', description: '', fields: [], isDefault: false, isArchived: false, createdAt: '', updatedAt: '' }]
    db.$setSelectResult([makeSettingsRow({ reportTypes: types })])

    const result = await service.updateReportType('rt-1', { name: 'New Name' })
    expect(result.name).toBe('New Name')
    expect(db.update).toHaveBeenCalled()
  })
})

describe('SettingsService.archiveReportType', () => {
  it('throws 404 when report type not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ reportTypes: [] })])

    await expect(service.archiveReportType('nonexistent')).rejects.toMatchObject({ status: 404 })
  })

  it('throws 400 when archiving the last active type', async () => {
    const { db, service } = setup()
    const types = [{ id: 'rt-1', name: 'Only Type', description: '', fields: [], isDefault: true, isArchived: false, createdAt: '', updatedAt: '' }]
    db.$setSelectResult([makeSettingsRow({ reportTypes: types })])

    await expect(service.archiveReportType('rt-1')).rejects.toMatchObject({ status: 400 })
  })

  it('archives a type and promotes another to default', async () => {
    const { db, service } = setup()
    const types = [
      { id: 'rt-1', name: 'Default Type', description: '', fields: [], isDefault: true, isArchived: false, createdAt: '', updatedAt: '' },
      { id: 'rt-2', name: 'Other Type', description: '', fields: [], isDefault: false, isArchived: false, createdAt: '', updatedAt: '' },
    ]
    db.$setSelectResult([makeSettingsRow({ reportTypes: types })])

    const result = await service.archiveReportType('rt-1')
    expect(result).toEqual({ ok: true })
    expect(db.update).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getTelephonyProvider / updateTelephonyProvider
// ---------------------------------------------------------------------------

describe('SettingsService.getTelephonyProvider', () => {
  it('returns provider from DB', async () => {
    const { db, service } = setup()
    const provider = { type: 'twilio', accountSid: 'AC123', authToken: 'tok', phoneNumber: '+15551234567' }
    db.$setSelectResult([{
      id: 'pc-1',
      hubId: '',
      providerType: 'twilio',
      credentials: JSON.stringify(provider),
      status: 'connected',
      capabilities: [],
      phoneNumbers: ['+15551234567'],
    }])

    const result = await service.getTelephonyProvider()
    expect(result?.type).toBe('twilio')
  })

  it('returns null when no provider configured', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    const result = await service.getTelephonyProvider()
    expect(result).toBeNull()
  })
})

describe('SettingsService.updateTelephonyProvider', () => {
  it('throws deprecation error for any input', async () => {
    const { service } = setup()
    await expect(
      service.updateTelephonyProvider({ type: 'twilio' } as never),
    ).rejects.toThrow(/deprecated.*POST \/provider-setup\/configure/i)
  })

  it('throws deprecation error regardless of provider type', async () => {
    const { service } = setup()
    await expect(
      service.updateTelephonyProvider({ type: 'invalidpbx' } as never),
    ).rejects.toThrow(/deprecated/)
  })

  it('throws deprecation error regardless of phone format', async () => {
    const { service } = setup()
    await expect(
      service.updateTelephonyProvider({ type: 'twilio', phoneNumber: '+15551234567' } as never),
    ).rejects.toThrow(/deprecated/)
  })
})

// ---------------------------------------------------------------------------
// IVR Audio
// ---------------------------------------------------------------------------

describe('SettingsService.getIvrAudioList', () => {
  it('returns empty list when no audio', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    const result = await service.getIvrAudioList()
    expect(result.recordings).toEqual([])
  })

  it('maps DB rows to recordings shape', async () => {
    const { db, service } = setup()
    const now = new Date()
    db.$setSelectResult([
      { promptType: 'greeting', language: 'en', size: 4096, uploadedAt: now },
    ])

    const result = await service.getIvrAudioList()
    expect(result.recordings).toHaveLength(1)
    expect(result.recordings[0].promptType).toBe('greeting')
    expect(typeof result.recordings[0].uploadedAt).toBe('string')
  })
})

describe('SettingsService.uploadIvrAudio', () => {
  it('throws 400 for invalid prompt type', async () => {
    const { service } = setup()
    await expect(
      service.uploadIvrAudio('invalid_type', 'en', 'base64data', 100),
    ).rejects.toMatchObject({ status: 400, message: 'Invalid prompt type' })
  })

  it('throws 400 for empty file (size = 0)', async () => {
    const { service } = setup()
    await expect(
      service.uploadIvrAudio('greeting', 'en', 'base64data', 0),
    ).rejects.toMatchObject({ status: 400, message: 'Empty file' })
  })

  it('throws 400 for file exceeding 1MB', async () => {
    const { service } = setup()
    await expect(
      service.uploadIvrAudio('greeting', 'en', 'base64data', 2_000_000),
    ).rejects.toMatchObject({ status: 400, message: 'File too large (max 1MB)' })
  })

  it('upserts valid audio and returns metadata', async () => {
    const { db, service } = setup()

    const result = await service.uploadIvrAudio('greeting', 'en', 'base64data', 1024)
    expect(result.ok).toBe(true)
    expect(result.promptType).toBe('greeting')
    expect(result.language).toBe('en')
    expect(result.size).toBe(1024)
    expect(db.insert).toHaveBeenCalled()
  })
})

describe('SettingsService.getIvrAudio', () => {
  it('returns null when not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    const result = await service.getIvrAudio('greeting', 'en')
    expect(result).toBeNull()
  })

  it('returns audio data when found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([{ promptType: 'greeting', language: 'en', audio: 'base64data', size: 1024, uploadedAt: new Date() }])

    const result = await service.getIvrAudio('greeting', 'en')
    expect(result?.audio).toBe('base64data')
    expect(result?.size).toBe(1024)
  })
})

describe('SettingsService.deleteIvrAudio', () => {
  it('deletes and returns ok', async () => {
    const { db, service } = setup()

    const result = await service.deleteIvrAudio('greeting', 'en')
    expect(result).toEqual({ ok: true })
    expect(db.delete).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Roles CRUD
// ---------------------------------------------------------------------------

describe('SettingsService.getRoles', () => {
  beforeEach(() => {
    invalidateRolesCache()
  })

  it('returns roles from DB', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeRole()])

    const result = await service.getRoles()
    expect(result.roles).toHaveLength(1)
    expect(result.roles[0].slug).toBe('volunteer')
  })

  it('caches roles on second call', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeRole()])

    await service.getRoles()
    await service.getRoles()

    // DB is queried 3 times on the first call (roles, envelopes, user counts),
    // then 0 times on the cached second call — total = 3
    expect(db.select).toHaveBeenCalledTimes(3)
  })

  it('returns empty roles list when no roles in DB', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    const result = await service.getRoles()
    expect(result.roles).toEqual([])
  })
})

describe('SettingsService.createRole', () => {
  it('throws 400 when required fields missing', async () => {
    const { service } = setup()
    await expect(
      service.createRole({ name: 'Incomplete' }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('throws 400 for invalid slug format', async () => {
    const { service } = setup()
    await expect(
      service.createRole({ name: 'Test', slug: 'Bad Slug!', permissions: ['read'], description: 'Test' }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('throws 409 when slug already exists', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeRole({ slug: 'existing' })])

    await expect(
      service.createRole({ name: 'New', slug: 'existing', permissions: ['read'], description: 'Test' }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('creates role with valid data', async () => {
    const { db, service } = setup()
    db.$setSelectResult([]) // slug check: not found

    const result = await service.createRole({
      name: 'Observer',
      slug: 'observer',
      permissions: ['calls.view'],
      description: 'Observer role',
    })
    expect(result.slug).toBe('observer')
    expect(result.isSystem).toBe(false)
    expect(result.isDefault).toBe(false)
    expect(db.insert).toHaveBeenCalled()
  })
})

describe('SettingsService.updateRole', () => {
  it('throws 404 when role not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.updateRole('nonexistent', { name: 'New' })).rejects.toMatchObject({ status: 404 })
  })

  it('throws 403 when updating system role', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeRole({ isSystem: true })])

    await expect(service.updateRole('role-1', { name: 'Hacked' })).rejects.toMatchObject({ status: 403 })
  })

  it('updates name and returns updated role', async () => {
    const { db, service } = setup()
    const updated = makeRole({ name: 'Updated Name' })
    db.$setSelectResults([[makeRole()], [updated]])

    const result = await service.updateRole('role-1', { name: 'Updated Name' })
    expect(result.name).toBe('Updated Name')
    expect(db.update).toHaveBeenCalled()
  })
})

describe('SettingsService.deleteRole', () => {
  it('throws 404 when role not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.deleteRole('nonexistent')).rejects.toMatchObject({ status: 404 })
  })

  it('throws 403 when deleting default role', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeRole({ isDefault: true })])

    await expect(service.deleteRole('role-1')).rejects.toMatchObject({ status: 403 })
  })

  it('deletes non-default role', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeRole({ isDefault: false })])

    const result = await service.deleteRole('role-1')
    expect(result).toEqual({ ok: true })
    expect(db.delete).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// CAPTCHA
// ---------------------------------------------------------------------------

describe('SettingsService.storeCaptcha', () => {
  it('stores captcha and returns ok', async () => {
    const { db, service } = setup()

    const result = await service.storeCaptcha({ callSid: 'CA123', expected: '1234' })
    expect(result).toEqual({ ok: true })
    expect(db.insert).toHaveBeenCalled()
  })
})

describe('SettingsService.verifyCaptcha', () => {
  it('returns match: false when no captcha stored', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    const result = await service.verifyCaptcha({ callSid: 'CA123', digits: '1234' })
    expect(result.match).toBe(false)
    expect(result.expected).toBe('')
  })

  it('returns match: false for expired captcha', async () => {
    const { db, service } = setup()
    const oldDate = new Date(Date.now() - 10 * 60 * 1000) // 10 minutes ago
    db.$setSelectResult([{ callSid: 'CA123', expected: '1234', createdAt: oldDate }])

    const result = await service.verifyCaptcha({ callSid: 'CA123', digits: '1234' })
    expect(result.match).toBe(false)
    expect(result.expected).toBe('1234')
  })

  it('returns match: true for correct digits within TTL', async () => {
    const { db, service } = setup()
    const now = new Date()
    db.$setSelectResult([{ callSid: 'CA123', expected: '5678', createdAt: now }])

    const result = await service.verifyCaptcha({ callSid: 'CA123', digits: '5678' })
    expect(result.match).toBe(true)
    expect(result.expected).toBe('5678')
  })

  it('returns match: false for wrong digits', async () => {
    const { db, service } = setup()
    const now = new Date()
    db.$setSelectResult([{ callSid: 'CA123', expected: '5678', createdAt: now }])

    const result = await service.verifyCaptcha({ callSid: 'CA123', digits: '0000' })
    expect(result.match).toBe(false)
  })

  it('deletes captcha on verification (one-time use)', async () => {
    const { db, service } = setup()
    const now = new Date()
    db.$setSelectResult([{ callSid: 'CA123', expected: '9999', createdAt: now }])

    await service.verifyCaptcha({ callSid: 'CA123', digits: '9999' })
    expect(db.delete).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// TTL Overrides
// ---------------------------------------------------------------------------

describe('SettingsService.getTTLOverrides', () => {
  it('returns empty overrides when null', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ ttlOverrides: null })])

    const result = await service.getTTLOverrides()
    expect(result.overrides).toEqual({})
  })

  it('returns stored overrides', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ ttlOverrides: { sessions: 86400 } })])

    const result = await service.getTTLOverrides()
    expect(result.overrides).toHaveProperty('sessions')
  })
})

describe('SettingsService.updateTTLOverrides', () => {
  it('throws 400 for invalid TTL values', async () => {
    const { service } = setup()
    await expect(
      service.updateTTLOverrides({ sessions: -100 }),
    ).rejects.toMatchObject({ status: 400 })
  })
})

// ---------------------------------------------------------------------------
// getCleanupMetrics
// ---------------------------------------------------------------------------

describe('SettingsService.getCleanupMetrics', () => {
  it('returns empty metrics when null in DB', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeSettingsRow({ cleanupMetrics: null })])

    const result = await service.getCleanupMetrics()
    expect(result).toBeDefined()
  })

  it('returns stored metrics', async () => {
    const { db, service } = setup()
    const metrics = { lastRunAt: new Date().toISOString(), deletedSessions: 5, deletedChallenges: 2 }
    db.$setSelectResult([makeSettingsRow({ cleanupMetrics: metrics })])

    const result = await service.getCleanupMetrics()
    expect(result).toMatchObject(metrics)
  })
})

// ---------------------------------------------------------------------------
// archiveHub
// ---------------------------------------------------------------------------

describe('SettingsService.archiveHub', () => {
  it('throws 404 when hub not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.archiveHub('nonexistent')).rejects.toMatchObject({ status: 404 })
  })

  it('updates hub status to archived', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeHub()])

    const result = await service.archiveHub('hub-1')
    expect(result).toEqual({ ok: true })
    expect(db.update).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// deleteHub
// ---------------------------------------------------------------------------

describe('SettingsService.deleteHub', () => {
  it('throws 404 when hub not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.deleteHub('nonexistent')).rejects.toMatchObject({ status: 404 })
  })

  it('executes transaction to delete hub and cascade data', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeHub()])

    // deleteHub transaction uses execute, select, and delete — mock all
    const tx = {
      execute: vi.fn().mockResolvedValue([]),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }
    ;(db as any).transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx))

    const result = await service.deleteHub('hub-1')
    expect(result).toEqual({ ok: true })
    expect((db as any).transaction).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// runCleanup
// ---------------------------------------------------------------------------

describe('SettingsService.runCleanup', () => {
  it('deletes expired rate limit entries and returns metrics', async () => {
    const { db, service } = setup()
    const now = Date.now()
    const oldTs = now - 999_999_999 // far in the past — well beyond any TTL
    const recentTs = now - 1000 // 1 second ago — within TTL

    // Select sequence: getSettings → select rateLimits
    db.$setSelectResults([
      [makeSettingsRow({ ttlOverrides: null, cleanupMetrics: null })],
      [
        { key: 'stale-key', timestamps: [oldTs] },
        { key: 'active-key', timestamps: [recentTs] },
      ],
    ])
    db.$setDeleteResult([{ key: 'stale-key' }])

    const metrics = await service.runCleanup()

    expect(metrics.rateLimitEntriesDeleted).toBe(1)
    expect(db.delete).toHaveBeenCalled()
  })

  it('deletes expired CAPTCHA challenges', async () => {
    const { db, service } = setup()
    // Select: getSettings + empty rateLimits
    db.$setSelectResults([
      [makeSettingsRow({ ttlOverrides: null, cleanupMetrics: null })],
      [],
    ])
    db.$setDeleteResult([{ id: 'cap-1' }, { id: 'cap-2' }])

    const metrics = await service.runCleanup()

    expect(metrics.captchaChallengesDeleted).toBe(2)
  })

  it('preserves existing accumulated metrics from DB', async () => {
    const { db, service } = setup()
    const existing = {
      rateLimitEntriesDeleted: 10,
      captchaChallengesDeleted: 5,
      lastCleanupAt: '2024-01-01T00:00:00.000Z',
    }
    db.$setSelectResults([
      [makeSettingsRow({ cleanupMetrics: existing })],
      [],
    ])
    db.$setDeleteResult([{ id: 'cap-1' }])

    const metrics = await service.runCleanup()

    // Accumulated from existing + new
    expect(metrics.captchaChallengesDeleted).toBe(6)
    expect(metrics.rateLimitEntriesDeleted).toBe(10)
  })

  it('sets lastCleanupAt to a current ISO timestamp', async () => {
    const { db, service } = setup()
    const before = new Date().toISOString()
    db.$setSelectResults([
      [makeSettingsRow({ ttlOverrides: null, cleanupMetrics: null })],
      [],
    ])
    db.$setDeleteResult([])

    const metrics = await service.runCleanup()

    expect(metrics.lastCleanupAt).toBeDefined()
    expect(metrics.lastCleanupAt! >= before).toBe(true)
  })

  it('updates systemSettings with new metrics', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [makeSettingsRow({ ttlOverrides: null, cleanupMetrics: null })],
      [],
    ])
    db.$setDeleteResult([])

    await service.runCleanup()

    expect(db.update).toHaveBeenCalled()
  })

  it('rethrows database errors', async () => {
    const { db, service } = setup()
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      }),
    })

    await expect(service.runCleanup()).rejects.toThrow('DB connection failed')
  })
})
