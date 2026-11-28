/**
 * Every `*Hash` / `*Hashes` field of the wire contract is registered with the
 * way its value is derived — and every place that assigns one comes from that
 * derivation, or writes nothing (#2779, #3114).
 *
 * Why: `statusHash`, `severityHash`, `contactTypeHash` and `categoryHash` were named
 * and documented as blind indexes, and held the plaintext value. Nobody
 * noticed for months because a field's NAME was the only claim about it. A
 * later `priorityHash` or `sourceHash` must not arrive the same way.
 *
 * Three checks, each of which fails the build:
 *   1. Every `*Hash`/`*Hashes` key declared under `packages/protocol/schemas`
 *      has an entry in `packages/protocol/hash-field-registry.json`, and every
 *      entry names a field that is still declared (no stale entry).
 *   2. Each entry names its producer: a function or constant that exists, in the
 *      file it names (an HMAC helper and its key label, a chain-digest function,
 *      a SHA-256 of the canonical bytes), or `debt: #NNNN` for a field that holds a
 *      plain value today, or `empty` for one every writer leaves empty.
 *   3. Every write site of a registered field in the worker, the seeders and the
 *      three clients assigns from the named producer, forwards the same field from
 *      another object, writes nothing (`[]`, `null`, `nil`), or is listed under the
 *      entry's `plainValueSites` with the reason. A new writer that assigns a
 *      plain value — the `statusHash = selectedType.defaultStatus` shape — fails.
 *
 * What it does NOT see: a write the line scan cannot read as `name: value` or
 * `name = value` (a computed key, a value built across lines). The registry is a
 * review aid with a mechanical floor, not a proof; the reviewer still reads the
 * diff of the registry itself.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '../../../..')

type Producer =
  | { kind: 'hmac' | 'digest' | 'chain'; file: string; symbol: string }
  | { kind: 'empty' }
  | { kind: 'debt'; issue: number; why: string }

interface Entry {
  derivation: string
  producer: Producer
  /** Regexes (as strings) an assigned value may match, beyond the producer symbol. */
  accepts?: string[]
  /** Write sites that assign a plain value today, each with its reason. Debt only. */
  plainValueSites?: Array<{ file: string; match: string; why: string }>
}

interface Registry { fields: Record<string, Entry> }

const registry: Registry = JSON.parse(readFileSync(join(ROOT, 'packages/protocol/hash-field-registry.json'), 'utf8'))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '__tests__', 'generated', 'build', 'dist', '.gradle', '.build'].includes(name)) continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|swift|kt)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

/** Every `xxxHash` / `xxxHashes` key a schema under packages/protocol/schemas declares. */
function declaredHashFields(): string[] {
  const found = new Set<string>()
  for (const file of walk(join(ROOT, 'packages/protocol/schemas'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\b([A-Za-z]+Hash(?:es)?)\??\s*:/g)) found.add(m[1])
  }
  return [...found].sort()
}

const SCAN_ROOTS = ['apps/worker', 'src/client', 'apps/ios/Sources', 'apps/android/app/src/main']

const TYPE_TOKEN = /^(string|String|number|Number|Int|Long|Boolean|boolean|\[String\]|List<|Array<|Record<|Set<|Map<|z\.|text\(|jsonb\(|unknown|Promise<|Data\b|Date\b)/
const EMPTY = /^(\[\]|nil|null|undefined|emptyList\(\)|listOf\(\))/

interface Site { file: string; line: number; field: string; rhs: string }

function writeSites(field: string): Site[] {
  const sites: Site[] = []
  const re = new RegExp(`(?<![\\w.])${field}\\??\\s*(?::|(?<![=!<>])=(?!=))\\s*(.*)$`)
  for (const root of SCAN_ROOTS) {
    for (const path of walk(join(ROOT, root))) {
      const lines = readFileSync(path, 'utf8').split('\n')
      lines.forEach((text, i) => {
        const trimmed = text.trim()
        if (/^(\/\/|\*|\/\*|case\b)/.test(trimmed)) return
        const m = re.exec(text)
        if (!m) return
        const rhs = m[1].trim()
        if (rhs === '' || TYPE_TOKEN.test(rhs)) return
        sites.push({ file: relative(ROOT, path), line: i + 1, field, rhs })
      })
    }
  }
  return sites
}

describe('hash-field registry (#2779, #3114)', () => {
  const declared = declaredHashFields()

  it('registers every *Hash / *Hashes field the schemas declare', () => {
    const unregistered = declared.filter(f => !(f in registry.fields))
    expect(
      unregistered,
      `declared in packages/protocol/schemas but missing from hash-field-registry.json: ${unregistered.join(', ')}. ` +
        'Say how its value is derived (an HMAC helper and its key label, a chain digest, a SHA-256 of canonical bytes) ' +
        'or register it as `debt: #NNNN`. A field that holds a plain value under a hash name is the defect this exists to stop.',
    ).toEqual([])
  })

  it('has no entry for a field no schema declares', () => {
    const stale = Object.keys(registry.fields).filter(f => !declared.includes(f))
    expect(stale, `registered but no longer declared: ${stale.join(', ')}`).toEqual([])
  })

  describe.each(Object.entries(registry.fields))('%s', (field, entry) => {
    it('names a producer that exists', () => {
      const p = entry.producer
      if (p.kind === 'empty') return
      if (p.kind === 'debt') {
        expect(Number.isInteger(p.issue) && p.issue > 0, `${field}: debt must cite an issue`).toBe(true)
        expect(p.why.length, `${field}: debt must say why`).toBeGreaterThan(20)
        return
      }
      const path = join(ROOT, p.file)
      expect(existsSync(path), `${field}: producer file ${p.file} does not exist`).toBe(true)
      expect(readFileSync(path, 'utf8'), `${field}: ${p.symbol} is not in ${p.file}`).toContain(p.symbol)
    })

    it('is only ever assigned from its producer, a forward of itself, or nothing', () => {
      const p = entry.producer
      const accepts = (entry.accepts ?? []).map(a => new RegExp(a))
      const producerSymbol = 'symbol' in p ? p.symbol : null
      const violations: string[] = []
      const plainValueSites = entry.plainValueSites ?? []
      const used = new Set<number>()

      for (const s of writeSites(field)) {
        if (EMPTY.test(s.rhs)) continue
        if (new RegExp(`\\b${field}\\b`).test(s.rhs)) continue // a forward of the same field
        if (producerSymbol && s.rhs.includes(producerSymbol)) continue
        if (accepts.some(a => a.test(s.rhs))) continue
        const idx = plainValueSites.findIndex(x => x.file === s.file && new RegExp(x.match).test(s.rhs))
        if (idx >= 0) { used.add(idx); continue }
        violations.push(`${s.file}:${s.line}  ${field}: ${s.rhs}`)
      }

      expect(
        violations,
        `${field} is assigned a value that does not come from its registered producer (${JSON.stringify(p)}). ` +
          'If it is derived, route it through the producer. If it is a plain value, that is debt: list the site ' +
          'under plainValueSites with the follow-up issue — never a status, severity or contact type.',
      ).toEqual([])

      const unused = plainValueSites.filter((_, i) => !used.has(i)).map(x => `${x.file} /${x.match}/`)
      expect(unused, `${field}: plainValueSites entries that match no write site (remove them)`).toEqual([])
    })
  })

  it('names no retired field', () => {
    for (const retired of ['statusHash', 'severityHash', 'contactTypeHash', 'categoryHash']) {
      expect(declared, `${retired} is a retired plaintext field (#2779, #3114)`).not.toContain(retired)
    }
  })
})
