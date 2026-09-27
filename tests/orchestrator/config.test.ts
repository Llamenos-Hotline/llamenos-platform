import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  LANES, LIMITS, NEVER_WRITE_PATHS, MAX_ATTEMPTS_PER_ITEM,
  assertLiveLanesHaveScope, readLaneModes,
} from '../../orchestrator/src/config.js'
import type { Lane } from '../../orchestrator/src/config.js'
import { checkScope } from '../../orchestrator/src/scope.js'
import { trackedFiles } from './codeowners.js'

describe('assertLiveLanesHaveScope', () => {
  const lane = (mode: Lane['mode'], owned: string[]): Lane => ({
    id: 'ios', mode, cap: 1, engine: 'claude',
    requireLabel: 'agent-dispatchable', vetoLabels: [],
    scope: { owned, notOwned: [] },
  })

  it('throws when a live lane has no owned paths', () => {
    expect(() => assertLiveLanesHaveScope([lane('live', [])])).toThrow(/no owned paths|write scope/i)
  })

  it('throws when a shadow lane has no owned paths', () => {
    expect(() => assertLiveLanesHaveScope([lane('shadow', [])])).toThrow()
  })

  it('permits an off lane with no owned paths', () => {
    expect(() => assertLiveLanesHaveScope([lane('off', [])])).not.toThrow()
  })

  it('permits a live lane with owned paths', () => {
    expect(() => assertLiveLanesHaveScope([lane('live', ['apps/ios/'])])).not.toThrow()
  })

  it('names the offending lane and its fragment in the error', () => {
    expect(() => assertLiveLanesHaveScope([lane('live', [])]))
      .toThrow(/ios-supervisor\.md/)
  })
})

describe('config', () => {
  it('defines exactly the six domain lanes', () => {
    expect(LANES.map((l) => l.id).sort())
      .toEqual(['android', 'backend', 'desktop', 'infra', 'ios', 'shared'])
  })

  it('defaults every lane to off', () => {
    expect(LANES.every((l) => l.mode === 'off')).toBe(true)
  })

  it('caps every lane at 1', () => {
    expect(LANES.every((l) => l.cap === 1)).toBe(true)
  })

  it('requires a dispatch label on every lane', () => {
    expect(LANES.every((l) => l.requireLabel.length > 0)).toBe(true)
  })

  it('vetoes on needs-human everywhere', () => {
    expect(LANES.every((l) => l.vetoLabels.includes('needs-human'))).toBe(true)
  })

  // `deploy/` and `.github/workflows/` were removed from the never-write list
  // (they now rely on the impact gate instead — see config.ts's comment on
  // NEVER_WRITE_PATHS), so this asserts what actually remains: secrets and
  // key material a worker must never write at all, anywhere in the tree.
  it('never permits writes to secrets or key material', () => {
    for (const p of ['.env', '.dev.vars', 'keystore.properties', '*.pem', 'id_rsa', 'id_ed25519']) {
      expect(NEVER_WRITE_PATHS).toContain(p)
    }
  })

  it('no longer blocks deploy/ or .github/workflows/ by never-write — those rely on the impact gate', () => {
    expect(NEVER_WRITE_PATHS).not.toContain('deploy/')
    expect(NEVER_WRITE_PATHS).not.toContain('.github/workflows/')
  })

  it('marks a nested .env as forbidden via the real NEVER_WRITE_PATHS basename match', () => {
    const r = checkScope(['apps/worker/config/.env'], { owned: [], notOwned: [] }, [...NEVER_WRITE_PATHS])
    expect(r.forbidden).toEqual(['apps/worker/config/.env'])
  })

  it('marks a nested keystore.properties as forbidden via the real NEVER_WRITE_PATHS basename match', () => {
    const r = checkScope(['apps/android/keystore.properties'], { owned: [], notOwned: [] }, [...NEVER_WRITE_PATHS])
    expect(r.forbidden).toEqual(['apps/android/keystore.properties'])
  })

  // F3: keystore.properties only holds the signing key's password — the key
  // itself (a .jks/.keystore file, or an iOS App Store Connect API key) was
  // previously writable by any lane.
  it('never permits writes to the actual signing keys, not just their passwords', () => {
    for (const p of [
      '*.jks', '*.keystore', '*.p8', '*.p12', '*.pfx', '*.key',
      '*.mobileprovision', '.npmrc', '.pgpass', 'authorized_keys',
    ]) {
      expect(NEVER_WRITE_PATHS).toContain(p)
    }
  })

  it('marks a release Android keystore and an iOS App Store Connect API key as forbidden', () => {
    const r = checkScope(
      ['apps/android/app/release.jks', 'apps/ios/fastlane/AuthKey_ABC123.p8'],
      { owned: [], notOwned: [] },
      [...NEVER_WRITE_PATHS],
    )
    expect(r.forbidden).toEqual(['apps/android/app/release.jks', 'apps/ios/fastlane/AuthKey_ABC123.p8'])
  })

  // --- #1253: committed templates are not secrets -------------------------
  //
  // The guard refused `deploy/docker/.env.example`, the template the first
  // real deploy has to edit. These pin BOTH directions, because an exclusion
  // that is one character too broad is worse than the bug it fixes.

  it('still refuses every genuine secret shape through the real never-write list', () => {
    const secrets = [
      '.env',
      'deploy/docker/.env',
      '.env.local',
      'deploy/docker/.env.production',
      // An environment name that does not exist yet must not need a code
      // change to be caught.
      'deploy/docker/.env.1984',
      'apps/worker/.dev.vars',
      'apps/android/keystore.properties',
      'deploy/secrets/prod.pem',
      'apps/android/app/release.jks',
      'apps/ios/fastlane/AuthKey_ABC123.p8',
      'deploy/tls/server.key',
      'scripts/id_rsa',
      'scripts/id_ed25519',
      '.npmrc',
      '.pgpass',
      'home/authorized_keys',
      // Template-ish spellings that are NOT the exempt suffixes.
      'deploy/docker/.env.Example',
      'deploy/docker/.env.dist',
      'deploy/docker/.env.example.local',
    ]
    const r = checkScope(secrets, { owned: [], notOwned: [] }, [...NEVER_WRITE_PATHS])
    expect(r.forbidden).toEqual(secrets)
  })

  // `trackedFiles`, never a bare `git ls-files`: under `fleet/verify` this
  // suite runs inside a `git archive` EXPORT of the commit under judgement,
  // which has no `.git` on purpose (`fleet-verify.yml` asserts its absence),
  // so a raw git call throws there and passes here. The shared helper answers
  // from the export's own tree instead, and refuses to return a vacuously
  // short list.
  it('permits every committed secret TEMPLATE actually tracked in this repo', () => {
    const templates = trackedFiles().filter((f) => /\.(example|sample|template)$/.test(f.slice(f.lastIndexOf('/') + 1)))
    // Guards the guard: if the repo ever stops tracking these, this test
    // would silently assert nothing.
    expect(templates).toEqual(expect.arrayContaining([
      '.env.example',
      '.env.live.example',
      'apps/ios/fastlane/.env.example',
      'deploy/docker/.env.example',
      'apps/android/keystore.properties.example',
    ]))
    const r = checkScope(templates, { owned: [], notOwned: [] }, [...NEVER_WRITE_PATHS])
    expect(r.forbidden).toEqual([])
  })

  it('gives up on an item after three failed attempts', () => {
    expect(MAX_ATTEMPTS_PER_ITEM).toBe(3)
  })

  it('sets a conservative first-night dispatch ceiling', () => {
    expect(LIMITS.maxDispatchesPerHour).toBeLessThanOrEqual(12)
  })
})

