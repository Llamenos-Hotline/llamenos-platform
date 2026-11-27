/**
 * The effective TLS trust configuration of the shipped clients, extracted from
 * source as VALUES (#3069).
 *
 * A trust anchor used to be a FILE: `TRUST_ANCHOR_FILES` named nine paths and
 * demanded a human signature whenever a PR touched one, whatever the diff did.
 * Six of the nine are ordinary development surfaces (the whole Android HTTP
 * surface, the manifest, `project.yml`…), so most signatures were demanded for
 * diffs that changed no trust decision at all. This module inverts that: it
 * reads the tree and produces ONE document — the trust snapshot — and the
 * question "did the trust decision change" becomes "did the snapshot change".
 * Touching an anchor file is free; changing what it MEANS is what shows up.
 *
 * What the snapshot captures, per client:
 *
 *  - the pinned SPKI hash SET (so reordering is not a change), resolved from the
 *    code that builds it, not from every literal that happens to sit nearby;
 *  - Android's `<network-security-config>` (`<base-config>`, `<trust-anchors>`,
 *    `<domain-config>`, `<pin-set>`) and the manifest attributes that point at it
 *    or set cleartext policy (`networkSecurityConfig`, `usesCleartextTraffic`);
 *  - iOS App Transport Security, from `Info.plist` AND from what `project.yml`
 *    writes into it (XcodeGen regenerates the plist, so either can ship);
 *  - the desktop's `production_pins()` set, the plausibility check on a stored
 *    pin set, and the loopback / cleartext policy;
 *  - every place a client opens a network connection and WHAT PINNER IS HANDED
 *    TO IT (the argument expression, not a verdict), plus a digest of each
 *    function that enforces or exempts (the validators, the loopback checks);
 *  - the exact loopback-exemption predicates.
 *
 * What it does NOT capture — said here so nothing implies coverage it lacks:
 *
 *  - It records WHERE a pinner is applied and with what expression. It does not
 *    prove the expression is non-empty or non-default at runtime: a pinner
 *    built from an empty hash list reads the same as a real one. The derivation
 *    tests (pins re-derived from real certificates) and the digests of the
 *    enforcing functions are what cover that.
 *  - It is a textual scan, not a type-checked call graph. A connection opened
 *    through a transport API the scan does not know (`OTHER_TRANSPORT_APIS`) is
 *    invisible, as is one built through reflection, a macro, or a dependency
 *    that does its own networking. Linphone's SIP/TLS leg has its own stack and
 *    is anchored separately (see network_security_config.xml).
 *  - A loopback exemption is found by the literals it compares against
 *    (`"localhost"`, `LOCALHOST`, `CertificatePinner.DEFAULT`, …). An
 *    exemption written without any of them (a hostname suffix, say) is only
 *    seen where it also changes a captured function's digest.
 *
 * Pure: every function takes a `TreeReader`, so the same extraction runs over a
 * working tree (`fsReader`) and over a git object (`gitReader`) — the base and
 * the head of a PR, a release tag — without a checkout.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

// ---------------------------------------------------------------------------
// Reading a tree
// ---------------------------------------------------------------------------

/** A read-only view of a source tree: the working copy or a git object. */
export interface TreeReader {
  /** Every file under any prefix (a prefix may itself be a file), repo-relative, `/`-separated, sorted. */
  list(prefixes: readonly string[]): string[]
  /** The file's text, or `undefined` when the tree has no such file. */
  read(path: string): string | undefined
}

/** Raised when the tree no longer has a shape the extractor understands. The
 *  gate treats it as a refusal: a trust decision it cannot read is one it
 *  cannot vouch for, which is never "nothing changed". */
export class TrustExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TrustExtractionError'
  }
}

const SCANNED_EXTENSIONS: readonly string[] = ['.kt', '.kts', '.swift', '.rs', '.xml', '.plist', '.yml', '.yaml', '.java', '.m', '.mm', '.c', '.cc', '.cpp', '.h', '.hpp', '.js', '.ts']
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'build', '.gradle', 'target', 'Pods', 'DerivedData', 'vendor', '.build',
])

const isScanned = (p: string): boolean => SCANNED_EXTENSIONS.some((e) => p.endsWith(e))

/** The working tree under `root`. */
export function fsReader(root: string): TreeReader {
  const cache = new Map<string, string | undefined>()
  const walk = (rel: string, out: string[]): void => {
    let st
    try {
      st = statSync(join(root, rel))
    } catch {
      return
    }
    if (st.isFile()) {
      out.push(rel)
      return
    }
    if (!st.isDirectory()) return
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (SKIPPED_DIRS.has(name)) continue
      walk(rel === '' ? name : `${rel.replace(/\/$/, '')}/${name}`, out)
    }
  }
  return {
    list(prefixes) {
      const out: string[] = []
      for (const p of prefixes) walk(p.replace(/\/$/, ''), out)
      return [...new Set(out)].sort()
    },
    read(path) {
      if (!cache.has(path)) {
        try {
          cache.set(path, readFileSync(join(root, path), 'utf8'))
        } catch {
          cache.set(path, undefined)
        }
      }
      return cache.get(path)
    },
  }
}

const MAX_GIT_BYTES = 512 * 1024 * 1024

/** The tree at git revision `rev` in the repository at `repo`, read from
 *  objects — never from a checkout, so the head of a PR is data, not code. */
export function gitReader(repo: string, rev: string): TreeReader {
  const cache = new Map<string, string | undefined>()
  const run = (args: string[], input?: string): Buffer | undefined => {
    const r = spawnSync('git', ['-C', repo, ...args], { input, maxBuffer: MAX_GIT_BYTES, stdio: ['pipe', 'pipe', 'ignore'] })
    return r.status === 0 ? r.stdout : undefined
  }
  const preload = (paths: string[]): void => {
    const fresh = paths.filter((p) => !cache.has(p) && !p.includes('\n'))
    if (fresh.length === 0) return
    const out = run(['cat-file', '--batch'], fresh.map((p) => `${rev}:${p}\n`).join(''))
    if (out === undefined) return
    let offset = 0
    for (const p of fresh) {
      const nl = out.indexOf(0x0a, offset)
      if (nl < 0) break
      const header = out.subarray(offset, nl).toString('utf8')
      offset = nl + 1
      const m = /^[0-9a-f]{40,64} (\w+) (\d+)$/.exec(header)
      if (m === null) {
        cache.set(p, undefined)
        continue
      }
      const length = Number(m[2])
      cache.set(p, m[1] === 'blob' ? out.subarray(offset, offset + length).toString('utf8') : undefined)
      offset += length + 1
    }
  }
  return {
    list(prefixes) {
      const out = run(['ls-tree', '-r', '--name-only', '-z', rev, '--', ...prefixes.map((p) => p.replace(/\/$/, ''))])
      if (out === undefined) throw new TrustExtractionError(`could not list ${prefixes.join(', ')} at ${rev}`)
      const paths = out.toString('utf8').split('\0').filter((p) => p !== '').sort()
      preload(paths.filter(isScanned))
      return paths
    },
    read(path) {
      preload([path])
      return cache.get(path)
    },
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

type Lang = 'kotlin' | 'swift' | 'rust'

/** Index just past the string literal that starts at `i` (a `"`). */
function skipString(src: string, i: number): number {
  if (src.startsWith('"""', i)) {
    const end = src.indexOf('"""', i + 3)
    return end < 0 ? src.length : end + 3
  }
  let j = i + 1
  while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
  return Math.min(j + 1, src.length)
}

/** Index just past a Rust raw string `r#"…"#` starting at `i`, or -1. */
function skipRustRawString(src: string, i: number): number {
  let j = i + 1
  let hashes = 0
  while (src[j] === '#') {
    hashes += 1
    j += 1
  }
  if (src[j] !== '"') return -1
  const close = `"${'#'.repeat(hashes)}`
  const end = src.indexOf(close, j + 1)
  return end < 0 ? src.length : end + close.length
}

/**
 * Source with its comments blanked and its line structure kept. String
 * literals are skipped whole so a `//` inside a URL is not a comment. A trust
 * line that has been commented out is not a trust line, and a comment that
 * MENTIONS `"localhost"` must not read as an exemption.
 */
export function stripComments(src: string, lang: Lang): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i] as string
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && d === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth += 1
          i += 2
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth -= 1
          i += 2
        } else {
          if (src[i] === '\n') out += '\n'
          i += 1
        }
      }
      continue
    }
    if (c === '"') {
      const end = skipString(src, i)
      out += src.slice(i, end)
      i = end
      continue
    }
    if (lang === 'rust' && c === 'r' && (d === '"' || d === '#') && !/\w/.test(src[i - 1] ?? ' ')) {
      const end = skipRustRawString(src, i)
      if (end > 0) {
        out += src.slice(i, end)
        i = end
        continue
      }
    }
    if (c === "'") {
      // A char literal (`'"'`, `'\n'`) must not open a string; a Rust lifetime is just a quote.
      if (src[i + 1] !== '\\' && src[i + 2] === "'") {
        out += src.slice(i, i + 3)
        i += 3
        continue
      }
      if (src[i + 1] === '\\' && src[i + 3] === "'") {
        out += src.slice(i, i + 4)
        i += 4
        continue
      }
    }
    out += c
    i += 1
  }
  return out
}

