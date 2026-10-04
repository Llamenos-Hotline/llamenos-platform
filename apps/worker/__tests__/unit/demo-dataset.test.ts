import { describe, it, expect, vi } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hpkeOpen, symmetricDecrypt } from '@llamenos/crypto/ffi'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_CALL_META, LABEL_DEVICE_ENCRYPTION_SEED, LABEL_NOTE_KEY } from '@shared/crypto-labels'
import { DEMO_ACCOUNTS } from '@shared/demo-accounts'
import {
  DEMO_CALLS, DEMO_CASES, DEMO_CONTACTS, DEMO_CONVERSATIONS, DEMO_HUB, DEMO_SHIFTS,
} from '@worker/lib/demo-dataset'
import { demoIdentities, demoIdentityByName } from '@worker/lib/demo-identities'
import { demoReader, deriveDemoEncryptionPubkey, sealForReaders } from '@worker/lib/demo-crypto'
import { seedDemoDataset } from '@worker/services/demo-seeder'
import type { Services } from '@worker/services'

const NO_AAD = new Uint8Array(0)

/** Demo identities exist only on a development server — the one environment these tests model. */
const DEV_SERVER = { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true' } as const

const seedHexToEd25519Pubkey = (seedHex: string): string => bytesToHex(ed25519.getPublicKey(hexToBytes(seedHex)))

/** Open a sealed item the way a demo account's device would: derive its X25519 secret, open the key wrap, decrypt. */
function openAs(name: string, encryptedContent: string, envelope: { enc: string; ct: string }, label: string): string {
  const identity = demoIdentityByName(DEV_SERVER, name)
  const encSecret = hkdf(sha256, hexToBytes(identity.seedHex), new Uint8Array(0), utf8ToBytes(LABEL_DEVICE_ENCRYPTION_SEED), 32)
  const wrapped = new Uint8Array([...hexToBytes(envelope.enc), ...Buffer.from(envelope.ct, 'base64url')])
  const contentKey = hpkeOpen(encSecret, wrapped, utf8ToBytes(label), NO_AAD)
  return new TextDecoder().decode(symmetricDecrypt(contentKey, hexToBytes(encryptedContent), NO_AAD))
}

describe('demo dataset content', () => {
  it('has the documented shape', () => {
    expect(DEMO_CALLS).toHaveLength(12)
    expect(DEMO_CALLS.filter(c => c.note).length).toBeGreaterThanOrEqual(7) // "notes on most"
    expect(DEMO_CONTACTS).toHaveLength(8)
    expect(DEMO_CASES).toHaveLength(2)
    expect(new Set(DEMO_CALLS.map(c => c.key)).size).toBe(DEMO_CALLS.length)
  })

  it('spans a fortnight', () => {
    const oldest = Math.max(...DEMO_CALLS.map(c => c.hoursAgo))
    expect(oldest).toBeGreaterThan(24 * 12)
    expect(oldest).toBeLessThanOrEqual(24 * 14)
  })

  it('only unanswered calls lack an answerer, and only answered calls carry notes', () => {
    for (const call of DEMO_CALLS) {
      if (call.answeredBy === null) expect(call.note).toBeUndefined()
      if (call.note) expect(call.answeredBy).not.toBeNull()
    }
  })

  it('is obviously fictional: reserved 555-01xx numbers, no real-looking identifiers', () => {
    const fictionalPhone = /^\+155555501\d\d$/
    for (const contact of DEMO_CONTACTS) expect(contact.phone).toMatch(fictionalPhone)
    for (const call of DEMO_CALLS) expect(call.callerLast4).toMatch(/^01\d\d$/)
    for (const conv of Object.values(DEMO_CONVERSATIONS)) {
      if (conv.sender.startsWith('+')) expect(conv.sender).toMatch(fictionalPhone)
    }
    const prose = [
      ...DEMO_CALLS.map(c => c.note ?? ''),
      ...Object.values(DEMO_CONVERSATIONS).flatMap(c => c.messages.map(m => m.text)),
      ...DEMO_CASES.flatMap(c => [c.title, c.description, ...c.timeline.map(t => (t.kind === 'comment' ? t.text : ''))]),
      DEMO_HUB.description,
    ].join('\n')
    expect(prose).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i) // no email addresses
    expect(prose).not.toMatch(/\d{3}[-. ]\d{3}[-. ]\d{4}/) // no phone numbers
  })

  it('every case links known contacts and notes that exist', () => {
    const contactKeys = new Set(DEMO_CONTACTS.map(c => c.key))
    const notedCalls = new Set(DEMO_CALLS.filter(c => c.note).map(c => c.key))
    for (const demoCase of DEMO_CASES) {
      for (const key of demoCase.contacts) expect(contactKeys.has(key)).toBe(true)
      for (const step of demoCase.timeline) {
        if (step.kind === 'note') expect(notedCalls.has(step.noteOfCall)).toBe(true)
      }
      const hours = demoCase.timeline.map(t => t.hoursAgo)
      expect(hours).toEqual([...hours].sort((a, b) => b - a)) // oldest first
    }
  })

  it('schedules every UTC hour of every day, with the demo volunteer always on shift', () => {
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const time = `${String(hour).padStart(2, '0')}:00`
        const covering = DEMO_SHIFTS.filter((s) => {
          if (!s.days.includes(day)) return false
          return s.startTime < s.endTime ? time >= s.startTime && time < s.endTime : time >= s.startTime || time < s.endTime
        })
        expect(covering.length, `day ${day} ${time}`).toBeGreaterThan(0)
        expect(covering.some(s => s.volunteers.includes('james')), `james on ${day} ${time}`).toBe(true)
      }
    }
  })
})

