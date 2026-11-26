/**
 * What the desktop client sends must survive the validator that guards the route.
 *
 * Each case here is a drift the api-schema-binding report found between a client in
 * `src/client/lib/api/**` and the schema its route validates: the validator is a
 * `z.object`, so a field it does not declare is STRIPPED without an error and the
 * write silently does nothing (or, for a mistyped field, the request is refused).
 * The schemas under test are the ones the client now derives its types from, so
 * widening one without the other can no longer drift quietly.
 */
import { describe, it, expect } from 'vitest'
import {
  setupStateSchema,
  createReportTypeBodySchema,
  updateReportTypeBodySchema,
  messagingConfigSchema,
  customFieldDefinitionSchema,
} from '@protocol/schemas/settings'
import { updateBlastSettingsBodySchema, blastSettingsResponseSchema } from '@protocol/schemas/blasts'
import { updateRetentionBodySchema } from '@protocol/schemas/retention'
import { adminUpdateUserBodySchema } from '@protocol/schemas/users'

const field = {
  id: 'f1',
  name: 'severity',
  label: 'Severity',
  type: 'select' as const,
  required: true,
  options: ['low', 'high'],
  visibleToUsers: true,
  editableByUsers: true,
  context: 'reports' as const,
  order: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('setup wizard state (PATCH /setup/state)', () => {
  it('keeps the channels and steps the wizard saves', () => {
    const sent = { selectedChannels: ['sms', 'signal', 'reports'], completedSteps: ['0', '1'] }
    expect(setupStateSchema.parse(sent)).toEqual(sent)
  })
})

describe('blast settings (PATCH /blasts/settings)', () => {
  it('keeps the opt-out footer and the sending rate the settings panel edits', () => {
    const sent = { optOutFooter: '\nReply STOP', rateLimitPerSecond: 5 }
    expect(updateBlastSettingsBodySchema.parse(sent)).toEqual(sent)
  })

  it('answers every setting, so a reader never meets an absent one', () => {
    expect(() => blastSettingsResponseSchema.parse({ subscribeKeyword: 'JOIN' })).toThrow()
  })
})

describe('report types (POST/PATCH /settings/report-types)', () => {
  it('accepts the custom field definitions a report type collects, and its default flag', () => {
    const sent = { name: 'Incident', fields: [field], isDefault: true }
    expect(createReportTypeBodySchema.parse(sent)).toEqual(sent)
    expect(updateReportTypeBodySchema.parse({ fields: [field], isDefault: false })).toEqual({ fields: [field], isDefault: false })
  })

  it('refuses a field that is not a definition', () => {
    expect(() => createReportTypeBodySchema.parse({ name: 'Incident', fields: ['severity'] })).toThrow()
    expect(customFieldDefinitionSchema.safeParse(field).success).toBe(true)
  })
})

describe('retention (PATCH /retention)', () => {
  it('takes a list of settings, not one setting', () => {
    expect(updateRetentionBodySchema.safeParse({ settings: [{ category: 'notes', retentionDays: 90 }] }).success).toBe(true)
    expect(updateRetentionBodySchema.safeParse({ category: 'notes', retentionDays: 90 }).success).toBe(false)
  })
})

describe('messaging config (PATCH /settings/messaging)', () => {
  it('keeps each channel as the channel sections edit it, and never needs a stored secret to be re-sent', () => {
    const sent = {
      enabledChannels: ['signal'],
      signal: { bridgeUrl: 'https://bridge.internal', registeredNumber: '+15551234567', trustMode: 'tofu' },
    }
    const parsed = messagingConfigSchema.parse(sent)
    expect(parsed.signal).toEqual(sent.signal)
  })

  it('reads a redacted response: secrets absent, their `Set` flags present', () => {
    const redacted = {
      telegram: { enabled: true, botTokenSet: true, webhookSecretSet: false },
    }
    expect(messagingConfigSchema.parse(redacted).telegram).toEqual(redacted.telegram)
  })
})

describe('admin user update (PATCH /users/:pubkey)', () => {
  it('only offers the channels a user may support', () => {
    expect(adminUpdateUserBodySchema.safeParse({ supportedMessagingChannels: ['sms', 'telegram'] }).success).toBe(true)
    expect(adminUpdateUserBodySchema.safeParse({ supportedMessagingChannels: ['web'] }).success).toBe(false)
  })
})