/** Index of the bracket that closes the one at `open`, strings skipped; -1 if unbalanced. */
function matchBracket(code: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' }
  const stack: string[] = []
  for (let i = open; i < code.length; i += 1) {
    const c = code[i] as string
    if (c === '"') {
      i = skipString(code, i) - 1
      continue
    }
    if (pairs[c] !== undefined) stack.push(pairs[c] as string)
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort()
const sortedMulti = (xs: Iterable<string>): string[] => [...xs].sort()
const digestOf = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

const PIN_RE = /[A-Za-z0-9+/]{43}=/
const PIN_LITERAL_RE = /"(?:sha256\/)?([A-Za-z0-9+/]{43}=)"/g

function pinLiterals(code: string): string[] {
  return sortedUnique([...code.matchAll(PIN_LITERAL_RE)].map((m) => m[1] as string))
}

/** Index of the first `#[cfg(test)]` at or after `from` that is not inside a string literal, or -1. */
function nextCfgTest(code: string, from: number): number {
  const needle = '#[cfg(test)]'
  for (let i = from; i < code.length; i += 1) {
    const c = code[i] as string
    if (c === '"') {
      i = skipString(code, i) - 1
      continue
    }
    if (c === 'r' && (code[i + 1] === '"' || code[i + 1] === '#') && !/\w/.test(code[i - 1] ?? ' ')) {
      const end = skipRustRawString(code, i)
      if (end > 0) {
        i = end - 1
        continue
      }
    }
    if (c === '#' && code.startsWith(needle, i)) return i
  }
  return -1
}

/** Remove every Rust item gated by `#[cfg(test)]` — it does not ship. Throws
 *  when the item's end cannot be found: truncating to end-of-file would hide
 *  every trust function that follows, which is the parser differential this
 *  must not have. */
export function stripRustTests(code: string): string {
  let out = code
  let from = 0
  for (;;) {
    const at = nextCfgTest(out, from)
    if (at < 0) return out
    let i = at + '#[cfg(test)]'.length
    // Further attributes on the same item.
    for (;;) {
      const attr = /^\s*#\[/.exec(out.slice(i))
      if (attr === null) break
      const close = matchBracket(out, i + attr[0].length - 1)
      if (close < 0) throw new TrustExtractionError('an attribute after #[cfg(test)] is unbalanced')
      i = close + 1
    }
    let end = -1
    let depth = 0
    for (let j = i; j < out.length; j += 1) {
      const c = out[j] as string
      if (c === '"') {
        j = skipString(out, j) - 1
        continue
      }
      if (c === '(' || c === '[' || c === '{') depth += 1
      else if (c === ')' || c === ']') depth -= 1
      else if (c === '}') {
        depth -= 1
        if (depth === 0) {
          end = j + 1
          break
        }
      } else if (c === ';' && depth === 0) {
        end = j + 1
        break
      }
    }
    if (end < 0) throw new TrustExtractionError('could not find the end of an item gated by #[cfg(test)]')
    out = out.slice(0, at) + out.slice(end)
    from = at
  }
}

/** Bodies (normalised) of every function called `name`, `[]` when there is none. */
export function functionBodies(code: string, name: string, lang: Lang): string[] {
  const kw = lang === 'kotlin' ? 'fun' : lang === 'swift' ? 'func' : 'fn'
  const re = new RegExp(`(?:^|[^\\w.])${kw}\\s+(?:<[^>]*>\\s*)?(?:[\\w.<>?]+\\.)?${name}\\s*[(<]`, 'g')
  const out: string[] = []
  for (const m of code.matchAll(re)) {
    const paren = code.indexOf('(', m.index + m[0].length - 1)
    if (paren < 0) continue
    const closeParen = matchBracket(code, paren)
    if (closeParen < 0) continue
    // The first `{` or `=` after the parameters, outside any bracket, is the body's start.
    let i = closeParen + 1
    let depth = 0
    let bodyStart = -1
    let expression = false
    for (; i < code.length; i += 1) {
      const c = code[i] as string
      if (c === '(' || c === '[' || c === '<') depth += 1
      else if (c === ')' || c === ']' || (c === '>' && code[i - 1] !== '-' && code[i - 1] !== '=')) depth -= 1
      else if (depth <= 0 && c === '{') {
        bodyStart = i
        break
      } else if (depth <= 0 && c === '=' && lang === 'kotlin') {
        bodyStart = i
        expression = true
        break
      } else if (depth <= 0 && c === ';') break
    }
    if (bodyStart < 0) continue
    if (expression) {
      let j = bodyStart + 1
      let d = 0
      for (; j < code.length; j += 1) {
        const c = code[j] as string
        if (c === '"') {
          j = skipString(code, j) - 1
          continue
        }
        if (c === '(' || c === '{' || c === '[') d += 1
        else if (c === ')' || c === '}' || c === ']') d -= 1
        else if (c === '\n' && d <= 0 && !/^\s*(\.|\?:|&&|\|\||\+)/.test(code.slice(j + 1, j + 160))) break
      }
      out.push(squash(code.slice(paren, j)))
      continue
    }
    const end = matchBracket(code, bodyStart)
    if (end < 0) continue
    out.push(squash(code.slice(paren, end + 1)))
  }
  return out
}

/** The call expression starting at `at` (an identifier), through its matching `)`, normalised. */
function callText(code: string, at: number): string {
  const open = code.indexOf('(', at)
  if (open < 0) return squash(code.slice(at, at + 80))
  const close = matchBracket(code, open)
  return squash(code.slice(at, close < 0 ? at + 200 : close + 1))
}

/** The method names of a builder chain that starts at `at`, up to and
 *  including its `.build()` (or the end of the statement). */
function chainOf(code: string, at: number): string {
  let depth = 0
  let i = at
  for (; i < code.length; i += 1) {
    const c = code[i] as string
    if (c === '"') {
      i = skipString(code, i) - 1
      continue
    }
    if (c === '(' || c === '{' || c === '[') depth += 1
    else if (c === ')' || c === '}' || c === ']') {
      depth -= 1
      if (depth < 0) break
    } else if (depth === 0 && code.startsWith('.build()', i)) {
      i += '.build()'.length
      break
    } else if (depth === 0 && (c === ';' || (c === '\n' && !/^\s*(\.|\?\.)/.test(code.slice(i + 1, i + 160))))) break
    if (i - at > 4000) break
  }
  return code.slice(at, i)
}

/** The argument text of every `.name(...)` call inside `chain`, normalised. */
function methodArgs(chain: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`\\.${name}\\(`, 'g')
  for (const m of chain.matchAll(re)) {
    const open = m.index + m[0].length - 1
    const close = matchBracket(chain, open)
    out.push(squash(chain.slice(open + 1, close < 0 ? undefined : close)))
  }
  return out
}

const methodNames = (chain: string): string[] =>
  [...chain.matchAll(/\.\s*([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1] as string)

// ---------------------------------------------------------------------------
// XML and plist
// ---------------------------------------------------------------------------

interface XmlNode {
  tag: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const XML_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

/** Character data with its references resolved: the five predefined entities and numeric
 *  character references. Any other entity can only come from a DTD, which is refused. */
function xmlText(raw: string, at: number): string {
  return raw.replace(/&([^;&\s<]*);?/g, (ref, name: string, off: number) => {
    const hex = /^#x([0-9A-Fa-f]+)$/.exec(name)
    const dec = /^#([0-9]+)$/.exec(name)
    const code = hex !== null ? Number.parseInt(hex[1] as string, 16) : dec !== null ? Number(dec[1]) : undefined
    if (ref.endsWith(';') && code !== undefined && code <= 0x10ffff) return String.fromCodePoint(code)
    const known = XML_ENTITIES[name]
    if (ref.endsWith(';') && known !== undefined) return known
    throw new TrustExtractionError(`unreadable XML entity reference "${ref}" at offset ${at + off}`)
  })
}

const XML_TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y

/** A small, strict XML reader for the files that carry trust settings.
 *  Anything it cannot read is an error, never a silent skip.
 *
 *  One left-to-right pass, the way an XML parser reads: at each `<` the construct that STARTS
 *  there decides where it ends. Comments, PIs and the DOCTYPE are therefore never found by
 *  searching ahead, so a `<!--` inside a PI (or an attribute) cannot swallow the real markup
 *  between it and a later `-->` (#3074). What XML forbids — `--` in a comment, `<` in an
 *  attribute value, a duplicate attribute, an unterminated construct — is refused, and so is
 *  an internal DTD subset: an entity it declares would expand to markup this reader cannot see. */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  const fail = (at: number, why: string): never => {
    throw new TrustExtractionError(`${why} at offset ${at}, near "${src.slice(at, at + 40)}"`)
  }
  const closeOf = (at: number, open: string, close: string, what: string): number => {
    const end = src.indexOf(close, at + open.length)
    return end < 0 ? fail(at, `unterminated ${what}`) : end
  }
  let i = 0
  while (i < src.length) {
    const top = stack[stack.length - 1] as XmlNode
    if (src[i] !== '<') {
      const lt = src.indexOf('<', i)
      const end = lt < 0 ? src.length : lt
      top.text += xmlText(src.slice(i, end), i)
      i = end
    } else if (src.startsWith('<!--', i)) {
      const end = closeOf(i, '<!--', '-->', 'comment')
      const body = src.slice(i + 4, end)
      if (body.includes('--') || body.endsWith('-')) fail(i, 'a comment holding "--", which XML does not allow,')
      i = end + 3
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = closeOf(i, '<![CDATA[', ']]>', 'CDATA section')
      top.text += src.slice(i + 9, end)
      i = end + 3
    } else if (src.startsWith('<?', i)) {
      i = closeOf(i, '<?', '?>', 'processing instruction') + 2
    } else if (src.startsWith('<!DOCTYPE', i)) {
      const end = closeOf(i, '<!DOCTYPE', '>', 'DOCTYPE')
      if (src.slice(i, end).includes('[')) fail(i, 'an internal DTD subset, whose entities this reader does not expand,')
      i = end + 1
    } else {
      XML_TAG.lastIndex = i
      const m = XML_TAG.exec(src) ?? fail(i, 'unreadable XML')
      i += m[0].length
      if (m[1] === '/') {
        if (stack.length < 2 || top.tag !== m[2]) fail(m.index, `mismatched </${m[2]}>`)
        stack.pop()
        continue
      }
      const attrs: Record<string, string> = {}
      for (const a of (m[3] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const name = a[1] as string
        if (Object.hasOwn(attrs, name)) fail(m.index, `duplicate attribute ${name}`)
        attrs[name] = xmlText((a[2] ?? a[3]) as string, m.index)
      }
      const node: XmlNode = { tag: m[2] as string, attrs, children: [], text: '' }
      top.children.push(node)
      if (m[4] !== '/') stack.push(node)
    }
  }
  if (stack.length !== 1) throw new TrustExtractionError(`unclosed <${(stack[stack.length - 1] as XmlNode).tag}>`)
  return root
}

const kids = (n: XmlNode, tag: string): XmlNode[] => n.children.filter((c) => c.tag === tag)

function plistValue(node: XmlNode): unknown {
  switch (node.tag) {
    case 'true':
      return true
    case 'false':
      return false
    case 'string':
      return node.text.trim()
    case 'integer':
      return Number(node.text.trim())
    case 'real':
      return Number(node.text.trim())
    case 'array':
      return node.children.map(plistValue)
    case 'dict': {
      const out: Record<string, unknown> = {}
      for (let i = 0; i < node.children.length; i += 2) {
        const key = node.children[i]
        const value = node.children[i + 1]
        if (key?.tag !== 'key' || value === undefined) throw new TrustExtractionError('malformed plist dict')
        out[key.text.trim()] = plistValue(value)
      }
      return out
    }
    default:
      return `<${node.tag}>`
  }
}

/** The top-level dict of a property list. */
export function parsePlist(src: string): Record<string, unknown> {
  const root = parseXml(src)
  const plist = kids(root, 'plist')[0]
  const dict = plist === undefined ? undefined : kids(plist, 'dict')[0]
  if (dict === undefined) throw new TrustExtractionError('not a property list with a top-level dict')
  return plistValue(dict) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

export interface TrustSnapshot {
  schema: 1
  /** The pinned SPKI hashes each client enforces, as sets (sorted: reordering is not a change). */
  pins: {
    android: {
      /** What `DEFAULT_PIN_HASHES` resolves to — the OkHttp pinner's set. */
      okhttp: string[]
      /** Every `<pin>` of every shipped network security config. */
      osPinSets: string[]
      /** Every pin literal anywhere in shipped Kotlin: a pin that is defined but not used is visible. */
      literals: string[]
    }
    ios: { effective: string[]; literals: string[] }
    desktop: { effective: string[]; literals: string[] }
  }
  android: {
    networkSecurityConfigs: Record<string, unknown>
    manifests: Record<string, unknown>
    /** Gradle lines that choose which manifest/resources/values ship. */
    buildWiring: Record<string, string[]>
  }
  ios: {
    /** `NSAppTransportSecurity` as each shipped Info.plist holds it (null: the key is absent). */
    infoPlists: Record<string, unknown>
    /** What `project.yml` writes into the Info.plist, and the settings that choose which plist ships. */
    projectYml: unknown
  }
  /** Per source file: each place a connection is opened, and the pinner it is handed. */
  connections: {
    android: Record<string, unknown>
    ios: Record<string, unknown>
    desktop: Record<string, unknown>
  }
  /** Digest of the normalised body of every function that enforces or exempts a trust decision. */
  logic: Record<string, string>
  /** The code lines that exempt a host from pinning, per file. */
  loopbackExemptions: Record<string, string[]>
}

const ANDROID_SRC = 'apps/android/app/src/'
const ANDROID_GRADLE = 'apps/android/app/build.gradle.kts'
const IOS_ROOTS = ['apps/ios/Sources/', 'apps/ios/Resources/']
const IOS_PROJECT = 'apps/ios/project.yml'
const IOS_INFO_PLIST = 'apps/ios/Sources/App/Info.plist'
const DESKTOP_ROOT = 'apps/desktop/src/'
const ANDROID_MAIN_NSC = 'apps/android/app/src/main/res/xml/network_security_config.xml'
const ANDROID_MAIN_MANIFEST = 'apps/android/app/src/main/AndroidManifest.xml'

/** Android source sets that never reach a release build, by exact name (see write-gate.ts). */
const ANDROID_NON_SHIPPING: ReadonlySet<string> = new Set([
  'test', 'androidTest', 'testFixtures', 'debug',
  'testDebug', 'testRelease', 'androidTestDebug', 'androidTestRelease',
])

function androidShipped(path: string): boolean {
  if (!path.startsWith(ANDROID_SRC)) return false
  return androidSourceSetShips(path.slice(ANDROID_SRC.length).split('/')[0] ?? '')
}

/** Whether the Android source set called `name` can reach a release build. One answer for
 *  both questions that ask it: which files under `src/` are scanned, and which Gradle wiring is recorded. */
function androidSourceSetShips(name: string): boolean {
  return !ANDROID_NON_SHIPPING.has(name)
}

/** Transport APIs, beyond the pinned clients, through which a connection could be opened.
 *  Each entry is the START of an identifier, searched for anywhere (a search, so unanchored on
 *  purpose): `Socket` finds `Socket(…)` after `import java.net.*`, `java.net.Socket` and
 *  `SocketFactory` alike. `countApis` counts every hit under the whole identifier it begins. */
const OTHER_TRANSPORT_APIS: Record<Lang, readonly string[]> = {
  kotlin: [
    'HttpURLConnection', 'HttpsURLConnection', 'openConnection', 'Socket', 'SSLSocket', 'SSLContext',
    'X509\\w*TrustManager', 'TrustManagerFactory', 'HostnameVerifier', 'hostnameVerifier', 'Cronet', 'Retrofit', 'HttpClient',
    'DatagramSocket', 'WebView', 'DownloadManager',
  ],
  swift: [
    'NSURLConnection', 'CFHTTP', 'CFStream', 'NWConnection', 'NWParameters', 'nw_connection', 'WKWebView', 'SFSafariViewController',
    'SecTrust\\w*', 'SecPolicy\\w*', 'URLSessionStreamTask', 'URLSessionDownloadTask',
  ],
  rust: [
    'TcpStream::connect', 'ureq', 'hyper::Client', 'isahc', 'surf::', 'danger_accept_invalid\\w*', 'add_root_certificate',
    'tls_built_in_root_certs', '\\.dangerous\\(\\)', 'with_custom_certificate_verifier', 'RootCertStore', 'ServerCertVerifier',
    'ClientConfig::builder', 'tauri_plugin_http', 'tauri_plugin_websocket', 'native_tls', 'openssl',
  ],
}

/**
 * Each transport identifier a pattern begins, with how often it occurs. The key is the
 * identifier as written (`SecTrustEvaluateWithError`, `SocketFactory`), never the pattern: one
 * count per pattern would lump `SocketTimeoutException` with `Socket`, so removing one and
 * adding the other would leave the count, and the snapshot, where they were (#3074).
 */
function countApis(code: string, apis: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const api of apis) {
    for (const m of code.matchAll(new RegExp(`${api.startsWith('\\.') ? '' : '\\b'}${api}\\w*`, 'g'))) {
      out[m[0]] = (out[m[0]] ?? 0) + 1
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

const LOOPBACK_RE = /localhost|127\.0\.0\.1|::1|10\.0\.2\.2|loopback|CertificatePinner\.DEFAULT/i

/** Functions whose body is part of the trust decision, by language. A missing
 *  function is not an error: its absence is a snapshot change. */
const LOGIC_FUNCTIONS: Record<Lang, readonly string[]> = {
  kotlin: ['buildPinner', 'configurePinning', 'pinnerFor', 'hostOf', 'applyTlsTrustAnchor'],
  swift: ['evaluate', 'isLoopback', 'pin', 'der', 'sha256Base64'],
  rust: [
    'verify_server_cert', 'path_matches_pin', 'anchor_pin', 'cert_pin', 'build_pinned_reqwest_client', 'build_probe_client',
    'production_pins', 'enforced_pins', 'is_plausible_spki_pin', 'is_loopback_host', 'check_backend_url', 'configured_pins',
    'store_pins', 'capture_pins', 'capture_pins_with',
  ],
}

const langOf = (path: string): Lang | undefined =>
  path.endsWith('.kt') || path.endsWith('.kts') ? 'kotlin' : path.endsWith('.swift') ? 'swift' : path.endsWith('.rs') ? 'rust' : undefined

/** Code lines (comments gone) a regex hits, whitespace-squashed. */
function matchingLines(code: string, re: RegExp): string[] {
  return code.split('\n').map(squash).filter((l) => l !== '' && re.test(l))
}

/** The Android source set a Gradle selector names — `getByName("x")`, `named("x")`, `create("x")`,
 *  `maybeCreate("x")`, `register("x")`, `sourceSets["x"]`, `val x by getting` — or `null` when it is
 *  written in a way that cannot be read as one literal name. `undefined` means "not a selector". */
const SOURCE_SET_SELECTOR_RE = /\b(?:getByName|named|create|maybeCreate|register)\(\s*("[^"$]*"|[^)]*)\)|\bsourceSets\[\s*("[^"$]*"|[^\]]*)\]|\bval\s+(\w+)\s+by\s+(?:getting|creating|existing)\b/g

function selectedSourceSets(text: string): (string | null)[] {
  return [...text.matchAll(SOURCE_SET_SELECTOR_RE)].map((m) => {
    const lit = m[1] ?? m[2]
    if (m[3] !== undefined) return m[3]
    const q = /^"([^"$]+)"$/.exec((lit ?? '').trim())
    return q === null ? null : (q[1] as string)
  })
}

/** What a Gradle block says about itself: it is a `sourceSets { }` container, or it is one source set
 *  (`undefined` = neither, `null` = a source set whose name is not one string literal). */
type GradleFrame = { container: boolean; sourceSet?: string | null }

function gradleFrame(header: string, parentIsContainer: boolean): GradleFrame {
  const h = header.trim()
  if (/(?:^|[.\s])sourceSets$/.test(h)) return { container: true }
  if (!parentIsContainer) return { container: false }
  // A direct child of a `sourceSets { }` block is a source set: by selector, or by bare name (`androidTest {`).
  const sel = selectedSourceSets(h)
  if (sel.length > 0) return { container: false, sourceSet: sel.length === 1 ? (sel[0] as string | null) : null }
  const bare = /^(\w+)$/.exec(h)
  return { container: false, sourceSet: bare === null ? null : (bare[1] as string) }
}

/** `code` with the text that sits inside a non-shipping source set blanked out, line structure kept. Text is
 *  attributed character by character, so a block opened and closed on one line (`androidTest { … }`) is
 *  attributed too. `undefined` when the braces do not balance: nothing can then be attributed. */
function withoutNonShippingSourceSets(code: string): string[] | undefined {
  const lines: string[] = ['']
  const stack: GradleFrame[] = []
  const owner = (): string | null | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1) if ((stack[i] as GradleFrame).sourceSet !== undefined) return (stack[i] as GradleFrame).sourceSet
    return undefined
  }
  let header = ''
  const emit = (ch: string): void => {
    const o = owner()
    if (ch === '\n') lines.push('')
    else if (!(typeof o === 'string' && !androidSourceSetShips(o))) lines[lines.length - 1] += ch
  }
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i] as string
    if (c === '"') {
      const end = skipString(code, i)
      for (const ch of code.slice(i, end)) emit(ch)
      header += code.slice(i, end)
      i = end - 1
      continue
    }
    if (c === '{') {
      emit(c)
      stack.push(gradleFrame(header, stack.length > 0 && (stack[stack.length - 1] as GradleFrame).container))
      header = ''
      continue
    }
    if (c === '}') {
      if (stack.pop() === undefined) return undefined
      emit(c)
      header = ''
      continue
    }
    emit(c)
    header = c === ';' ? '' : header + (c === '\n' ? ' ' : c)
  }
  return stack.length === 0 ? lines : undefined
}