describe('demo identities', () => {
  it('derive one distinct signing pubkey per shared demo account, from the account seed', () => {
    const identities = demoIdentities(DEV_SERVER)
    expect(identities).toHaveLength(DEMO_ACCOUNTS.length)
    expect(new Set(identities.map(i => i.pubkey)).size).toBe(identities.length)
    for (const identity of identities) {
      expect(identity.pubkey).toMatch(/^[0-9a-f]{64}$/)
      expect(identity.pubkey).toBe(seedHexToEd25519Pubkey(identity.seedHex))
    }
    expect(identities.map(i => i.listedPubkey)).toEqual(DEMO_ACCOUNTS.map(a => a.pubkey))
  })

  it('are generated once per process and stay stable within it', () => {
    expect(demoIdentities(DEV_SERVER)).toBe(demoIdentities(DEV_SERVER))
  })
})

describe('sealForReaders', () => {
  it('produces the desktop wire format and each reader can open it', () => {
    const [maria, admin] = [demoReader(demoIdentityByName(DEV_SERVER, 'Maria Santos')), demoReader(demoIdentityByName(DEV_SERVER, 'Demo Admin'))]
    const sealed = sealForReaders('hello demo', [maria, admin], LABEL_NOTE_KEY)

    expect(sealed.encryptedContent).toMatch(/^[0-9a-f]+$/)
    expect(sealed.envelopes.map(e => e.pubkey)).toEqual([maria.pubkey, admin.pubkey])
    for (const envelope of sealed.envelopes) {
      expect(envelope.enc).toMatch(/^[0-9a-f]{64}$/)
      expect(envelope.ct).toMatch(/^[A-Za-z0-9_-]+$/) // base64url, no padding
    }
    expect(openAs('Maria Santos', sealed.encryptedContent, sealed.envelopes[0], LABEL_NOTE_KEY)).toBe('hello demo')
    expect(openAs('Demo Admin', sealed.encryptedContent, sealed.envelopes[1], LABEL_NOTE_KEY)).toBe('hello demo')
  })

  it('does not open under a different label (domain separation)', () => {
    const admin = demoReader(demoIdentityByName(DEV_SERVER, 'Demo Admin'))
    const sealed = sealForReaders('secret', [admin], LABEL_NOTE_KEY)
    expect(() => openAs('Demo Admin', sealed.encryptedContent, sealed.envelopes[0], LABEL_CALL_META)).toThrow()
  })

  it('seals to the X25519 key the client derives from the signing seed', () => {
    const identity = demoIdentityByName(DEV_SERVER, 'James Chen')
    expect(demoReader(identity).encryptionPubkey).toBe(deriveDemoEncryptionPubkey(identity.seedHex))
    expect(demoReader(identity).encryptionPubkey).not.toBe(identity.pubkey)
  })
})