describe('readLaneModes', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function modesFile(content: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-lane-modes-'))
    dirs.push(dir)
    const file = join(dir, 'lanes.json')
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
    return file
  }

  it('parses the legacy bare-mode-string shape', () => {
    expect(readLaneModes(modesFile({ backend: 'live', ios: 'off' })))
      .toEqual({ backend: { mode: 'live' }, ios: { mode: 'off' } })
  })

  it('parses the object shape with engine and model', () => {
    const file = modesFile({ backend: { mode: 'live', engine: 'opencode', model: 'kimi-for-coding/k3-256k' } })
    expect(readLaneModes(file)).toEqual({
      backend: { mode: 'live', engine: 'opencode', model: 'kimi-for-coding/k3-256k' },
    })
  })

  it('accepts both shapes in the same file', () => {
    const file = modesFile({ backend: 'live', ios: { mode: 'shadow', engine: 'opencode' } })
    expect(readLaneModes(file)).toEqual({
      backend: { mode: 'live' },
      ios: { mode: 'shadow', engine: 'opencode' },
    })
  })

  it('rejects an invalid engine: lane stays off and the reason is reported', () => {
    const onReject = vi.fn()
    const file = modesFile({ backend: { mode: 'live', engine: 'gpt' } })
    expect(readLaneModes(file, onReject)).toEqual({})
    expect(onReject).toHaveBeenCalledOnce()
    expect(onReject.mock.calls[0]?.[0]).toBe('backend')
    expect(onReject.mock.calls[0]?.[1]).toMatch(/invalid engine/i)
  })

  it('rejects an invalid mode: lane stays off and the reason is reported', () => {
    const onReject = vi.fn()
    const file = modesFile({ backend: { mode: 'turbo' }, ios: 'shadow' })
    expect(readLaneModes(file, onReject)).toEqual({ ios: { mode: 'shadow' } })
    expect(onReject).toHaveBeenCalledOnce()
    expect(onReject.mock.calls[0]?.[1]).toMatch(/invalid mode/i)
  })

  it('rejects unknown keys in the object shape', () => {
    const onReject = vi.fn()
    const file = modesFile({ backend: { mode: 'live', engine: 'opencode', model: 'kimi', cap: 5 } })
    expect(readLaneModes(file, onReject)).toEqual({})
    expect(onReject).toHaveBeenCalledOnce()
    expect(onReject.mock.calls[0]?.[1]).toMatch(/unknown override key/i)
    expect(onReject.mock.calls[0]?.[1]).toContain('cap')
  })

  it('rejects a non-string model', () => {
    const onReject = vi.fn()
    const file = modesFile({ backend: { mode: 'live', engine: 'opencode', model: 42 } })
    expect(readLaneModes(file, onReject)).toEqual({})
    expect(onReject.mock.calls[0]?.[1]).toMatch(/invalid model/i)
  })

  it('rejects unrecognized entry shapes (numbers, arrays, null)', () => {
    const onReject = vi.fn()
    const file = modesFile({ backend: 1, ios: ['live'], android: null })
    expect(readLaneModes(file, onReject)).toEqual({})
    expect(onReject).toHaveBeenCalledTimes(3)
  })

  it('never throws on malformed JSON — every lane stays off', () => {
    const onReject = vi.fn()
    expect(readLaneModes(modesFile('{not json'), onReject)).toEqual({})
  })

  it('never throws on a missing file — every lane stays off', () => {
    expect(readLaneModes(join(tmpdir(), 'definitely-not-here-lanes.json'))).toEqual({})
  })

  // Regression for the fleet/review FAIL on PR #840: a `"__proto__"` key in
  // lanes.json assigned onto a plain object literal sets the map's PROTOTYPE
  // instead of an own property, so `modes[unlistedLane]` would inherit the
  // poisoned override — a fail-open that turns every lane live. The fixtures
  // must be raw strings: an object literal `{"__proto__": ...}` in test code
  // would itself set the fixture's prototype and JSON.stringify would drop it.
  it('fails closed on a __proto__ object entry: only real lanes are read, the key is reported', () => {
    const onReject = vi.fn()
    const file = modesFile('{"__proto__":{"mode":"live"},"backend":"live"}')
    const modes = readLaneModes(file, onReject)
    expect(modes).toEqual({ backend: { mode: 'live' } })
    expect(Object.hasOwn(modes, '__proto__')).toBe(false)
    for (const id of ['shared', 'desktop', 'ios', 'android', 'infra']) {
      expect(modes[id]).toBeUndefined()
    }
    expect(onReject).toHaveBeenCalledOnce()
    expect(onReject.mock.calls[0]?.[0]).toBe('__proto__')
    expect(onReject.mock.calls[0]?.[1]).toMatch(/unknown lane id/i)
  })

  it('fails closed on a __proto__ string entry: every lane stays off, the key is reported', () => {
    const onReject = vi.fn()
    const file = modesFile('{"__proto__":"live"}')
    const modes = readLaneModes(file, onReject)
    expect(modes).toEqual({})
    for (const id of ['backend', 'shared', 'desktop', 'ios', 'android', 'infra']) {
      expect(modes[id]).toBeUndefined()
    }
    expect(onReject).toHaveBeenCalledOnce()
    expect(onReject.mock.calls[0]?.[0]).toBe('__proto__')
  })

  it('rejects other prototype-chain keys (constructor, prototype) as unknown lane ids', () => {
    const onReject = vi.fn()
    const file = modesFile('{"constructor":{"mode":"live"},"prototype":"live","backend":"shadow"}')
    expect(readLaneModes(file, onReject)).toEqual({ backend: { mode: 'shadow' } })
    expect(onReject).toHaveBeenCalledTimes(2)
  })

  it('rejects unknown lane ids generally — ignored and reported, never silently kept', () => {
    const onReject = vi.fn()
    const file = modesFile({ backend: 'shadow', marketing: 'live' })
    expect(readLaneModes(file, onReject)).toEqual({ backend: { mode: 'shadow' } })
    expect(onReject).toHaveBeenCalledOnce()
    expect(onReject.mock.calls[0]?.[0]).toBe('marketing')
    expect(onReject.mock.calls[0]?.[1]).toMatch(/unknown lane id/i)
  })

  // Mutation guard: the map MUST be null-prototype. Reverting
  // `Object.create(null)` to a plain `{}` literal must fail this test even
  // though the LANE_IDS allowlist alone would still reject a `__proto__` key —
  // the two defenses are independent on purpose.
  it('returns a null-prototype map so lookups can never consult a prototype chain', () => {
    const file = modesFile({ backend: 'live' })
    expect(Object.getPrototypeOf(readLaneModes(file))).toBeNull()
  })
})