/**
 * The lines of a Gradle build script (comments already gone) that wire the build, minus the text that
 * sits in a source set no release build contains. The discriminator is the ENCLOSING BLOCK, which a line
 * grep cannot see: `kotlin.srcDir("src/androidTest/…")` is a test helper inside `getByName("test")` and
 * a change to what ships inside `getByName("main")`.
 *
 * Fail safe: text is dropped only when it is positively inside one source set that
 * `androidSourceSetShips` says cannot ship. A selector that is not a string literal, several selectors
 * on one line, unbalanced braces, or anything outside a source set stays in the snapshot.
 */
function gradleWiringLines(code: string, re: RegExp): string[] {
  const kept = withoutNonShippingSourceSets(code)
  if (kept === undefined) return matchingLines(code, re)
  return kept.flatMap((raw) => {
    const line = squash(raw)
    if (line === '' || !re.test(line)) return []
    if (/\bsourceSets\b/.test(line) && !line.includes('{')) {
      // `sourceSets.getByName("androidTest").java.srcDir("x")` — the selector is on the line itself.
      const sel = selectedSourceSets(line)
      if (sel.length === 1 && sel[0] !== null && !androidSourceSetShips(sel[0])) return []
    }
    return [line]
  })
}

function requireText(tree: TreeReader, path: string, why: string): string {
  const text = tree.read(path)
  if (text === undefined) throw new TrustExtractionError(`${path} is missing — ${why}`)
  return text
}