describe('seedDemoDataset', () => {
  function stubServices() {
    const calls: string[] = []
    const track = <T>(name: string, value: T) => vi.fn(async (..._args: unknown[]) => { calls.push(name); return value })
    let n = 0
    const id = () => `id-${++n}`
    const users = new Set(demoIdentities(DEV_SERVER).map(i => i.pubkey))
    const services = {
      settings: {
        ensureInit: track('settings.ensureInit', undefined),
        purgeHub: track('settings.purgeHub', { ok: true }),
        createHub: track('settings.createHub', undefined),
        setCaseManagementEnabled: track('settings.setCaseManagementEnabled', undefined),
        createEntityType: vi.fn(async () => ({ id: 'entity-type-1' })),
        generateCaseNumber: vi.fn(async () => ({ number: 'DEMO-2026-0001', sequence: 1 })),
        getEnabledChannels: vi.fn(async () => ({ sms: true, whatsapp: false, signal: true, rcs: false, telegram: false })),
      },
      identity: {
        getUserInternal: vi.fn(async (pubkey: string) => (users.has(pubkey) ? { pubkey } : null)),
        ensureDemoAccounts: track('identity.ensureDemoAccounts', undefined),
        setHubRole: vi.fn(async () => ({})),
      },
      shifts: { create: vi.fn(async () => ({ id: id() })) },
      calls: { recordHistoricalCall: vi.fn(async () => ({})) },
      records: { createNote: vi.fn(async () => ({ id: id() })) },
      contacts: { create: vi.fn(async () => ({ id: id() })) },
      cases: {
        create: vi.fn(async () => ({ id: id() })),
        createInteraction: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
      conversations: {
        create: vi.fn(async () => ({ id: id() })),
        setContactIdentifier: vi.fn(async () => undefined),
        addMessage: vi.fn(async () => ({})),
      },
      audit: { log: vi.fn(async (..._args: unknown[]) => ({})) },
    }
    return { services: services as unknown as Services, stubs: services, calls }
  }
  const ENV = { ...DEV_SERVER, HMAC_SECRET: 'a'.repeat(64) } // gitleaks:allow
  const NOW = new Date('2026-09-26T12:00:00.000Z')

  it('replaces the previous demo hub before rebuilding it', async () => {
    const { services, stubs, calls } = stubServices()
    await seedDemoDataset(services, ENV, NOW)
    expect(stubs.settings.purgeHub).toHaveBeenCalledWith(DEMO_HUB.id)
    expect(calls.indexOf('settings.purgeHub')).toBeLessThan(calls.indexOf('settings.createHub'))
    // accounts removed by the purge are restored before memberships are assigned
    expect(calls.indexOf('identity.ensureDemoAccounts')).toBeGreaterThan(calls.indexOf('settings.purgeHub'))
    expect(calls.indexOf('identity.ensureDemoAccounts')).toBeLessThan(calls.indexOf('settings.createHub'))
  })

  it('seeds the fixed counts, one conversation per enabled channel, and reports them', async () => {
    const { services, stubs } = stubServices()
    const summary = await seedDemoDataset(services, ENV, NOW)
    expect(summary).toMatchObject({ hubId: DEMO_HUB.id, shifts: 3, calls: 12, notes: DEMO_CALLS.filter(c => c.note).length, contacts: 8, cases: 2, conversations: 2 })
    expect(stubs.calls.recordHistoricalCall).toHaveBeenCalledTimes(12)
    expect(stubs.conversations.create).toHaveBeenCalledTimes(2) // sms + signal enabled
    expect(summary.auditEntries).toBe(stubs.audit.log.mock.calls.length)
  })

  it('is deterministic: two runs produce identical summaries and identical call ids', async () => {
    const first = stubServices()
    const second = stubServices()
    const a = await seedDemoDataset(first.services, ENV, NOW)
    const b = await seedDemoDataset(second.services, ENV, NOW)
    expect(a).toEqual(b)
    const ids = (s: ReturnType<typeof stubServices>) => s.stubs.calls.recordHistoricalCall.mock.calls.map((c: unknown[]) => (c[1] as { callId: string }).callId)
    expect(ids(first)).toEqual(ids(second))
  })

  it('encrypts every note so its author and the demo admin can read it', async () => {
    const { services, stubs } = stubServices()
    await seedDemoDataset(services, ENV, NOW)
    const noted = DEMO_CALLS.filter(c => c.note)
    expect(stubs.records.createNote).toHaveBeenCalledTimes(noted.length)
    const names = { maria: 'Maria Santos', james: 'James Chen' } as const
    stubs.records.createNote.mock.calls.forEach((args: unknown[], i: number) => {
      const input = args[0] as { encryptedContent: string; authorEnvelope: { enc: string; ct: string }; adminEnvelopes: Array<{ pubkey: string; enc: string; ct: string }> }
      const call = noted[i]
      const text = JSON.stringify({ text: call.note })
      expect(openAs(names[call.answeredBy!], input.encryptedContent, input.authorEnvelope, LABEL_NOTE_KEY)).toBe(text)
      expect(input.adminEnvelopes).toHaveLength(1)
      expect(input.adminEnvelopes[0].pubkey).toBe(demoIdentityByName(DEV_SERVER, 'Demo Admin').pubkey)
      expect(openAs('Demo Admin', input.encryptedContent, input.adminEnvelopes[0], LABEL_NOTE_KEY)).toBe(text)
    })
  })

  it('appends audit entries oldest-first with strictly increasing timestamps', async () => {
    const { services, stubs } = stubServices()
    await seedDemoDataset(services, ENV, NOW)
    const times = stubs.audit.log.mock.calls.map((c: unknown[]) => (c[4] as Date).getTime())
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])
    expect(times.at(-1)).toBeLessThanOrEqual(NOW.getTime())
    for (const call of stubs.audit.log.mock.calls) expect(call[3]).toBe(DEMO_HUB.id)
  })

  it('refuses to seed when a demo account is missing', async () => {
    const { services, stubs } = stubServices()
    stubs.identity.getUserInternal.mockResolvedValueOnce(null)
    await expect(seedDemoDataset(services, ENV, NOW)).rejects.toThrow(/does not exist/)
    expect(stubs.settings.purgeHub).not.toHaveBeenCalled()
  })
})
