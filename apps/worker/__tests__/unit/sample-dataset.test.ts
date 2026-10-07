import { describe, it, expect, vi } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hpkeOpen, symmetricDecrypt } from '@llamenos/crypto/ffi'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_CALL_META, LABEL_DEVICE_ENCRYPTION_SEED, LABEL_NOTE_KEY } from '@shared/crypto-labels'
import { contentAad, keyWrapAad } from '@shared/envelope-aad'
import {
  SAMPLE_ACCOUNTS,
  SAMPLE_CALLS, SAMPLE_CASES, SAMPLE_CONTACTS, SAMPLE_CONVERSATIONS, SAMPLE_HUB, SAMPLE_SHIFTS,
} from '@worker/lib/sample-dataset'
import { sampleIdentities, sampleIdentityByName } from '@worker/lib/sample-identities'
import { sampleReader, deriveSampleEncryptionPubkey, sealForReaders } from '@worker/lib/sample-crypto'
import { seedSampleDataset } from '@worker/services/sample-seeder'
import type { Services } from '@worker/services'

/** Sample identities need an open dev surface — a development server is the one these tests model. */
const DEV_SERVER = { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true' } as const

const seedHexToEd25519Pubkey = (seedHex: string): string => bytesToHex(ed25519.getPublicKey(hexToBytes(seedHex)))

/** Open a sealed item the way a sample account's device would: derive its X25519 secret, open the key wrap, decrypt. */
function openAs(name: string, encryptedContent: string, envelope: { enc: string; ct: string }, label: string): string {
  const identity = sampleIdentityByName(DEV_SERVER, name)
  const encSecret = hkdf(sha256, hexToBytes(identity.seedHex), new Uint8Array(0), utf8ToBytes(LABEL_DEVICE_ENCRYPTION_SEED), 32)
  const wrapped = new Uint8Array([...hexToBytes(envelope.enc), ...Buffer.from(envelope.ct, 'base64url')])
  const contentKey = hpkeOpen(encSecret, wrapped, utf8ToBytes(label), keyWrapAad(label))
  return new TextDecoder().decode(symmetricDecrypt(contentKey, hexToBytes(encryptedContent), contentAad(label)))
}

describe('sample dataset content', () => {
  it('has the documented shape', () => {
    expect(SAMPLE_CALLS).toHaveLength(12)
    expect(SAMPLE_CALLS.filter(c => c.note).length).toBeGreaterThanOrEqual(7) // "notes on most"
    expect(SAMPLE_CONTACTS).toHaveLength(8)
    expect(SAMPLE_CASES).toHaveLength(2)
    expect(new Set(SAMPLE_CALLS.map(c => c.key)).size).toBe(SAMPLE_CALLS.length)
  })

  it('spans a fortnight', () => {
    const oldest = Math.max(...SAMPLE_CALLS.map(c => c.hoursAgo))
    expect(oldest).toBeGreaterThan(24 * 12)
    expect(oldest).toBeLessThanOrEqual(24 * 14)
  })

  it('only unanswered calls lack an answerer, and only answered calls carry notes', () => {
    for (const call of SAMPLE_CALLS) {
      if (call.answeredBy === null) expect(call.note).toBeUndefined()
      if (call.note) expect(call.answeredBy).not.toBeNull()
    }
  })

  it('is obviously fictional: reserved 555-01xx numbers, no real-looking identifiers', () => {
    const fictionalPhone = /^\+155555501\d\d$/
    for (const contact of SAMPLE_CONTACTS) expect(contact.phone).toMatch(fictionalPhone)
    for (const call of SAMPLE_CALLS) expect(call.callerLast4).toMatch(/^01\d\d$/)
    for (const conv of Object.values(SAMPLE_CONVERSATIONS)) {
      if (conv.sender.startsWith('+')) expect(conv.sender).toMatch(fictionalPhone)
    }
    const prose = [
      ...SAMPLE_CALLS.map(c => c.note ?? ''),
      ...Object.values(SAMPLE_CONVERSATIONS).flatMap(c => c.messages.map(m => m.text)),
      ...SAMPLE_CASES.flatMap(c => [c.title, c.description, ...c.timeline.map(t => (t.kind === 'comment' ? t.text : ''))]),
      SAMPLE_HUB.description,
    ].join('\n')
    expect(prose).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i) // no email addresses
    expect(prose).not.toMatch(/\d{3}[-. ]\d{3}[-. ]\d{4}/) // no phone numbers
  })

  it('every case links known contacts and notes that exist', () => {
    const contactKeys = new Set(SAMPLE_CONTACTS.map(c => c.key))
    const notedCalls = new Set(SAMPLE_CALLS.filter(c => c.note).map(c => c.key))
    for (const sampleCase of SAMPLE_CASES) {
      for (const key of sampleCase.contacts) expect(contactKeys.has(key)).toBe(true)
      for (const step of sampleCase.timeline) {
        if (step.kind === 'note') expect(notedCalls.has(step.noteOfCall)).toBe(true)
      }
      const hours = sampleCase.timeline.map(t => t.hoursAgo)
      expect(hours).toEqual([...hours].sort((a, b) => b - a)) // oldest first
    }
  })

  it('schedules every UTC hour of every day, with the sample volunteer always on shift', () => {
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const time = `${String(hour).padStart(2, '0')}:00`
        const covering = SAMPLE_SHIFTS.filter((s) => {
          if (!s.days.includes(day)) return false
          return s.startTime < s.endTime ? time >= s.startTime && time < s.endTime : time >= s.startTime || time < s.endTime
        })
        expect(covering.length, `day ${day} ${time}`).toBeGreaterThan(0)
        expect(covering.some(s => s.volunteers.includes('james')), `james on ${day} ${time}`).toBe(true)
      }
    }
  })
})