// -- Android -----------------------------------------------------------------

function nscSummary(root: XmlNode): { summary: unknown; pins: string[] } {
  const cfg = kids(root, 'network-security-config')[0]
  if (cfg === undefined) throw new TrustExtractionError('no <network-security-config> root element')
  const pins: string[] = []
  const anchors = (n: XmlNode | undefined): string[] =>
    n === undefined
      ? []
      : sortedUnique(
          kids(n, 'trust-anchors').flatMap((ta) =>
            ta.children.map((c) => `${c.tag}:${c.attrs['src'] ?? ''}${c.attrs['overridePins'] === undefined ? '' : `;overridePins=${c.attrs['overridePins']}`}`),
          ),
        )
  const base = kids(cfg, 'base-config')[0]
  const domainConfig = (dc: XmlNode): unknown => {
    const pinSet = kids(dc, 'pin-set')[0]
    const own = pinSet === undefined ? [] : kids(pinSet, 'pin').map((p) => `${p.attrs['digest'] ?? ''}:${p.text.trim()}`)
    pins.push(...own.map((p) => p.slice(p.indexOf(':') + 1)))
    return {
      domains: sortedUnique(kids(dc, 'domain').map((d) => `${d.text.trim()}|includeSubdomains=${d.attrs['includeSubdomains'] ?? 'false'}`)),
      cleartextTrafficPermitted: dc.attrs['cleartextTrafficPermitted'] ?? null,
      trustAnchors: anchors(dc),
      pinSet: pinSet === undefined ? null : { expiration: pinSet.attrs['expiration'] ?? null, pins: sortedUnique(own) },
      nested: dc.children.filter((c) => c.tag === 'domain-config').map(domainConfig),
    }
  }
  const domainConfigs = kids(cfg, 'domain-config').map(domainConfig)
  return {
    pins: sortedUnique(pins),
    summary: {
      baseConfig: base === undefined ? null : { cleartextTrafficPermitted: base.attrs['cleartextTrafficPermitted'] ?? null, trustAnchors: anchors(base) },
      domainConfigs: domainConfigs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      debugOverrides: kids(cfg, 'debug-overrides').map((d) => ({ trustAnchors: anchors(d) })),
      // Every element the config uses, so one this extractor does not model (a new section) still moves the snapshot.
      elements: sortedUnique(
        (function names(n: XmlNode): string[] { return [n.tag, ...n.children.flatMap(names)] })(cfg),
      ),
    },
  }
}

