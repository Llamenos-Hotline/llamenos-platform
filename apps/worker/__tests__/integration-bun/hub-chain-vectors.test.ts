/**
 * The server's PRODUCTION reader of the hub-chain and recovery vectors (#2963;
 * wire spec §6.1 "the server: a bun:ffi test"): every case in
 * packages/crypto/tests/fixtures/v2/hub-chain.json and recovery.json opens or
 * fails through `hubChainCall` — the same `ffi_hub_chain` the append route
 * validates with — and each negative fails with its named code, never merely
 * with an error.
 *
 * Also pins tests/mocks/hub-chain-mock.ts (the test-side signer that founds
 * hubs over the API from Node, where `bun:ffi` cannot load) byte-for-byte
 * against the crate: every link the vectors carry that is inside the profile
 * hashes to its `entryHash` under the mock, and the mock's signing message
 * equals the crate's `signingMessage` op. No field is excluded.
 *
 * Needs no database: MUST run under `bun test` (bun:ffi).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bytesToHex } from '@noble/hashes/utils.js'
import { CryptoError, hubChainCall, type HubChainInput, type SigchainLink } from '@llamenos/crypto/ffi'
import type { HubChainLink, HubChainVerified } from '@protocol/schemas/hub-chain'
import { bundlePermsHashMock, hubLinkSigningMessageMock } from '../../../../tests/mocks/hub-chain-mock'

const FIXTURES = join(import.meta.dir, '../../../../packages/crypto/tests/fixtures/v2')
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

interface HubCase<E> { name: string; prefix: number; append: HubChainLink[]; anchor?: { seq: number; hash: string }; expect: E }
type Positive = HubCase<Pick<HubChainVerified, 'head' | 'stateHash' | 'state' | 'alerts'>>
type Negative = HubCase<string>

const hub = load('hub-chain.json') as { chain: HubChainLink[]; userChains: SigchainLink[][]; positives: Positive[]; negatives: Negative[] }
const recovery = load('recovery.json') as {
  userChains: SigchainLink[][]
  hubChains: HubChainLink[][]
  positives: { name: string; chain: SigchainLink[]; hubAnchors: { hub: string; head: { seq: number; hash: string } }[]; expect: { activeDevicePubkeys: string[] } }[]
  negatives: { name: string; chain: SigchainLink[]; hubAnchors: { hub: string; head: { seq: number; hash: string } }[]; expect: string }[]
}

function input(c: HubCase<unknown>): HubChainInput {
  return {
    links: [...hub.chain.slice(0, c.prefix), ...c.append],
    userChains: hub.userChains,
    ...(c.anchor ? { anchor: c.anchor } : {}),
  }
}

function codeOf(f: () => unknown): string {
  try {
    f()
    return 'ok'
  } catch (e) {
    if (e instanceof CryptoError) return e.reason ?? `unparsed: ${e.message}`
    throw e
  }
}

describe('hub-chain.json through ffi_hub_chain', () => {
  it('opens every positive with its head, state, stateHash and alerts', () => {
    expect(hub.positives.length).toBe(14)
    for (const p of hub.positives) {
      const v = hubChainCall('verify', input(p))
      const want = p.expect
      expect({ name: p.name, head: v.head, stateHash: v.stateHash, state: v.state, alerts: v.alerts })
        .toEqual({ name: p.name, head: want.head, stateHash: want.stateHash, state: want.state, alerts: want.alerts })
    }
  })

  it('refuses every negative with its named code', () => {
    expect(hub.negatives.length).toBe(19)
    for (const n of hub.negatives) {
      expect({ name: n.name, code: codeOf(() => hubChainCall('verify', input(n))) }).toEqual({ name: n.name, code: n.expect })
    }
  })
})

describe('recovery.json through ffi_hub_chain verifySigchain', () => {
  it('accepts threshold approvals and refuses each negative by code', () => {
    for (const p of recovery.positives) {
      const st = hubChainCall('verifySigchain', {
        links: p.chain, userChains: recovery.userChains, hubChains: recovery.hubChains, hubAnchors: p.hubAnchors,
      })
      expect(st.activeDevicePubkeys).toEqual(p.expect.activeDevicePubkeys)
    }
    expect(recovery.negatives.length).toBe(8)
    for (const n of recovery.negatives) {
      const code = codeOf(() => hubChainCall('verifySigchain', {
        links: n.chain, userChains: recovery.userChains, hubChains: recovery.hubChains, hubAnchors: n.hubAnchors,
      }))
      expect({ name: n.name, code }).toEqual({ name: n.name, code: n.expect })
    }
  })
})

describe('tests/mocks/hub-chain-mock.ts parity with the crate', () => {
  const IN_PROFILE_REFUSALS = new Set(['unsorted-set', 'out-of-profile-string'])
  // Negatives whose link was edited AFTER signing on purpose: their stored
  // entryHash is stale by design, so only crate-vs-mock agreement is checked.
  const TAMPERED_AFTER_SIGNING = new Set(['chain_entry_hash', 'chain_prev_hash'])
  const negLinks = hub.negatives.filter(n => !IN_PROFILE_REFUSALS.has(n.name))
  const stale = new Set(negLinks.filter(n => TAMPERED_AFTER_SIGNING.has(n.expect)).flatMap(n => n.append))
  const links = [...hub.chain, ...negLinks.flatMap(n => n.append)].filter(l => l.sig.length === 128)

  it('hashes every in-profile vector link to its entryHash, and signs the crate\'s exact message', () => {
    expect(links.length).toBeGreaterThan(25)
    for (const l of links) {
      const { entryHash, sig: _sig, signerDevice, ...unsigned } = l
      const mock = hubLinkSigningMessageMock(unsigned, signerDevice)
      const crate = hubChainCall('signingMessage', { unsigned, signerDevice })
      expect(mock.entryHash).toBe(crate.entryHash)
      expect(bytesToHex(mock.message)).toBe(crate.message)
      if (!stale.has(l)) expect(mock.entryHash).toBe(entryHash)
    }
  })

  it('computes the crate\'s bundle permission hash', () => {
    for (const perms of [[], ['calls:answer'], ['calls:read-history', 'hubs:manage-members', 'notes:read-all']]) {
      expect(bundlePermsHashMock(perms)).toBe(hubChainCall('permsHash', { permissions: perms }).permsHash)
    }
  })
})
