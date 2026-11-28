/**
 * Hub-chain SIGNING for test fixtures and the Playwright Tauri IPC mock (#2963).
 *
 * Tests that found a hub over the API (Playwright runs on Node, where the
 * crate's `bun:ffi` binding cannot load) must sign the founder's genesis. This
 * module produces exactly the links packages/crypto `hub_chain::sign_hub_link`
 * does — the D10 canonical form (keys sorted at every depth, compact) hashed
 * with SHA-256, signed under `L_HUB_CHAIN_SIG ‖ 0x00 ‖ entryHash` — and is
 * pinned byte-for-byte against the crate's vectors and its `signingMessage`
 * op in apps/worker/__tests__/unit/hub-chain-mock-parity.test.ts.
 *
 * It deliberately has NO verifier. Verification is the crate's alone: a JS
 * verifier would be a second implementation that a test could pass against
 * while the real one differs (#2104). The Playwright mock forwards `verify`
 * to the crate (see tests/mocks/tauri-core.ts `hub_chain_call`).
 *
 * Pure module: no `window`, no Tauri imports, safe to load from Node/Bun.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { LABEL_HUB_BUNDLE_PERMS, LABEL_HUB_CHAIN_SIG } from '@shared/crypto-labels'
import type { ChainHead, HubChainLink, UnsignedHubLink } from '@protocol/schemas/hub-chain'

type Json = null | number | string | Json[] | { [k: string]: Json }

/** Keys sorted at every depth, compact — serde_json's form for an in-profile value. */
export function canonicalHubJson(v: unknown): string {
  const sort = (x: unknown): Json => {
    if (Array.isArray(x)) return x.map(sort)
    if (x !== null && typeof x === 'object') {
      const out: { [k: string]: Json } = {}
      for (const k of Object.keys(x).sort()) {
        const val = (x as Record<string, unknown>)[k]
        if (val !== undefined) out[k] = sort(val)
      }
      return out
    }
    return x as Json
  }
  return JSON.stringify(sort(v))
}

function labelled(label: string, digest: Uint8Array): Uint8Array {
  const l = utf8ToBytes(label)
  const out = new Uint8Array(l.length + 1 + digest.length)
  out.set(l, 0)
  out[l.length] = 0
  out.set(digest, l.length + 1)
  return out
}

/** `{entryHash, message}` for `unsigned` signed by `signerDevice` — `hub_chain::hub_link_signing_message`. */
export function hubLinkSigningMessageMock(unsigned: UnsignedHubLink, signerDevice: string): { entryHash: string; message: Uint8Array } {
  const digest = sha256(utf8ToBytes(canonicalHubJson({ ...unsigned, signerDevice })))
  return { entryHash: bytesToHex(digest), message: labelled(LABEL_HUB_CHAIN_SIG, digest) }
}

/** Sign `unsigned` with the device whose Ed25519 seed is `signingSeedHex`. */
export function signHubLinkMock(unsigned: UnsignedHubLink, signingSeedHex: string): HubChainLink {
  const seed = hexToBytes(signingSeedHex)
  const signerDevice = bytesToHex(ed25519.getPublicKey(seed))
  const { entryHash, message } = hubLinkSigningMessageMock(unsigned, signerDevice)
  return { ...unsigned, signerDevice, entryHash, sig: bytesToHex(ed25519.sign(message, seed)) }
}

/** `hub_chain::bundle_perms_hash`: H(lp(L_HUB_BUNDLE_PERMS) ‖ lp(p_1) ‖ … ‖ lp(p_k)). */
export function bundlePermsHashMock(permissions: readonly string[]): string {
  const parts = [LABEL_HUB_BUNDLE_PERMS, ...permissions].map(p => utf8ToBytes(p))
  const out = new Uint8Array(parts.reduce((n, p) => n + 2 + p.length, 0))
  let o = 0
  for (const p of parts) {
    out[o] = p.length >> 8
    out[o + 1] = p.length & 0xff
    out.set(p, o + 2)
    o += 2 + p.length
  }
  return bytesToHex(sha256(out))
}

/** A new-hub genesis (§5.6): the founder alone, holding `bundles`, `migration: 0`. */
export function newHubGenesisMock(
  hubId: string,
  founderSeedHex: string,
  founderHead: ChainHead,
  bundles: readonly string[],
): HubChainLink {
  const founder = bytesToHex(ed25519.getPublicKey(hexToBytes(founderSeedHex)))
  return signHubLinkMock({
    hub: hubId,
    seq: 1,
    prevHash: null,
    signerUser: founder,
    signerUserHead: founderHead,
    body: {
      type: 'genesis',
      founder,
      migration: 0,
      members: [{ user: founder, bundles: [...bundles].sort() }],
    },
  }, founderSeedHex)
}