function manifestSummary(root: XmlNode): unknown {
  const manifest = kids(root, 'manifest')[0]
  if (manifest === undefined) throw new TrustExtractionError('no <manifest> root element')
  const apps = kids(manifest, 'application')
  const pick = (a: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(a)
        .filter(([k]) => /networkSecurityConfig|usesCleartextTraffic|^tools:/.test(k))
        .sort(([x], [y]) => x.localeCompare(y)),
    )
  return { applications: apps.map((a) => pick(a.attrs)), manifestToolsAttributes: pick(manifest.attrs) }
}

function androidKotlin(tree: TreeReader, files: string[]): {
  pins: TrustSnapshot['pins']['android']
  connections: Record<string, unknown>
} {
  const kt = files.filter((f) => f.endsWith('.kt') && androidShipped(f))
  const code = new Map<string, string>()
  for (const f of kt) code.set(f, stripComments(requireText(tree, f, 'listed but unreadable'), 'kotlin'))

  // Named pin constants, wherever they live: `const val ISRG_ROOT_X1_HASH = "sha256/…"`.
  const constants = new Map<string, string>()
  for (const c of code.values()) {
    for (const m of c.matchAll(/\bval\s+([A-Za-z_]\w*)\s*(?::\s*String\s*)?=\s*"(?:sha256\/)?([A-Za-z0-9+/]{43}=)"/g)) {
      constants.set(m[1] as string, m[2] as string)
    }
  }
  let okhttp: string[] | undefined
  for (const [f, c] of code) {
    const m = /\bval\s+DEFAULT_PIN_HASHES\b[^=]*=\s*(?:listOf|setOf|arrayOf|persistentListOf)\s*\(/.exec(c)
    if (m === null) continue
    const open = c.indexOf('(', m.index + m[0].length - 1)
    const close = matchBracket(c, open)
    if (close < 0) throw new TrustExtractionError(`DEFAULT_PIN_HASHES in ${f} is unbalanced`)
    const resolved: string[] = []
    for (const part of c.slice(open + 1, close).split(',').map(squash).filter((p) => p !== '')) {
      const lit = /^"(?:sha256\/)?([A-Za-z0-9+/]{43}=)"$/.exec(part)
      const hash = lit !== null ? lit[1] : constants.get(part.replace(/^[A-Za-z_]\w*\./, ''))
      if (hash === undefined) throw new TrustExtractionError(`DEFAULT_PIN_HASHES in ${f} names "${part}", which is not a pin constant or literal`)
      resolved.push(hash)
    }
    okhttp = sortedUnique([...(okhttp ?? []), ...resolved])
  }
  if (okhttp === undefined) throw new TrustExtractionError('DEFAULT_PIN_HASHES was not found in any shipped Android source')

  const connections: Record<string, unknown> = {}
  for (const [f, c] of code) {
    const clients: string[] = []
    const derived: string[] = []
    for (const m of c.matchAll(/\bOkHttpClient\s*(?:\.\s*Builder\s*\(\s*\)|\(\s*\))/g)) {
      const chain = chainOf(c, m.index)
      clients.push(`${m[0].replace(/\s+/g, '')} pinner=[${methodArgs(chain, 'certificatePinner').join(' | ') || 'none'}]`)
    }
    for (const m of c.matchAll(/\.newBuilder\s*\(\s*\)/g)) {
      const chain = chainOf(c, m.index)
      // `request.newBuilder()` / `response.newBuilder()` rebuild a message, not a client.
      if (/\.(?:addHeader|header|removeHeader|headers|url|post|put|patch|delete|method|body|code|message|tag)\(/.test(chain)) continue
      derived.push(`newBuilder pinner=[${methodArgs(chain, 'certificatePinner').join(' | ') || 'none'}]`)
    }
    const other = countApis(c, OTHER_TRANSPORT_APIS.kotlin)
    if (clients.length > 0 || derived.length > 0 || Object.keys(other).length > 0) {
      connections[f] = { clients: sortedMulti(clients), derived: sortedMulti(derived), other }
    }
  }
  return {
    pins: { okhttp, osPinSets: [], literals: sortedUnique([...code.values()].flatMap(pinLiterals)) },
    connections,
  }
}

// -- iOS ---------------------------------------------------------------------

function iosPins(code: Map<string, string>): TrustSnapshot['pins']['ios'] {
  const constants = new Map<string, string>()
  for (const c of code.values()) {
    for (const m of c.matchAll(/\bstatic\s+let\s+([A-Za-z_]\w*)\s*(?::\s*String\s*)?=\s*"([A-Za-z0-9+/]{43}=)"/g)) {
      constants.set(m[1] as string, m[2] as string)
    }
  }
  let effective: string[] | undefined
  for (const [f, c] of code) {
    const m = /\bstatic\s+let\s+pinned\b[^=]*=\s*\[/.exec(c)
    if (m === null) continue
    const open = c.indexOf('[', m.index + m[0].length - 1)
    const close = matchBracket(c, open)
    if (close < 0) throw new TrustExtractionError(`CertificatePins.pinned in ${f} is unbalanced`)
    const resolved: string[] = []
    for (const part of c.slice(open + 1, close).split(',').map(squash).filter((p) => p !== '')) {
      const lit = /^"([A-Za-z0-9+/]{43}=)"$/.exec(part)
      const hash = lit !== null ? lit[1] : constants.get(part.replace(/^[A-Za-z_]\w*\./, ''))
      if (hash === undefined) throw new TrustExtractionError(`CertificatePins.pinned in ${f} names "${part}", which is not a pin constant or literal`)
      resolved.push(hash)
    }
    effective = sortedUnique([...(effective ?? []), ...resolved])
  }
  if (effective === undefined) throw new TrustExtractionError('CertificatePins.pinned was not found in shipped iOS sources')
  return { effective, literals: sortedUnique([...code.values()].flatMap(pinLiterals)) }
}

function iosConnections(code: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [f, c] of code) {
    const sessions: string[] = []
    for (const m of c.matchAll(/\bURLSession\s*\(/g)) sessions.push(callText(c, m.index))
    const shared = [...c.matchAll(/\bURLSession\s*\.\s*shared\b/g)].length
    const validatorCalls = [...c.matchAll(/\bCertificatePinValidator\s*\.\s*evaluate\s*\(/g)].length
    const challengeHandlers = [...c.matchAll(/func\s+urlSession\s*\([^)]*didReceive\s+challenge/g)].length
    const other = countApis(c, OTHER_TRANSPORT_APIS.swift)
    if (sessions.length > 0 || shared > 0 || validatorCalls > 0 || challengeHandlers > 0 || Object.keys(other).length > 0) {
      out[f] = { sessions: sortedMulti(sessions), sharedSessionUses: shared, validatorCalls, challengeHandlers, other }
    }
  }
  return out
}

function iosProject(tree: TreeReader): unknown {
  const text = requireText(tree, IOS_PROJECT, 'the XcodeGen spec decides the Info.plist the app ships with')
  let doc: unknown
  try {
    doc = parseYaml(text, { merge: true })
  } catch (e) {
    throw new TrustExtractionError(`${IOS_PROJECT} is not valid YAML: ${(e as Error).message}`)
  }
  const targets = (doc as { targets?: Record<string, Record<string, unknown>> } | null)?.targets ?? {}
  const out: Record<string, unknown> = {}
  for (const [name, t] of Object.entries(targets)) {
    const info = (t['info'] ?? {}) as { path?: unknown; properties?: Record<string, unknown> }
    const settings = JSON.stringify(t['settings'] ?? {})
    const infoplistSettings: Record<string, unknown> = {}
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== 'object') return
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (/INFOPLIST|AppTransportSecurity/.test(k)) infoplistSettings[k] = val
        else walk(val)
      }
    }
    walk(JSON.parse(settings))
    const entry = {
      infoPath: info.path ?? null,
      appTransportSecurity: info.properties?.['NSAppTransportSecurity'] ?? null,
      infoPlistSettings: infoplistSettings,
      configFiles: t['configFiles'] ?? null,
    }
    // A target that neither writes an Info.plist nor sets plist settings has no trust bearing.
    if (entry.infoPath !== null || entry.appTransportSecurity !== null || Object.keys(infoplistSettings).length > 0 || entry.configFiles !== null) {
      out[name] = entry
    }
  }
  return out
}

// -- Desktop -----------------------------------------------------------------

function desktopPins(code: Map<string, string>): TrustSnapshot['pins']['desktop'] {
  let effective: string[] | undefined
  for (const [f, c] of code) {
    const m = /\bconst\s+ISRG_ROOT_PINS\b[^=]*=\s*\[/.exec(c)
    if (m === null) continue
    const open = c.indexOf('[', m.index + m[0].length - 1)
    const close = matchBracket(c, open)
    if (close < 0) throw new TrustExtractionError(`ISRG_ROOT_PINS in ${f} is unbalanced`)
    const body = c.slice(open + 1, close)
    const lits = [...body.matchAll(/"([^"]*)"/g)].map((l) => l[1] as string)
    const leftovers = squash(body.replace(/"[^"]*"/g, '').replace(/,/g, ''))
    if (leftovers !== '') throw new TrustExtractionError(`ISRG_ROOT_PINS in ${f} holds something other than pin literals: "${leftovers}"`)
    effective = sortedUnique([...(effective ?? []), ...lits])
  }
  if (effective === undefined) throw new TrustExtractionError('ISRG_ROOT_PINS was not found in shipped desktop sources')
  // `production_pins()` must still be built from that table; its body is in `logic`.
  return { effective, literals: sortedUnique([...code.values()].flatMap(pinLiterals)) }
}

function desktopConnections(code: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [f, c] of code) {
    const clients: string[] = []
    for (const m of c.matchAll(/\b(?:reqwest\s*::\s*)?(?:Client\s*::\s*builder|ClientBuilder\s*::\s*new)\s*\(\s*\)/g)) {
      clients.push(['builder', ...methodNames(chainOf(c, m.index))].join('.'))
    }
    const plain = [...c.matchAll(/\b(?:reqwest\s*::\s*)?Client\s*::\s*new\s*\(/g)].length
    const ws = [...c.matchAll(/\b(connect_async\w*|accept_async\w*|client_async\w*)\s*\(/g)].map((m) => m[1] as string)
    const other = countApis(c, OTHER_TRANSPORT_APIS.rust)
    if (clients.length > 0 || plain > 0 || ws.length > 0 || Object.keys(other).length > 0) {
      out[f] = { clients: sortedMulti(clients), plainClients: plain, websocketConnects: sortedMulti(ws), other }
    }
  }
  return out
}

// -- Entry point -------------------------------------------------------------

/**
 * The trust snapshot of the tree `tree` reads. Throws `TrustExtractionError`
 * when an anchor it must find (the pin sets, the Android network security
 * config and manifest, the iOS Info.plist and project spec) is not there or no
 * longer has a shape it can read — never returns a partial snapshot.
 */
export function extractTrustSnapshot(tree: TreeReader): TrustSnapshot {
  const files = tree.list([ANDROID_SRC, ANDROID_GRADLE, ...IOS_ROOTS, IOS_PROJECT, DESKTOP_ROOT])

  // A shipped source language the extractor does not model would let a client hide in it: refuse rather than miss it.
  const unmodelled = files.filter((f) => {
    if (f.startsWith(ANDROID_SRC)) return androidShipped(f) && /\.(java|c|cc|cpp|h|hpp|js|ts)$/.test(f)
    if (IOS_ROOTS.some((r) => f.startsWith(r))) return /\.(m|mm|c|cc|cpp|h|hpp|js|ts)$/.test(f)
    if (f.startsWith(DESKTOP_ROOT)) return /\.(c|cc|cpp|h|hpp|js|ts)$/.test(f)
    return false
  })
  if (unmodelled.length > 0) {
    throw new TrustExtractionError(
      `shipped source in a language the trust extractor does not scan: ${unmodelled.slice(0, 5).join(', ')}${unmodelled.length > 5 ? ', …' : ''} — extend packages/protocol/tools/trust-snapshot.ts before shipping it`,
    )
  }

  // Android
  const android = androidKotlin(tree, files)
  const nscs: Record<string, unknown> = {}
  const osPins: string[] = []
  for (const f of files.filter((p) => androidShipped(p) && /\/res\/xml\/[^/]+\.xml$/.test(p))) {
    const text = tree.read(f)
    if (text === undefined || !text.includes('<network-security-config')) continue
    const parsed = nscSummary(parseXml(text))
    nscs[f] = parsed.summary
    osPins.push(...parsed.pins)
  }
  if (nscs[ANDROID_MAIN_NSC] === undefined) {
    throw new TrustExtractionError(`${ANDROID_MAIN_NSC} is missing or is not a network security config — the release build has no OS-level trust policy`)
  }
  const manifests: Record<string, unknown> = {}
  for (const f of files.filter((p) => androidShipped(p) && p.endsWith('/AndroidManifest.xml'))) {
    manifests[f] = manifestSummary(parseXml(requireText(tree, f, 'listed but unreadable')))
  }
  if (manifests[ANDROID_MAIN_MANIFEST] === undefined) throw new TrustExtractionError(`${ANDROID_MAIN_MANIFEST} is missing`)
  const gradle = tree.read(ANDROID_GRADLE)
  const buildWiring: Record<string, string[]> = {}
  if (gradle !== undefined) {
    buildWiring[ANDROID_GRADLE] = gradleWiringLines(
      stripComments(gradle, 'kotlin'),
      /sourceSets|srcDirs?\(|setSrcDirs|manifest\.srcFile|manifestPlaceholders|resValue\(|buildTypes|productFlavors|flavorDimensions|initWith\(|usesCleartext|networkSecurityConfig|sha256\//,
    )
  }

  // iOS
  const iosFiles = files.filter((f) => f.endsWith('.swift') && IOS_ROOTS.some((r) => f.startsWith(r)))
  const iosCode = new Map<string, string>(iosFiles.map((f) => [f, stripComments(requireText(tree, f, 'listed but unreadable'), 'swift')]))
  const infoPlists: Record<string, unknown> = {}
  for (const f of files.filter((p) => IOS_ROOTS.some((r) => p.startsWith(r)) && /(^|\/)Info[^/]*\.plist$/.test(p))) {
    const dict = parsePlist(requireText(tree, f, 'listed but unreadable'))
    infoPlists[f] = dict['NSAppTransportSecurity'] ?? null
  }
  if (infoPlists[IOS_INFO_PLIST] === undefined) throw new TrustExtractionError(`${IOS_INFO_PLIST} is missing`)

  // Desktop
  const rustFiles = files.filter((f) => f.endsWith('.rs') && f.startsWith(DESKTOP_ROOT))
  const rustCode = new Map<string, string>(
    rustFiles.map((f) => [f, stripRustTests(stripComments(requireText(tree, f, 'listed but unreadable'), 'rust'))]),
  )

  // Cross-language: the enforcing functions and the loopback exemptions.
  const logic: Record<string, string> = {}
  const loopbackExemptions: Record<string, string[]> = {}
  const codeOf = (f: string): string | undefined =>
    langOf(f) === 'rust' ? rustCode.get(f) : iosCode.get(f) ?? (f.endsWith('.kt') && androidShipped(f) ? stripComments(tree.read(f) ?? '', 'kotlin') : undefined)
  for (const f of [...rustFiles, ...iosFiles, ...files.filter((p) => p.endsWith('.kt') && androidShipped(p))]) {
    const lang = langOf(f) as Lang
    const code = codeOf(f) as string
    for (const fn of LOGIC_FUNCTIONS[lang]) {
      functionBodies(code, fn, lang).forEach((body, i) => {
        logic[`${f}::${fn}#${i}`] = digestOf(body)
      })
    }
    // Swift/ObjC delegate methods are named `urlSession`; the ones that take a challenge are trust decisions.
    if (lang === 'swift') {
      functionBodies(code, 'urlSession', 'swift').forEach((body, i) => {
        logic[`${f}::urlSession#${i}`] = digestOf(body)
      })
    }
    const lines = matchingLines(code, LOOPBACK_RE)
    if (lines.length > 0) loopbackExemptions[f] = sortedUnique(lines)
  }

  return {
    schema: 1,
    pins: {
      android: { ...android.pins, osPinSets: sortedUnique(osPins) },
      ios: iosPins(iosCode),
      desktop: desktopPins(rustCode),
    },
    android: { networkSecurityConfigs: nscs, manifests, buildWiring },
    ios: { infoPlists, projectYml: iosProject(tree) },
    connections: {
      android: android.connections,
      ios: iosConnections(iosCode),
      desktop: desktopConnections(rustCode),
    },
    logic,
    loopbackExemptions,
  }
}

// ---------------------------------------------------------------------------
// Comparing and printing
// ---------------------------------------------------------------------------

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]))
  }
  return v
}

/** The snapshot as committed: sorted keys, two-space indent, trailing newline. */
export function serializeSnapshot(s: TrustSnapshot): string {
  return `${JSON.stringify(sortKeys(s), null, 2)}\n`
}

/** The digest a release sign-off names: SHA-256 of the serialised snapshot. */
export function snapshotDigest(s: TrustSnapshot): string {
  return createHash('sha256').update(serializeSnapshot(s)).digest('hex')
}

type Multiset = Map<string, number>

function flatten(v: unknown, path: string, out: Map<string, string>, sets: Map<string, Multiset>): void {
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) {
    const counts: Multiset = new Map()
    for (const x of v) counts.set(JSON.stringify(x), (counts.get(JSON.stringify(x)) ?? 0) + 1)
    sets.set(path, counts)
    return
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => flatten(x, `${path}[${i}]`, out, sets))
    return
  }
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
    if (entries.length === 0) out.set(path, '{}')
    for (const [k, x] of entries) flatten(x, path === '' ? k : `${path}.${k}`, out, sets)
    return
  }
  out.set(path, JSON.stringify(v))
}