describe('sample identities', () => {
  it('derive one distinct signing pubkey per sample account, from the per-process seed', () => {
    const identities = sampleIdentities(DEV_SERVER)
    expect(identities).toHaveLength(SAMPLE_ACCOUNTS.length)
    expect(new Set(identities.map(i => i.pubkey)).size).toBe(identities.length)
    for (const identity of identities) {
      expect(identity.pubkey).toMatch(/^[0-9a-f]{64}$/)
      expect(identity.pubkey).toBe(seedHexToEd25519Pubkey(identity.seedHex))
    }
    // The accounts' roles and phones come straight from SAMPLE_ACCOUNTS; only the
    // keys are per-process. (`listedPubkey`, a legacy secp256k1 handle the demo
    // login picker keyed on, went with that picker in #1604.)
    expect(identities.map(i => ({ name: i.name, roleIds: i.roleIds, phone: i.phone })))
      .toEqual(SAMPLE_ACCOUNTS.map(a => ({ name: a.name, roleIds: a.roleIds, phone: a.phone })))
  })

  it('are generated once per process and stay stable within it', () => {
    expect(sampleIdentities(DEV_SERVER)).toBe(sampleIdentities(DEV_SERVER))
  })
})

describe('sealForReaders', () => {
  it('produces the desktop wire format and each reader can open it', () => {
    const [maria, admin] = [sampleReader(sampleIdentityByName(DEV_SERVER, 'Maria Santos')), sampleReader(sampleIdentityByName(DEV_SERVER, 'Sample Admin'))]
    const sealed = sealForReaders('hello sample', [maria, admin], LABEL_NOTE_KEY)

    expect(sealed.encryptedContent).toMatch(/^[0-9a-f]+$/)
    expect(sealed.envelopes.map(e => e.pubkey)).toEqual([maria.pubkey, admin.pubkey])
    for (const envelope of sealed.envelopes) {
      expect(envelope.enc).toMatch(/^[0-9a-f]{64}$/)
      expect(envelope.ct).toMatch(/^[A-Za-z0-9_-]+$/) // base64url, no padding
    }
    expect(openAs('Maria Santos', sealed.encryptedContent, sealed.envelopes[0], LABEL_NOTE_KEY)).toBe('hello sample')
    expect(openAs('Sample Admin', sealed.encryptedContent, sealed.envelopes[1], LABEL_NOTE_KEY)).toBe('hello sample')
  })

  it('does not open under a different label (domain separation)', () => {
    const admin = sampleReader(sampleIdentityByName(DEV_SERVER, 'Sample Admin'))
    const sealed = sealForReaders('secret', [admin], LABEL_NOTE_KEY)
    expect(() => openAs('Sample Admin', sealed.encryptedContent, sealed.envelopes[0], LABEL_CALL_META)).toThrow()
  })

  it('does not open under an empty AAD — the pre-convention desktop format is dead', () => {
    // The sealer once bound no AAD at either layer, which made sample notes
    // unreadable to every canonical implementation (Rust `encrypt_note`, the
    // mobile clients, the desktop). Pin the convention: both layers carry the
    // canonical AAD, and empty AAD fails at the HPKE tag first.
    const admin = sampleReader(sampleIdentityByName(DEV_SERVER, 'Sample Admin'))
    const sealed = sealForReaders('secret', [admin], LABEL_NOTE_KEY)
    const identity = sampleIdentityByName(DEV_SERVER, 'Sample Admin')
    const encSecret = hkdf(sha256, hexToBytes(identity.seedHex), new Uint8Array(0), utf8ToBytes(LABEL_DEVICE_ENCRYPTION_SEED), 32)
    const wrapped = new Uint8Array([...hexToBytes(sealed.envelopes[0].enc), ...Buffer.from(sealed.envelopes[0].ct, 'base64url')])

    expect(() => hpkeOpen(encSecret, wrapped, utf8ToBytes(LABEL_NOTE_KEY), new Uint8Array(0))).toThrow()
    const contentKey = hpkeOpen(encSecret, wrapped, utf8ToBytes(LABEL_NOTE_KEY), keyWrapAad(LABEL_NOTE_KEY))
    expect(() => symmetricDecrypt(contentKey, hexToBytes(sealed.encryptedContent), new Uint8Array(0))).toThrow()
  })

  it('seals to the X25519 key the client derives from the signing seed', () => {
    const identity = sampleIdentityByName(DEV_SERVER, 'James Chen')
    expect(sampleReader(identity).encryptionPubkey).toBe(deriveSampleEncryptionPubkey(identity.seedHex))
    expect(sampleReader(identity).encryptionPubkey).not.toBe(identity.pubkey)
  })
})

