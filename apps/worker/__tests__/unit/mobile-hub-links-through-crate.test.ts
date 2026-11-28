/**
 * The condition the wire spec's codegen amendment is accepted on (#3133, §5.1
 * "Amended by #3133"): the hub-chain link schemas are excluded from codegen
 * only because the mobile clients build, sign and verify links through the
 * crate (UniFFI) and never parse or assemble a signed field themselves.
 *
 * So no iOS or Android source may name a signed link field or a link body
 * type as a string literal, or call the crate's host-assembly ops
 * (`signingMessage`, `assemble`, `permsHash`): a client that did would be
 * building a link by hand. The clients pass an intent (`genesis`,
 * `bundlePolicy`, `roleGrant`, `roleRevoke`) to `mobileHubChainSign` and the
 * crate's answer straight on to the server.
 *
 * Exact string literals only — a localisation key such as
 * "recovery_group_initiate_title" is not the link type "recovery_group".
 * The generated UniFFI bindings are the crate's own surface and are skipped.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '../../../..')
const SOURCES = [
  { dir: 'apps/ios/Sources', ext: '.swift' },
  { dir: 'apps/android/app/src/main', ext: '.kt' },
]
const GENERATED = [/^apps\/ios\/Sources\/Generated\//, /\/org\/llamenos\/core\/llamenos_core\.kt$/]

/** Signed link fields, link body types, and the crate ops only a host assembling a link would call. */
export const FORBIDDEN_LITERALS = new Set([
  'prevHash', 'prev_hash', 'entryHash', 'entry_hash', 'signerDevice', 'permsHash', 'payloadJson',
  'role_grant', 'role_revoke', 'group_epoch', 'escrow_set', 'connector_enroll', 'connector_revoke',
  'recovery_group', 'checkpoint',
  'signingMessage', 'assemble',
])

function walk(dir: string, ext: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, ext))
    else if (p.endsWith(ext)) out.push(p)
  }
  return out
}

/** `file:line literal` for every forbidden exact string literal in `text`. */
export function forbiddenLiterals(file: string, text: string): string[] {
  const hits: string[] = []
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    if (FORBIDDEN_LITERALS.has(m[1])) hits.push(`${file}:${text.slice(0, m.index).split('\n').length} ${m[1]}`)
  }
  return hits
}

const mobileFiles = SOURCES.flatMap(({ dir, ext }) => walk(join(ROOT, dir), ext))
  .map(p => relative(ROOT, p))
  .filter(f => !GENERATED.some(g => g.test(f)))

describe('mobile clients build hub links only through the crate (#3133)', () => {
  it('the scan sees both clients', () => {
    expect(mobileFiles.filter(f => f.endsWith('.swift')).length).toBeGreaterThan(50)
    expect(mobileFiles.filter(f => f.endsWith('.kt')).length).toBeGreaterThan(50)
    expect(mobileFiles).toContain('apps/ios/Sources/Services/HubChainService.swift')
    expect(mobileFiles).toContain('apps/android/app/src/main/java/org/llamenos/hotline/hub/HubChainService.kt')
  })

  it('flags a hand-built link, in Swift and in Kotlin', () => {
    expect(forbiddenLiterals('x.swift', 'let u = ["seq": 2, "prevHash": prev["entryHash"]]')).toHaveLength(2)
    expect(forbiddenLiterals('x.kt', 'put("body", buildJsonObject { put("type", "role_grant") })')).toHaveLength(1)
    expect(forbiddenLiterals('x.kt', 'buildJsonObject { put("op", "assemble") }')).toHaveLength(1)
    expect(forbiddenLiterals('x.swift', 'NSLocalizedString("recovery_group_initiate_title", comment: "")')).toEqual([])
  })

  it('no iOS or Android source names a signed link field or body type', () => {
    const hits = mobileFiles.flatMap(f => forbiddenLiterals(f, readFileSync(join(ROOT, f), 'utf8')))
    expect(hits, 'build the link through the crate (mobileHubChainSign) — never by hand').toEqual([])
  })

  it('each client signs links only through the crate\'s intent signer', () => {
    const ios = readFileSync(join(ROOT, 'apps/ios/Sources/Services/CryptoService.swift'), 'utf8')
    const android = readFileSync(join(ROOT, 'apps/android/app/src/main/java/org/llamenos/hotline/crypto/CryptoService.kt'), 'utf8')
    expect(ios).toContain('mobileHubChainSign(requestJson:')
    expect(android).toContain('org.llamenos.core.mobileHubChainSign(')
  })
})