/**
 * What changed from `before` to `after`, one line per leaf, empty when nothing
 * did. An array of scalars is a MULTISET: order is not a change, but a second
 * identical entry (a second unpinned client with the same shape as the first)
 * is, and says so (`×2`).
 */
export function diffSnapshots(before: unknown, after: unknown): string[] {
  const a = new Map<string, string>()
  const b = new Map<string, string>()
  const as = new Map<string, Multiset>()
  const bs = new Map<string, Multiset>()
  flatten(sortKeys(before), '', a, as)
  flatten(sortKeys(after), '', b, bs)
  const lines: string[] = []
  for (const k of sortedUnique([...a.keys(), ...b.keys()])) {
    const x = a.get(k)
    const y = b.get(k)
    if (x === y) continue
    if (x === undefined) lines.push(`+ ${k}: ${y}`)
    else if (y === undefined) lines.push(`- ${k}: ${x}`)
    else lines.push(`~ ${k}: ${x} → ${y}`)
  }
  for (const k of sortedUnique([...as.keys(), ...bs.keys()])) {
    const x = as.get(k) ?? new Map<string, number>()
    const y = bs.get(k) ?? new Map<string, number>()
    for (const item of sortedUnique([...x.keys(), ...y.keys()])) {
      const delta = (y.get(item) ?? 0) - (x.get(item) ?? 0)
      if (delta === 0) continue
      lines.push(`${delta > 0 ? '+' : '-'} ${k}[]: ${item}${Math.abs(delta) > 1 ? ` ×${Math.abs(delta)}` : ''}`)
    }
  }
  return lines.sort()
}

