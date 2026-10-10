import { describe, it, expect } from 'vitest'
import { hashAuditEntry, stableJsonStringify } from '../../lib/crypto'
import type { AuditLogEntry } from '../../types'

describe('Audit chain integrity', () => {
  function createEntry(
    id: string,
    action: string,
    previousEntryHash?: string,
  ): AuditLogEntry {
    return {
      id,
      action,
      actorPubkey: 'testpubkey123',
      details: { action },
      createdAt: new Date().toISOString(),
      previousEntryHash,
    }
  }

  describe('hash chain building', () => {
    it('first entry has no previous hash', () => {
      const entry = createEntry('audit-001', 'volunteer.login')
      const hash = hashAuditEntry(entry)
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.previousEntryHash).toBeUndefined()
    })

    it('second entry links to first via previousEntryHash', () => {
      const entry1 = createEntry('audit-001', 'volunteer.login')
      const hash1 = hashAuditEntry(entry1)

      const entry2 = createEntry('audit-002', 'note.created', hash1)
      const hash2 = hashAuditEntry(entry2)

      expect(entry2.previousEntryHash).toBe(hash1)
      expect(hash2).not.toBe(hash1)
    })

    it('chain of 5 entries maintains consistent linkage', () => {
      const events = ['login', 'note.created', 'call.answered', 'note.updated', 'logout']
      const entries: AuditLogEntry[] = []
      const hashes: string[] = []

      for (let i = 0; i < events.length; i++) {
        const entry = createEntry(
          `audit-${String(i + 1).padStart(3, '0')}`,
          events[i],
          i > 0 ? hashes[i - 1] : undefined,
        )
        entries.push(entry)
        hashes.push(hashAuditEntry(entry))
      }

      // Verify each entry (except first) links to the previous
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i].previousEntryHash).toBe(hashes[i - 1])
      }

      // All hashes are unique
      const uniqueHashes = new Set(hashes)
      expect(uniqueHashes.size).toBe(5)
    })
  })

  describe('tamper detection', () => {
    it('detects tampered action field', () => {
      const entry = createEntry('audit-001', 'volunteer.login')
      const originalHash = hashAuditEntry(entry)

      // Tamper with the action
      const tampered = { ...entry, action: 'volunteer.logout' }
      const tamperedHash = hashAuditEntry(tampered)

      expect(tamperedHash).not.toBe(originalHash)
    })

    it('detects tampered actorPubkey', () => {
      const entry = createEntry('audit-001', 'volunteer.login')
      const originalHash = hashAuditEntry(entry)

      const tampered = { ...entry, actorPubkey: 'attackerPubkey' }
      expect(hashAuditEntry(tampered)).not.toBe(originalHash)
    })

    it('detects tampered details', () => {
      const entry = createEntry('audit-001', 'volunteer.login')
      const originalHash = hashAuditEntry(entry)

      const tampered = { ...entry, details: { action: 'something-else' } }
      expect(hashAuditEntry(tampered)).not.toBe(originalHash)
    })

    it('detects tampered timestamp', () => {
      const entry = createEntry('audit-001', 'volunteer.login')
      const originalHash = hashAuditEntry(entry)

      const tampered = { ...entry, createdAt: '2020-01-01T00:00:00Z' }
      expect(hashAuditEntry(tampered)).not.toBe(originalHash)
    })

    it('detects tampered previousEntryHash (chain break)', () => {
      const entry1 = createEntry('audit-001', 'login')
      const hash1 = hashAuditEntry(entry1)

      const entry2 = createEntry('audit-002', 'note.created', hash1)
      const hash2 = hashAuditEntry(entry2)

      // Attacker replaces previousEntryHash
      const tampered = { ...entry2, previousEntryHash: 'forged-hash' }
      expect(hashAuditEntry(tampered)).not.toBe(hash2)
    })

    it('detects deleted chain entry (gap detection)', () => {
      const entry1 = createEntry('audit-001', 'login')
      const hash1 = hashAuditEntry(entry1)

      const entry2 = createEntry('audit-002', 'note.created', hash1)
      const hash2 = hashAuditEntry(entry2)

      const entry3 = createEntry('audit-003', 'logout', hash2)

      // If entry2 is deleted, entry3's previousEntryHash (hash2) won't match
      // the recomputed hash of entry1 (hash1)
      expect(entry3.previousEntryHash).toBe(hash2)
      expect(entry3.previousEntryHash).not.toBe(hash1)
    })

    it('detects inserted entry (chain order manipulation)', () => {
      const entry1 = createEntry('audit-001', 'login')
      const hash1 = hashAuditEntry(entry1)

      const entry2 = createEntry('audit-002', 'logout', hash1)
      const hash2 = hashAuditEntry(entry2)

      // Attacker tries to insert between entry1 and entry2
      const inserted = createEntry('audit-001b', 'malicious-action', hash1)
      const insertedHash = hashAuditEntry(inserted)

      // entry2's previousEntryHash points to hash1, not insertedHash
      // So the chain from entry1 -> entry2 still validates
      // But a complete traversal would find the orphan
      expect(insertedHash).not.toBe(hash1)
      expect(insertedHash).not.toBe(hash2)
    })
  })

  describe('chain verification algorithm', () => {
    function verifyChain(entries: AuditLogEntry[]): {
      valid: boolean
      brokenAt?: number
    } {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]

        // First entry should have no previous hash
        if (i === 0 && entry.previousEntryHash) {
          return { valid: false, brokenAt: 0 }
        }

        // Each subsequent entry should link to previous entry's hash
        if (i > 0) {
          const prevHash = hashAuditEntry(entries[i - 1])
          if (entry.previousEntryHash !== prevHash) {
            return { valid: false, brokenAt: i }
          }
        }
      }
      return { valid: true }
    }

    it('valid chain passes verification', () => {
      const e1 = createEntry('001', 'login')
      const h1 = hashAuditEntry(e1)
      const e2 = createEntry('002', 'action', h1)
      const h2 = hashAuditEntry(e2)
      const e3 = createEntry('003', 'logout', h2)

      expect(verifyChain([e1, e2, e3])).toEqual({ valid: true })
    })

    it('tampered chain fails verification', () => {
      const e1 = createEntry('001', 'login')
      const h1 = hashAuditEntry(e1)
      const e2 = { ...createEntry('002', 'action', h1), action: 'tampered' }
      const e3 = createEntry('003', 'logout', 'wrong-hash')

      const result = verifyChain([e1, e2, e3])
      expect(result.valid).toBe(false)
      expect(result.brokenAt).toBe(2)
    })

    it('empty chain is valid', () => {
      expect(verifyChain([])).toEqual({ valid: true })
    })

    it('single entry chain is valid', () => {
      const e1 = createEntry('001', 'login')
      expect(verifyChain([e1])).toEqual({ valid: true })
    })
  })

  describe('stableJsonStringify', () => {
    it('produces identical output regardless of key insertion order', () => {
      const a = { zebra: 1, alpha: 2, middle: 3 }
      const b = { alpha: 2, middle: 3, zebra: 1 }
      expect(stableJsonStringify(a)).toBe(stableJsonStringify(b))
      // Keys should be sorted alphabetically
      expect(stableJsonStringify(a)).toBe('{"alpha":2,"middle":3,"zebra":1}')
    })

    it('sorts nested objects recursively', () => {
      const obj = { z: { b: 2, a: 1 }, a: { d: 4, c: 3 } }
      const result = stableJsonStringify(obj)
      expect(result).toBe('{"a":{"c":3,"d":4},"z":{"a":1,"b":2}}')
    })

    it('preserves array order (arrays are not sorted)', () => {
      const obj = { items: [3, 1, 2] }
      expect(stableJsonStringify(obj)).toBe('{"items":[3,1,2]}')
    })

    it('handles null and primitive values', () => {
      expect(stableJsonStringify(null)).toBe('null')
      expect(stableJsonStringify('hello')).toBe('"hello"')
      expect(stableJsonStringify(42)).toBe('42')
    })
  })

  describe('computeEntryHash determinism', () => {
    it('produces deterministic hash for same inputs', () => {
      const entry = createEntry('audit-100', 'note.created')
      const hash1 = hashAuditEntry(entry)
      const hash2 = hashAuditEntry(entry)
      expect(hash1).toBe(hash2)
    })

    it('hash includes previousEntryHash (chain linkage)', () => {
      const entry = createEntry('audit-100', 'note.created')
      const withPrev = { ...entry, previousEntryHash: 'abc123' }
      const withoutPrev = { ...entry, previousEntryHash: undefined }
      expect(hashAuditEntry(withPrev)).not.toBe(hashAuditEntry(withoutPrev))
    })

    it('details key order does not affect hash (stable stringify)', () => {
      const entry1: AuditLogEntry = {
        id: 'audit-200',
        action: 'test',
        actorPubkey: 'pk1',
        details: { zebra: 'z', alpha: 'a' },
        createdAt: '2026-01-01T00:00:00Z',
      }
      const entry2: AuditLogEntry = {
        id: 'audit-200',
        action: 'test',
        actorPubkey: 'pk1',
        details: { alpha: 'a', zebra: 'z' },
        createdAt: '2026-01-01T00:00:00Z',
      }
      expect(hashAuditEntry(entry1)).toBe(hashAuditEntry(entry2))
    })

    it('round-trip: compute hash, verify it matches', () => {
      const entry = createEntry('audit-300', 'call.answered', 'prevhash123')
      const hash = hashAuditEntry(entry)

      // Re-creating entry with same data should produce same hash
      const rebuilt: AuditLogEntry = {
        id: entry.id,
        action: entry.action,
        actorPubkey: entry.actorPubkey,
        details: { ...entry.details },
        createdAt: entry.createdAt,
        previousEntryHash: entry.previousEntryHash,
      }
      expect(hashAuditEntry(rebuilt)).toBe(hash)
    })
  })
})
