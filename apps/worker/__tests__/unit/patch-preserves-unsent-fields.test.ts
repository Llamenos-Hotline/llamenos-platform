import { describe, it, expect, vi } from 'vitest'
import { updateRecordBodySchema } from '@protocol/schemas/records'
import { updatePlatformSettingsBodySchema } from '@protocol/schemas/platform-settings'
import { CasesService } from '../../services/cases'
import { SettingsService } from '../../services/settings'

/**
 * Issue #1643 — a PATCH must write only what the client sent.
 *
 * These drive the real chain the routes use: the body schema the route
 * validates with, then the service that turns the parsed body into a write.
 * Asserting on the schema alone would not show that the defaults reach a
 * column, and asserting on the service alone would miss the schema that
 * invents the values.
 */

function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'case-1',
    hubId: 'hub-1',
    entityTypeId: 'et-incident',
    caseNumber: null,
    statusHash: 'hash-open',
    severityHash: null,
    categoryHash: null,
    assignedTo: ['pk-volunteer'],
    blindIndexes: { phone: 'hmac-phone', name: ['hmac-a', 'hmac-b'] },
    encryptedSummary: 'enc-summary',
    summaryEnvelopes: [{ pubkey: 'pk-admin', enc: 'b'.repeat(64), ct: 'wk1' }],
    encryptedFields: null,
    fieldEnvelopes: null,
    encryptedPii: null,
    piiEnvelopes: null,
    contactCount: 0,
    interactionCount: 0,
    fileCount: 0,
    reportCount: 0,
    eventIds: [],
    reportIds: [],
    parentRecordId: null,
    closedAt: null,
    createdBy: 'pk-author',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  }
}

/** A CasesService whose UPDATE ... SET values are captured instead of written. */
function casesServiceCapturingSet() {
  const existing = caseRow()
  const setValues = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([existing]),
    }),
  })
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([existing]),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({ set: setValues }),
  }
  return { service: new CasesService(db as never), setValues }
}

describe('PATCH /api/records/:id — unsent fields are untouched (#1643)', () => {
  it('writes only statusHash when only statusHash was sent', async () => {
    const { service, setValues } = casesServiceCapturingSet()

    const body = updateRecordBodySchema.parse({ statusHash: 'hash-closed' })
    expect(body).toEqual({ statusHash: 'hash-closed' })

    await service.update('case-1', { ...body, authorPubkey: 'pk-author' })

    const written = setValues.mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(written).sort()).toEqual(['interactionCount', 'statusHash', 'updatedAt'])
    expect(written).not.toHaveProperty('assignedTo')
    expect(written).not.toHaveProperty('blindIndexes')
  })

  it('still clears assignedTo when the client sends it explicitly', async () => {
    const { service, setValues } = casesServiceCapturingSet()

    const body = updateRecordBodySchema.parse({ statusHash: 'hash-closed', assignedTo: [] })
    expect(body).toEqual({ statusHash: 'hash-closed', assignedTo: [] })

    await service.update('case-1', { ...body, authorPubkey: 'pk-author' })

    const written = setValues.mock.calls[0][0] as Record<string, unknown>
    expect(written.assignedTo).toEqual([])
  })

  it('still replaces blindIndexes when the client sends them', async () => {
    const { service, setValues } = casesServiceCapturingSet()

    const body = updateRecordBodySchema.parse({ blindIndexes: { phone: 'hmac-new' } })
    await service.update('case-1', { ...body, authorPubkey: 'pk-author' })

    const written = setValues.mock.calls[0][0] as Record<string, unknown>
    expect(written.blindIndexes).toEqual({ phone: 'hmac-new' })
    expect(written).not.toHaveProperty('assignedTo')
  })
})

describe('PATCH platform settings — sibling fields are untouched (#1643)', () => {
  /** A SettingsService whose stored platform settings are captured, not written. */
  function settingsServiceCapturingSet(stored: Record<string, unknown>) {
    const setValues = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    })
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ platformSettings: stored }]),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({ set: setValues }),
    }
    return { service: new SettingsService(db as never), setValues }
  }

  const operatorSettings = {
    featureFlags: {
      mlsEnabled: false,
      transcriptionEnabled: false,
      caseManagementEnabled: true,
      crossHubSharingEnabled: true,
    },
    sessionPolicy: { maxSessionDurationHours: 8, maxInactiveHours: 1 },
    retentionPurge: { cronHourUtc: 11, enabled: false },
    branding: {
      instanceName: 'Hotline',
      supportEmail: 'support@example.invalid',
      privacyPolicyUrl: 'https://example.invalid/privacy',
    },
    erasurePlatformFloor: { minDelayHours: 72 },
  }

  it('changing one feature flag leaves the other three as the operator set them', async () => {
    const { service, setValues } = settingsServiceCapturingSet(operatorSettings)

    const body = updatePlatformSettingsBodySchema.parse({ featureFlags: { mlsEnabled: true } })
    expect(body).toEqual({ featureFlags: { mlsEnabled: true } })

    const merged = await service.updatePlatformSettings(body as Record<string, unknown>)

    expect(merged.featureFlags).toEqual({
      mlsEnabled: true,
      transcriptionEnabled: false,
      caseManagementEnabled: true,
      crossHubSharingEnabled: true,
    })
    expect(setValues).toHaveBeenCalledWith({ platformSettings: merged })
  })

  it('changing one session-policy field does not reset the other to the 30-day default', async () => {
    const { service } = settingsServiceCapturingSet(operatorSettings)

    const body = updatePlatformSettingsBodySchema.parse({ sessionPolicy: { maxInactiveHours: 2 } })
    const merged = await service.updatePlatformSettings(body as Record<string, unknown>)

    expect(merged.sessionPolicy).toEqual({ maxSessionDurationHours: 8, maxInactiveHours: 2 })
  })

  it('changing the purge hour does not re-enable scheduled purging', async () => {
    const { service } = settingsServiceCapturingSet(operatorSettings)

    const body = updatePlatformSettingsBodySchema.parse({ retentionPurge: { cronHourUtc: 5 } })
    const merged = await service.updatePlatformSettings(body as Record<string, unknown>)

    expect(merged.retentionPurge).toEqual({ cronHourUtc: 5, enabled: false })
  })

  it('renaming the instance does not blank the support and privacy contacts', async () => {
    const { service } = settingsServiceCapturingSet(operatorSettings)

    const body = updatePlatformSettingsBodySchema.parse({ branding: { instanceName: 'Renamed' } })
    const merged = await service.updatePlatformSettings(body as Record<string, unknown>)

    expect(merged.branding).toEqual({
      instanceName: 'Renamed',
      supportEmail: 'support@example.invalid',
      privacyPolicyUrl: 'https://example.invalid/privacy',
    })
  })

  it('an empty erasure-floor section does not reset the operator floor', async () => {
    const { service } = settingsServiceCapturingSet(operatorSettings)

    const body = updatePlatformSettingsBodySchema.parse({ erasurePlatformFloor: {} })
    const merged = await service.updatePlatformSettings(body as Record<string, unknown>)

    expect(merged.erasurePlatformFloor).toEqual({ minDelayHours: 72 })
  })
})