export const SNAPSHOT_PATH = 'packages/protocol/trust.snapshot.json'
export const SIGNOFF_LEDGER_PATH = 'docs/security/trust-signoffs.json'

export { PIN_RE }

// ---------------------------------------------------------------------------
// The release boundary
// ---------------------------------------------------------------------------

/**
 * The humans whose recorded sign-off lets a changed trust snapshot ship in a
 * client artifact. Mirrors `TRUST_ANCHOR_APPROVERS` in `orchestrator/src/config.ts`
 * — `tests/orchestrator/trust-snapshot-gate.test.ts` fails if the two drift.
 */
export const TRUST_SIGNOFF_APPROVERS: readonly string[] = ['rhonda-rodododo']

export interface TrustSignoff {
  /** `snapshotDigest` of the snapshot the human checked. */
  digest: string
  signedBy: string
  /** ISO date the sign-off was recorded. */
  signedAt: string
  /** What the signer looked at; free text. */
  note?: string
}

export interface ReleaseVerdict {
  /** True when the artifact may be produced. */
  ok: boolean
  /** True when the candidate's snapshot differs from the last released one. */
  changed: boolean
  digest: string
  baselineDigest: string | undefined
  diff: string[]
  /** One plain sentence: what was decided and why. */
  reason: string
}