describe('seedSampleDataset', () => {
  function stubServices() {
    const calls: string[] = []
    const track = <T>(name: string, value: T) => vi.fn(async (..._args: unknown[]) => { calls.push(name); return value })
    let n = 0
    const id = () => `id-${++n}`
    const users = new Set(sampleIdentities(DEV_SERVER).map(i => i.pubkey))
    const services = {
      settings: {
        ensureInit: track('settings.ensureInit', undefined),
        purgeHub: track('settings.purgeHub', { ok: true }),
        createHub: track('settings.createHub', undefined),
        setCaseManagementEnabled: track('settings.setCaseManagementEnabled', undefined),
        createEntityType: vi.fn(async () => ({ id: 'entity-type-1' })),
        generateCaseNumber: vi.fn(async () => ({ number: 'SAMPLE-2026-0001', sequence: 1 })),
        getEnabledChannels: vi.fn(async () => ({ sms: true, whatsapp: false, signal: true, rcs: false, telegram: false })),
      },
      identity: {
        getUserInternal: vi.fn(async (pubkey: string) => (users.has(pubkey) ? { pubkey } : null)),
        ensureSampleAccounts: track('identity.ensureSampleAccounts', undefined),
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

  it('replaces the previous sample hub before rebuilding it', async () => {
    const { services, stubs, calls } = stubServices()
    await seedSampleDataset(services, ENV, NOW)
    expect(stubs.settings.purgeHub).toHaveBeenCalledWith(SAMPLE_HUB.id)
    expect(calls.indexOf('settings.purgeHub')).toBeLessThan(calls.indexOf('settings.createHub'))
    // accounts removed by the purge are restored before memberships are assigned
    expect(calls.indexOf('identity.ensureSampleAccounts')).toBeGreaterThan(calls.indexOf('settings.purgeHub'))
    expect(calls.indexOf('identity.ensureSampleAccounts')).toBeLessThan(calls.indexOf('settings.createHub'))
  })

  it('seeds the fixed counts, one conversation per enabled channel, and reports them', async () => {
    const { services, stubs } = stubServices()
    const summary = await seedSampleDataset(services, ENV, NOW)
    expect(summary).toMatchObject({ hubId: SAMPLE_HUB.id, shifts: 3, calls: 12, notes: SAMPLE_CALLS.filter(c => c.note).length, contacts: 8, cases: 2, conversations: 2 })
    expect(stubs.calls.recordHistoricalCall).toHaveBeenCalledTimes(12)
    expect(stubs.conversations.create).toHaveBeenCalledTimes(2) // sms + signal enabled
    expect(summary.auditEntries).toBe(stubs.audit.log.mock.calls.length)
  })

  it('is deterministic: two runs produce identical summaries and identical call ids', async () => {
    const first = stubServices()
    const second = stubServices()
    const a = await seedSampleDataset(first.services, ENV, NOW)
    const b = await seedSampleDataset(second.services, ENV, NOW)
    expect(a).toEqual(b)
    const ids = (s: ReturnType<typeof stubServices>) => s.stubs.calls.recordHistoricalCall.mock.calls.map((c: unknown[]) => (c[1] as { callId: string }).callId)
    expect(ids(first)).toEqual(ids(second))
  })

  it('encrypts every note so its author and the sample admin can read it', async () => {
    const { services, stubs } = stubServices()
    await seedSampleDataset(services, ENV, NOW)
    const noted = SAMPLE_CALLS.filter(c => c.note)
    expect(stubs.records.createNote).toHaveBeenCalledTimes(noted.length)
    const names = { maria: 'Maria Santos', james: 'James Chen' } as const
    stubs.records.createNote.mock.calls.forEach((args: unknown[], i: number) => {
      const input = args[0] as { encryptedContent: string; authorEnvelope: { enc: string; ct: string }; adminEnvelopes: Array<{ pubkey: string; enc: string; ct: string }> }
      const call = noted[i]
      const text = JSON.stringify({ text: call.note })
      expect(openAs(names[call.answeredBy!], input.encryptedContent, input.authorEnvelope, LABEL_NOTE_KEY)).toBe(text)
      expect(input.adminEnvelopes).toHaveLength(1)
      expect(input.adminEnvelopes[0].pubkey).toBe(sampleIdentityByName(DEV_SERVER, 'Sample Admin').pubkey)
      expect(openAs('Sample Admin', input.encryptedContent, input.adminEnvelopes[0], LABEL_NOTE_KEY)).toBe(text)
    })
  })

  it('appends audit entries oldest-first with strictly increasing timestamps', async () => {
    const { services, stubs } = stubServices()
    await seedSampleDataset(services, ENV, NOW)
    const times = stubs.audit.log.mock.calls.map((c: unknown[]) => (c[4] as Date).getTime())
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])
    expect(times.at(-1)).toBeLessThanOrEqual(NOW.getTime())
    for (const call of stubs.audit.log.mock.calls) expect(call[3]).toBe(SAMPLE_HUB.id)
  })

  it('refuses to seed when a sample account is missing', async () => {
    const { services, stubs } = stubServices()
    stubs.identity.getUserInternal.mockResolvedValueOnce(null)
    await expect(seedSampleDataset(services, ENV, NOW)).rejects.toThrow(/does not exist/)
    expect(stubs.settings.purgeHub).not.toHaveBeenCalled()
  })
})
