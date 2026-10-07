import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock platform.ts — hub key crypto now delegates to Rust IPC
vi.mock('./platform', () => {
  // In-memory mock hub key for roundtrip testing
  let storedHubKey: Uint8Array | null = null

  return {
    hpkeUnwrapAndSetHubKey: vi.fn(async () => {
      storedHubKey = new Uint8Array(32)
      crypto.getRandomValues(storedHubKey)
    }),
    generateHubKeyInState: vi.fn(async () => {
      storedHubKey = new Uint8Array(32)
      crypto.getRandomValues(storedHubKey)
    }),
    wrapHubKeyForMember: vi.fn(async () => ({
      v: 3,
      labelId: 3,
      enc: 'mock-enc',
      ct: 'mock-ct',
    })),
    encryptHubField: vi.fn(async (plaintext: string, _label: string) => {
      // Simple mock: base64-encode for roundtrip testing
      return btoa(plaintext)
    }),
    decryptHubField: vi.fn(async (ciphertextHex: string, _label: string) => {
      try {
        return atob(ciphertextHex)
      } catch {
        return null
      }
    }),
  }
})

import { generateHubKey, encryptForHub, decryptFromHub, wrapHubKeyForMember, wrapHubKeyForMembers, rotateHubKey, unwrapHubKey } from './hub-key-manager'
import { generateHubKeyInState, wrapHubKeyForMember as platformWrap, hpkeUnwrapAndSetHubKey as platformUnwrap } from './platform'
import { keyWrapAadHex } from '@shared/envelope-aad'
import { LABEL_HUB_KEY_WRAP } from '@shared/crypto-labels'

/** PROTOCOL.md §2.7: aad = UTF-8("llamenos:hub-key-wrap:key-wrap"). */
const COMPOSITE_AAD_HEX = keyWrapAadHex(LABEL_HUB_KEY_WRAP)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('generateHubKey', () => {
  it('delegates to Rust CryptoState', async () => {
    await generateHubKey()
    expect(generateHubKeyInState).toHaveBeenCalledOnce()
  })
})

describe('encryptForHub / decryptFromHub', () => {
  it('delegates encryption and decryption to Rust IPC', async () => {
    const plaintext = 'Hello, hub world!'
    const label = 'llamenos:hub-event'
    const encrypted = await encryptForHub(plaintext, label)
    expect(encrypted).toBeTruthy()
    const decrypted = await decryptFromHub(encrypted, label)
    expect(decrypted).toBe(plaintext)
  })
})

describe('wrapHubKeyForMember', () => {
  it('returns a RecipientEnvelope with pubkey', async () => {
    const pubkey = 'aa'.repeat(32)
    const envelope = await wrapHubKeyForMember(pubkey)
    expect(envelope.pubkey).toBe(pubkey)
    expect(platformWrap).toHaveBeenCalledWith(pubkey, LABEL_HUB_KEY_WRAP, COMPOSITE_AAD_HEX)
  })
})

/**
 * The AAD the hub-key envelope binds (#1631).
 *
 * The hub key is the one envelope family where the desktop, iOS and Android
 * all passed an EMPTY AAD — agreeing with each other while PROTOCOL.md §2.7,
 * Rust's `hpke_wrap_key`/`hpke_unwrap_key` pair, the interop vectors and the
 * BDD seeder had all bound `UTF-8("llamenos:hub-key-wrap:key-wrap")` from the
 * start. The operator adjudicated that the code moves to the spec, so this
 * asserts the composite AAD positively *and* asserts the empty AAD is gone:
 * the pre-fix expectation was literally `''`, so a revert fails here.
 *
 * `platform.ts` is mocked, which makes the AAD argument each IPC command
 * receives the contract under test — the same technique as
 * `envelope-aad-call-sites.test.ts` for file envelopes.
 */
describe('hub key envelopes bind the §2.7 composite AAD', () => {
  it('spells the AAD exactly as §2.7 does', () => {
    const utf8 = new TextEncoder().encode('llamenos:hub-key-wrap:key-wrap')
    const expected = Array.from(utf8, b => b.toString(16).padStart(2, '0')).join('')
    expect(COMPOSITE_AAD_HEX).toBe(expected)
  })

  it('the wrap binds it, and not an empty AAD', async () => {
    await wrapHubKeyForMember('aa'.repeat(32))
    const aadHex = vi.mocked(platformWrap).mock.calls[0][2]
    expect(aadHex).toBe(COMPOSITE_AAD_HEX)
    expect(aadHex).not.toBe('')
  })

  it('the unwrap binds the same value the wrap sealed under', async () => {
    const envelope = { v: 3, labelId: 3, enc: 'mock-enc', ct: 'mock-ct' }
    await unwrapHubKey(envelope)
    expect(platformUnwrap).toHaveBeenCalledWith(envelope, LABEL_HUB_KEY_WRAP, COMPOSITE_AAD_HEX)
    expect(vi.mocked(platformUnwrap).mock.calls[0][2]).not.toBe('')
  })

  it('every member of a rotation gets the same AAD', async () => {
    await rotateHubKey(['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)])
    const calls = vi.mocked(platformWrap).mock.calls
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call[2]).toBe(COMPOSITE_AAD_HEX)
    }
  })
})

describe('wrapHubKeyForMembers', () => {
  it('wraps for each member', async () => {
    const pubkeys = ['aa'.repeat(32), 'bb'.repeat(32)]
    const envelopes = await wrapHubKeyForMembers(pubkeys)
    expect(envelopes).toHaveLength(2)
    expect(envelopes[0].pubkey).toBe(pubkeys[0])
    expect(envelopes[1].pubkey).toBe(pubkeys[1])
  })
})

describe('rotateHubKey', () => {
  it('generates new key and wraps for all members', async () => {
    const pubkeys = ['aa'.repeat(32), 'bb'.repeat(32)]
    const result = await rotateHubKey(pubkeys)
    expect(generateHubKeyInState).toHaveBeenCalledOnce()
    expect(result.envelopes).toHaveLength(2)
  })
})