/** The sign-off entries in a ledger document; throws on a malformed one — a
 *  ledger the gate cannot read is not "no sign-offs", it is a refusal. */
export function readSignoffs(doc: unknown): TrustSignoff[] {
  const list = (doc as { signoffs?: unknown } | null)?.signoffs
  if (!Array.isArray(list)) throw new TrustExtractionError(`${SIGNOFF_LEDGER_PATH} has no "signoffs" array`)
  return list.map((e, i) => {
    const x = e as Partial<TrustSignoff> | null
    if (
      x === null || typeof x !== 'object' || typeof x.digest !== 'string' || !/^[0-9a-f]{64}$/.test(x.digest) ||
      typeof x.signedBy !== 'string' || typeof x.signedAt !== 'string' || Number.isNaN(Date.parse(x.signedAt))
    ) {
      throw new TrustExtractionError(`${SIGNOFF_LEDGER_PATH} entry ${i} is malformed (needs a 64-hex digest, signedBy and an ISO signedAt)`)
    }
    return x as TrustSignoff
  })
}

/**
 * May a client artifact be produced from `candidate`, given the snapshot of
 * the last release and the recorded sign-offs?
 *
 * - snapshot unchanged → yes, no sign-off asked for;
 * - changed → only when an approver has recorded a sign-off naming THIS
 *   candidate's digest. A sign-off for an earlier snapshot names a different
 *   digest, so it does not carry over to a later change.
 */
export function releaseVerdict(input: {
  baseline: TrustSnapshot | undefined
  candidate: TrustSnapshot
  signoffs: readonly TrustSignoff[]
  approvers?: readonly string[]
}): ReleaseVerdict {
  const approvers = input.approvers ?? TRUST_SIGNOFF_APPROVERS
  const digest = snapshotDigest(input.candidate)
  const baselineDigest = input.baseline === undefined ? undefined : snapshotDigest(input.baseline)
  const diff = input.baseline === undefined ? ['(no previous release to compare against: every value is new)'] : diffSnapshots(input.baseline, input.candidate)
  const changed = baselineDigest !== digest
  if (!changed) {
    return { ok: true, changed, digest, baselineDigest, diff, reason: `the trust snapshot (${digest.slice(0, 12)}) is unchanged since the last release` }
  }
  const signed = input.signoffs.find((s) => s.digest === digest && approvers.includes(s.signedBy))
  if (signed !== undefined) {
    return { ok: true, changed, digest, baselineDigest, diff, reason: `the changed trust snapshot ${digest} is signed off by ${signed.signedBy} (${signed.signedAt})` }
  }
  return {
    ok: false,
    changed,
    digest,
    baselineDigest,
    diff,
    reason:
      `the trust snapshot changed since the last release and no sign-off names its digest ${digest}. A wrong trust value disconnects ` +
      `every installed client and only an app-store release undoes it, so ${approvers.join(' or ')} must record a sign-off ` +
      `(bun run trust:signoff) in ${SIGNOFF_LEDGER_PATH} after checking the changes above`,
  }
}

// ---------------------------------------------------------------------------
// What a PR changed
// ---------------------------------------------------------------------------

/** The paths whose content the extractor reads. A diff touching none of them cannot move the snapshot. */
export const TRUST_INPUT_PREFIXES: readonly string[] = [ANDROID_SRC, ANDROID_GRADLE, ...IOS_ROOTS, IOS_PROJECT, DESKTOP_ROOT]

/** True when a changed-file list touches anything the extractor reads (or the extractor itself). */
export function touchesTrustInputs(files: readonly string[]): boolean {
  return files.some((f) => f.startsWith('packages/protocol/tools/trust-snapshot') || TRUST_INPUT_PREFIXES.some((p) => f === p || f.startsWith(p)))
}

/** The outcome of comparing the trust snapshot at a PR's base and head. */
export interface TrustSnapshotChange {
  /** The snapshots differ. */
  changed: boolean
  baseDigest?: string
  headDigest?: string
  /** One line per leaf that moved (`diffSnapshots`). */
  changes: string[]
  /** Set when either side could not be read; the diff cannot then be trusted to be empty. */
  error?: string
  /** The head's committed snapshot file is not what its tree extracts to. */
  committedStale?: boolean
}

/** Compare two trees. Never throws: an unreadable side is reported in `error`. */
export function compareTrustSnapshots(base: TreeReader, head: TreeReader): TrustSnapshotChange {
  let headSnap: TrustSnapshot
  try {
    headSnap = extractTrustSnapshot(head)
  } catch (e) {
    return { changed: false, changes: [], error: `the head's trust configuration could not be read: ${(e as Error).message}` }
  }
  const headDigest = snapshotDigest(headSnap)
  const committedStale = head.read(SNAPSHOT_PATH) !== serializeSnapshot(headSnap)
  let baseSnap: TrustSnapshot
  try {
    baseSnap = extractTrustSnapshot(base)
  } catch (e) {
    return { changed: true, headDigest, changes: [], committedStale, error: `the base's trust configuration could not be read, so nothing can be compared: ${(e as Error).message}` }
  }
  const baseDigest = snapshotDigest(baseSnap)
  return { changed: baseDigest !== headDigest, baseDigest, headDigest, changes: diffSnapshots(baseSnap, headSnap), committedStale }
}
