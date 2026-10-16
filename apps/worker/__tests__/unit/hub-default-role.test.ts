/**
 * Which role a new hub member receives when nobody named one (#1446).
 *
 * `redeemInvite` used to substitute a hardcoded `role-volunteer`, which on a
 * crisis line means call-answering permission nobody chose. The replacement is
 * the hub template's `defaultMemberRole`, and the absence of one must grant
 * nothing rather than fall back.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveTemplateDefaultMemberRoles,
  resolveHubDefaultMemberRoles,
} from '@worker/lib/hub-default-role'
import type { CaseManagementTemplate } from '@protocol/template-types'

function template(id: string, defaultMemberRole?: string): CaseManagementTemplate {
  return {
    id,
    version: '1.0.0',
    name: id,
    description: '',
    author: 'test',
    tags: [],
    extends: [],
    labels: {},
    defaultChannels: [],
    providerDefaults: { a2pRequired: false, webrtcEnabled: false, sipTrunkEnabled: false },
    allowSubAccounts: false,
    channelGuidance: [],
    ...(defaultMemberRole ? { defaultMemberRole } : {}),
    entityTypes: [],
    relationshipTypes: [],
    reportTypes: [],
    suggestedRoles: [],
  } as unknown as CaseManagementTemplate
}

const roles = [
  { id: 'role-volunteer', slug: 'volunteer' },
  { id: 'role-cuid-abc', slug: 'jail-support-intake' },
]

describe('resolveTemplateDefaultMemberRoles', () => {
  it('grants nothing when no template is applied', () => {
    expect(resolveTemplateDefaultMemberRoles([], [template('general-hotline', 'volunteer')], roles))
      .toEqual([])
  })

  it('grants nothing when the applied template names no default', () => {
    expect(resolveTemplateDefaultMemberRoles(
      ['general-hotline'],
      [template('general-hotline')],
      roles,
    )).toEqual([])
  })

  it('resolves a default named by role id', () => {
    expect(resolveTemplateDefaultMemberRoles(
      ['general-hotline'],
      [template('general-hotline', 'role-volunteer')],
      roles,
    )).toEqual(['role-volunteer'])
  })

  it('resolves a default named by slug, as template suggestedRoles are', () => {
    expect(resolveTemplateDefaultMemberRoles(
      ['jail-support'],
      [template('jail-support', 'jail-support-intake')],
      roles,
    )).toEqual(['role-cuid-abc'])
  })

  it('grants nothing when the named role does not exist on this deployment', () => {
    // A dangling role id in hubRoles would grant no permissions anyway, and
    // would be indistinguishable from a typo on inspection.
    expect(resolveTemplateDefaultMemberRoles(
      ['jail-support'],
      [template('jail-support', 'role-that-was-never-created')],
      roles,
    )).toEqual([])
  })

  it('ignores templates that are not applied', () => {
    expect(resolveTemplateDefaultMemberRoles(
      ['general-hotline'],
      [template('general-hotline'), template('jail-support', 'volunteer')],
      roles,
    )).toEqual([])
  })
})

describe('resolveHubDefaultMemberRoles', () => {
  it('grants nothing when the server has applied no template', async () => {
    const deps = {
      getAppliedTemplates: async () => ({ appliedTemplates: [] }),
      getRoles: async () => ({ roles }),
    }
    await expect(resolveHubDefaultMemberRoles(deps, 'hub-1')).resolves.toEqual([])
  })

  it('tolerates applied-template records that are not the expected shape', async () => {
    // appliedTemplates is untyped JSONB; a malformed row must not throw on the
    // invite-creation path.
    const deps = {
      getAppliedTemplates: async () => ({ appliedTemplates: [null, 'oops', { noTemplateId: 1 }] }),
      getRoles: async () => ({ roles }),
    }
    await expect(resolveHubDefaultMemberRoles(deps, 'hub-1')).resolves.toEqual([])
  })

  it('grants nothing when no bundled template names a default', async () => {
    // Asserted against the SHIPPED templates, not a fixture: none of them
    // declares defaultMemberRole yet, so "no role unless chosen" is the live
    // behaviour this pins (#1446).
    const deps = {
      getAppliedTemplates: async () => ({ appliedTemplates: [{ templateId: 'general-hotline' }] }),
      getRoles: async () => ({ roles }),
    }
    await expect(resolveHubDefaultMemberRoles(deps, 'hub-1')).resolves.toEqual([])
  })
})
