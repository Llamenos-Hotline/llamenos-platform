/**
 * The ref that stands in for a provider identifier in logs and audit rows (#2333).
 *
 * The construction is pinned against an independent implementation (node:crypto),
 * so a change to the label, the derivation or the truncation cannot slip through
 * as "still deterministic" — and every ref already in an operator's logs would stop
 * matching `bun run provider-ref`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHmac, hkdfSync } from 'node:crypto'
import { LABEL_PROVIDER_REF_KEY } from '@shared/crypto-labels'
import { providerRef, scrubProviderSids, withProviderRefs, UNKEYED_PROVIDER_REF } from './provider-ref'

const SECRET = 'ab'.repeat(32) // gitleaks:allow
const OTHER_SECRET = 'cd'.repeat(32) // gitleaks:allow
const CALL_SID = 'CA0123456789abcdef0123456789abcdef'
const RECORDING_SID = 'RE89abcdef0123456789abcdef01234567'

function reference(id: string, secret: string): string {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'hex'), Buffer.alloc(0), LABEL_PROVIDER_REF_KEY, 32))
  return `pr_${createHmac('sha256', key).update(id).digest('hex').slice(0, 16)}`
}

let saved: string | undefined
beforeEach(() => {
  saved = process.env.HMAC_SECRET
  process.env.HMAC_SECRET = SECRET
})
afterEach(() => {
  if (saved === undefined) delete process.env.HMAC_SECRET
  else process.env.HMAC_SECRET = saved
})

describe('providerRef', () => {
  it('is HMAC(HKDF(HMAC_SECRET, LABEL_PROVIDER_REF_KEY), id), truncated to 64 bits', () => {
    expect(providerRef(CALL_SID)).toBe(reference(CALL_SID, SECRET))
    expect(providerRef('3f1c0d52-8d2e-4f6b-9a41-7c1e2b5d9e10')).toBe(reference('3f1c0d52-8d2e-4f6b-9a41-7c1e2b5d9e10', SECRET))
  })

  it('is stable for one identifier and distinct for two', () => {
    expect(providerRef(CALL_SID)).toBe(providerRef(CALL_SID))
    expect(providerRef(CALL_SID)).not.toBe(providerRef(RECORDING_SID))
  })

  it('does not contain the identifier, and is not reproducible without the secret', () => {
    const ref = providerRef(CALL_SID)
    expect(ref).not.toContain(CALL_SID.slice(2, 10))
    process.env.HMAC_SECRET = OTHER_SECRET
    expect(providerRef(CALL_SID)).toBe(reference(CALL_SID, OTHER_SECRET))
    expect(providerRef(CALL_SID)).not.toBe(ref)
  })

  it('fails closed: with no usable HMAC_SECRET the answer is a constant, never the identifier', () => {
    for (const bad of [undefined, '', 'not-hex', 'ab'.repeat(31)]) {
      if (bad === undefined) delete process.env.HMAC_SECRET
      else process.env.HMAC_SECRET = bad
      expect(providerRef(CALL_SID)).toBe(UNKEYED_PROVIDER_REF)
    }
  })
})

describe('scrubProviderSids', () => {
  it('replaces SIDs of every resource type inside free text, leaving the rest', () => {
    const text = `Recording ${RECORDING_SID} of call ${CALL_SID} was not found (code 20404)`
    expect(scrubProviderSids(text)).toBe(
      `Recording ${providerRef(RECORDING_SID)} of call ${providerRef(CALL_SID)} was not found (code 20404)`,
    )
  })

  it('leaves text that is not a SID alone: a hub id, a 32-hex run with no resource prefix, a lowercase prefix', () => {
    const text = 'hub 9f2c1b64-0000-4000-8000-0000000000aa ca0123456789abcdef0123456789abcdef 0123456789abcdef0123456789abcdef'
    expect(scrubProviderSids(text)).toBe(text)
  })
})

describe('withProviderRefs', () => {
  it('renames and replaces provider-identifier fields at any depth, and scrubs strings', () => {
    const input = {
      kind: 'voicemail',
      callId: CALL_SID,
      calls: [{ callSid: 'abc', recordingSid: RECORDING_SID, count: 2 }],
      error: `call ${CALL_SID} failed`,
    }
    const out = withProviderRefs(input)
    expect(out).toEqual({
      kind: 'voicemail',
      callIdRef: providerRef(CALL_SID),
      calls: [{ callSidRef: providerRef('abc'), recordingSidRef: providerRef(RECORDING_SID), count: 2 }],
      error: `call ${providerRef(CALL_SID)} failed`,
    })
    expect(JSON.stringify(out)).not.toContain(CALL_SID)
    expect(input.callId, 'the input is not mutated').toBe(CALL_SID)
  })

  it('leaves non-string values under those keys untouched and passes primitives through', () => {
    expect(withProviderRefs({ callId: 5, d: null })).toEqual({ callId: 5, d: null })
    expect(withProviderRefs(7)).toBe(7)
  })
})
