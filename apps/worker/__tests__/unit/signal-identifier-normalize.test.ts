import { describe, it, expect } from 'vitest'
import { normalizeSignalIdentifier } from '@worker/services/signal-identifier-normalize'

describe('normalizeSignalIdentifier', () => {
  describe('phone type', () => {
    it('strips spaces, dashes, parentheses, and dots', () => {
      expect(normalizeSignalIdentifier('+1 555 123 4567', 'phone')).toBe('+15551234567')
      expect(normalizeSignalIdentifier('+1-555-123-4567', 'phone')).toBe('+15551234567')
      expect(normalizeSignalIdentifier('+1 (555) 123-4567', 'phone')).toBe('+15551234567')
      expect(normalizeSignalIdentifier('+1.555.123.4567', 'phone')).toBe('+15551234567')
    })

    it('preserves existing + prefix', () => {
      expect(normalizeSignalIdentifier('+15551234567', 'phone')).toBe('+15551234567')
    })

    it('adds + prefix if missing', () => {
      expect(normalizeSignalIdentifier('15551234567', 'phone')).toBe('+15551234567')
      expect(normalizeSignalIdentifier('5551234567', 'phone')).toBe('+5551234567')
    })

    it('handles international formats', () => {
      expect(normalizeSignalIdentifier('+44 20 7123 4567', 'phone')).toBe('+442071234567')
      expect(normalizeSignalIdentifier('+86 139 1234 5678', 'phone')).toBe('+8613912345678')
      expect(normalizeSignalIdentifier('+33 1 23 45 67 89', 'phone')).toBe('+33123456789')
    })

    it('handles edge cases', () => {
      expect(normalizeSignalIdentifier('+', 'phone')).toBe('+')
      expect(normalizeSignalIdentifier('123', 'phone')).toBe('+123')
      expect(normalizeSignalIdentifier('', 'phone')).toBe('+')
    })
  })

  describe('username type', () => {
    it('lowercases usernames', () => {
      expect(normalizeSignalIdentifier('AliceSmith', 'username')).toBe('alicesmith')
      expect(normalizeSignalIdentifier('BOB_JONES', 'username')).toBe('bob_jones')
    })

    it('strips leading @', () => {
      expect(normalizeSignalIdentifier('@alice', 'username')).toBe('alice')
      expect(normalizeSignalIdentifier('@AliceSmith', 'username')).toBe('alicesmith')
    })

    it('preserves usernames without @', () => {
      expect(normalizeSignalIdentifier('alice', 'username')).toBe('alice')
    })

    it('handles empty string', () => {
      expect(normalizeSignalIdentifier('', 'username')).toBe('')
    })
  })
})
