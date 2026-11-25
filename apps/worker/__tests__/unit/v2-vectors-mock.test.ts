/**
 * Pins the JS mirror of the crate's shapes and events (`tests/mocks/hpke-mock.ts`)
 * to the crate itself, through the v2 vectors it generated
 * (`packages/crypto/tests/fixtures/v2/`).
 *
 * The mirror exists only because Playwright's webview and the Node-side BDD steps
 * cannot load the crate. It is never evidence about the real implementation —
 * that is the crate's own test, the server's bun:ffi test, the desktop's
 * Tauri-command test and the iOS/Android vector tests. What this proves is that
 * the copy has not drifted: if it disagrees with any byte the crate wrote, the
 * suites that use it are testing a different format, and this fails first.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SHAPES, type Shape } from '@shared/crypto-shapes'
import {
  openServerEventMock,
  serverEventKeyMock,
  shapeOpenMock,
  type MockHpkeEnvelope,
} from '../../../../tests/mocks/hpke-mock'
import { bytesToHex, hexToBytes } from '@shared/encoding'

const FIXTURES = resolve(__dirname, '../../../../packages/crypto/tests/fixtures/v2')
const load = (name: string) => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf-8'))

async function reasonOf(fn: () => unknown): Promise<string> {
  try {
    await fn()
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).split(':')[0]
  }
  throw new Error('expected a rejection, got success')
}

describe('the JS shape mirror opens the crate-generated hpke-wrap vectors', () => {
  const f = load('hpke-wrap.json') as {
    recipientSecretHex: string
    positives: { shape: Shape; aadFields: string[]; plaintextHex: string; envelope: MockHpkeEnvelope }[]
    negatives: { name: string; shape: Shape; aadFields: string[]; envelope: MockHpkeEnvelope; expect: string }[]
  }

  it('covers every shape, in the crate order', () => {
    expect(f.positives.map(p => p.shape)).toEqual([...SHAPES])
  })

  for (const p of f.positives) {
    it(`opens ${p.shape}`, async () => {
      const pt = await shapeOpenMock(p.shape, f.recipientSecretHex, p.aadFields, p.envelope)
      expect(bytesToHex(pt)).toBe(p.plaintextHex)
    })
  }

  for (const n of f.negatives) {
    it(`refuses ${n.name} with ${n.expect}`, async () => {
      expect(await reasonOf(() => shapeOpenMock(n.shape, f.recipientSecretHex, n.aadFields, n.envelope))).toBe(n.expect)
    })
  }
})

describe('the JS events mirror opens the crate-generated server-event vectors', () => {
  const f = load('server-event.json') as {
    serverSecretHex: string
    heldKeys: { hubId: string; epoch: number; keyHex: string }[]
    frames: { name: string; hubId: string; kind: number; epoch: number; plaintext: string; payload: string }[]
    negatives: { name: string; hubId: string; kind: number; epoch: number; payload: string; expect: string }[]
  }
  const held = (hub: string, epoch: number) => f.heldKeys.find(k => k.hubId === hub && k.epoch === epoch)

  it('derives exactly the keys the crate derives', () => {
    for (const k of f.heldKeys) {
      expect(bytesToHex(serverEventKeyMock(hexToBytes(f.serverSecretHex), k.hubId, k.epoch))).toBe(k.keyHex)
    }
  })

  for (const fr of f.frames) {
    it(`opens ${fr.name} with its own hub's key`, () => {
      const key = serverEventKeyMock(hexToBytes(f.serverSecretHex), fr.hubId, fr.epoch)
      expect(openServerEventMock(key, fr.hubId, fr.kind, fr.epoch, fr.payload)).toBe(fr.plaintext)
    })
  }

  for (const n of f.negatives) {
    if (n.expect === 'no_event_key') continue // a keyring property, see relay-crypto.ts
    it(`refuses ${n.name} with ${n.expect}`, async () => {
      const k = held(f.heldKeys[0].hubId, n.epoch) ?? f.heldKeys[0]
      expect(await reasonOf(() => openServerEventMock(hexToBytes(k.keyHex), n.hubId, n.kind, n.epoch, n.payload))).toBe(n.expect)
    })
  }
})
