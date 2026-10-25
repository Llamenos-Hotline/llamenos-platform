import { describe, it, expect } from 'vitest'
import type { DirectoryContact } from './api'
import { matchesContactQuery } from './contact-directory'

function contact(over: Partial<DirectoryContact>): DirectoryContact {
  return {
    id: 'c1',
    displayName: 'Maria Gonzalez',
    contactType: 'individual',
    tags: [],
    caseCount: 0,
    lastInteractionAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    canDecrypt: true,
    ...over,
  } as DirectoryContact
}

const maria = contact({
  identifiers: [
    { id: 'i1', type: 'phone', value: '+1 (555) 123-4567', isPrimary: true },
    { id: 'i2', type: 'email', value: 'maria@example.org', isPrimary: false },
  ],
  tags: ['bail-fund'],
})

describe('matchesContactQuery', () => {
  it('matches everything for an empty or blank query', () => {
    expect(matchesContactQuery(maria, '')).toBe(true)
    expect(matchesContactQuery(maria, '   ')).toBe(true)
  })

  it('matches the display name by substring, ignoring case and accents', () => {
    expect(matchesContactQuery(maria, 'gonz')).toBe(true)
    expect(matchesContactQuery(maria, 'MARIA')).toBe(true)
    expect(matchesContactQuery(contact({ displayName: 'José Núñez' }), 'jose nunez')).toBe(true)
    expect(matchesContactQuery(maria, 'carlos')).toBe(false)
  })

  it('requires every term to match, in any order', () => {
    expect(matchesContactQuery(maria, 'gonzalez maria')).toBe(true)
    expect(matchesContactQuery(maria, 'maria carlos')).toBe(false)
  })

  it('matches a phone number however it is punctuated', () => {
    for (const q of ['5551234567', '555-123-4567', '123-4567', '+15551234567', '1234567']) {
      expect(matchesContactQuery(maria, q), q).toBe(true)
    }
    expect(matchesContactQuery(maria, '5559999999')).toBe(false)
    expect(matchesContactQuery(contact({ identifiers: [] }), '5551234567')).toBe(false)
  })

  it('matches other identifiers and tags', () => {
    expect(matchesContactQuery(maria, 'example.org')).toBe(true)
    expect(matchesContactQuery(maria, 'bail')).toBe(true)
  })

  it('does not match short digit runs against a phone number', () => {
    // two digits would match half the directory; only 3+ digits count as a number
    expect(matchesContactQuery(contact({ identifiers: [{ id: 'i', type: 'phone', value: '+15551234567', isPrimary: true }], displayName: 'Zed' }), '99')).toBe(false)
  })
})
