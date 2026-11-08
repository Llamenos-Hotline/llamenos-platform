import { isAlias, isMap, isScalar, isSeq, parseDocument, visit, type Node as YamlNode } from 'yaml'

/**
 * The content rule for XcodeGen's `apps/ios/project.yml` (#2579): which
 * changes to the iOS build spec are trust decisions, and which are routine.
 *
 * Before #2579 the file was a whole-file trust anchor, so every edit waited
 * for a human sign-off. That included #2577, the fix for a repo-wide iOS gate
 * outage, whose whole diff was one test target's `sources` entry. Measured
 * over the file's history: 3 edits since 2026-08-01, and one of them (the
 * Linphone link, #1572) moved a trust key (`NSAppTransportSecurity`). Across
 * all 19 edits ever made, the ones that could move a trust or security setting
 * touched `info.properties`, the app target's build settings
 * (`SWIFT_ACTIVE_COMPILATION_CONDITIONS`, which decides what `#if` code is
 * compiled into the app) and entitlements. The routine ones touched
 * test-target `sources`, scheme test lists, packages and `options`.
 *
 * **An allowlist, never a denylist.** The file is parsed and its two sides are
 * compared structurally. A change passes only when EVERY changed path falls in
 * `ROUTINE_XCODEGEN_PATHS`. Anything else is held, whether or not it is
 * recognisable as trust: `info` (every Info.plist key XcodeGen writes,
 * including ATS sub-keys nobody has heard of yet), every build setting
 * (`INFOPLIST_*`, compilation conditions, or a setting an Info.plist value
 * expands), `configs`/`configFiles`, every build script, scheme pre/post
 * actions, templates, `include`, entitlements, a new target, and the shipped
 * target's own `sources`. A future trust key cannot fail open, because no key
 * has to be recognised for the rule to hold it.
 *
 * **Fails closed when it cannot read the file faithfully.** XcodeGen reads the
 * spec with Yams (YAML 1.1). It is parsed here with the 1.1 schema, and the
 * change is held if either side has a parse error or warning (duplicate keys,
 * unknown tags, multiple documents), is not a mapping, uses a non-scalar key,
 * or uses an alias. An alias would let a routine region define what a trust
 * region expands to, and this comparison does not follow aliases. Scalars are
 * compared by their SOURCE text and quoting, not by resolved value, so a
 * spelling the two parsers might resolve differently (`yes` vs `true`) still
 * counts as a change. Comments and layout are ignored: no YAML parser gives
 * them meaning.
 *
 * Pure: takes the two sides' text and returns a reason or `undefined`.
 */

/** A target type that never ships: XcodeGen's unit and UI test bundles. */
const TEST_TARGET_TYPES: ReadonlySet<string> = new Set(['bundle.unit-test', 'bundle.ui-testing'])

/** Placeholder in a routine path for "a target that is a test bundle on both
 *  sides and inherits from no template". */
const TEST_TARGET = '<test target>'

/**
 * The only paths whose change is not a trust decision. Each one is listed with
 * the reason it cannot move what a shipped client trusts. `*` is any key.
 * `<test target>` is a target whose `type` is a test bundle on BOTH sides and
 * which uses no `templates`, since a template could make it something else.
 *
 * Deliberately NOT here, so changing them is held:
 * - `targets.<app>.sources`: which files ship, including ones outside the
 *   roots the line rule reads, and `excludes` that could drop the pinning file.
 * - any `settings`, `configs`, `configFiles` outside a test target: they
 *   choose the Info.plist (`INFOPLIST_FILE`, `INFOPLIST_KEY_*`), the
 *   compilation conditions that decide which `#if` code ships (the
 *   `UI_TESTING` test hooks among it), and any value a `$(VAR)` in Info.plist
 *   expands.
 * - scripts, scheme pre/post actions, `schemes`: a build phase can rewrite
 *   the built Info.plist.
 */
export interface RoutinePath {
  path: string
  why: string
  /** A further condition on the values at `path` on both sides, given both
   *  whole specs as well. */
  when?: (before: Canon | undefined, after: Canon | undefined, specs: { before: Canon; after: Canon }) => boolean
}

export const ROUTINE_XCODEGEN_PATHS: readonly RoutinePath[] = [
  { path: `targets.${TEST_TARGET}.sources`, why: 'a test bundle is never in an installed app' },
  { path: `targets.${TEST_TARGET}.dependencies`, why: 'a test bundle is never in an installed app' },
  { path: `targets.${TEST_TARGET}.settings`, why: 'a test bundle is never in an installed app' },
  { path: 'targets.*.scheme.testTargets', why: 'which bundles the test action runs; the archive is unaffected' },
  { path: 'targets.*.scheme.gatherCoverageData', why: 'test-action coverage only' },
  { path: 'targets.*.scheme.coverageTargets', why: 'test-action coverage only' },
  // Package and dependency choices are supply-chain decisions with their own
  // review (Package.swift/Package.resolved, CODEOWNERS). This is the same
  // line `TRUST_SIGNATURES` draws for Gradle and Cargo dependencies.
  {
    // Remote packages only. A local package (`path:`) compiles code from this
    // repo into the app, code that neither Package.resolved nor the line rule
    // reads, so adding, changing or re-pointing one is held.
    path: 'packages',
    why: 'a remote Swift package pin: supply chain, gated separately',
    when: (before, after) => sameCanon(nonRemotePackages(before), nonRemotePackages(after)),
  },
  {
    // Only `package:` entries. A `target:` or `framework:` entry can embed
    // code from outside the roots the line rule reads, so changing one holds.
    path: 'targets.*.dependencies',
    why: 'which Swift packages a target links: supply chain, gated separately',
    when: (before, after, specs) =>
      sameCanon(nonPackageItems(before, specs.before), nonPackageItems(after, specs.after)),
  },
  { path: 'options.xcodeVersion', why: 'the Xcode version the project file declares' },
  { path: 'options.minimumXcodeGenVersion', why: 'the XcodeGen version the spec requires' },
  { path: 'options.groupSortPosition', why: 'navigator ordering' },
  { path: 'options.generateEmptyDirectories', why: 'navigator layout' },
]

/** One YAML node, reduced to what XcodeGen's meaning depends on. */
export type Canon =
  | { kind: 'map'; entries: ReadonlyMap<string, Canon> }
  | { kind: 'seq'; items: readonly Canon[] }
  | { kind: 'scalar'; text: string; quoted: boolean; tag: string | undefined }

/** Why a side could not be read faithfully: the rule cannot decide. */
class Undecidable extends Error {}

function canon(node: YamlNode | null | undefined): Canon {
  if (node === null || node === undefined) return { kind: 'scalar', text: '', quoted: false, tag: undefined }
  if (isAlias(node)) throw new Undecidable(`it uses a YAML alias (*${node.source})`)
  if (isScalar(node)) {
    const quoted = node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE'
    return { kind: 'scalar', text: node.source ?? String(node.value), quoted, tag: node.tag }
  }
  if (isSeq(node)) return { kind: 'seq', items: node.items.map((i) => canon(i as YamlNode | null)) }
  if (isMap(node)) {
    const entries = new Map<string, Canon>()
    for (const pair of node.items) {
      const key = pair.key as YamlNode | null
      if (!isScalar(key)) throw new Undecidable('it uses a non-scalar mapping key')
      entries.set(key.source ?? String(key.value), canon(pair.value as YamlNode | null))
    }
    return { kind: 'map', entries }
  }
  throw new Undecidable('it holds a YAML node of an unknown kind')
}

/** The bytes as XcodeGen reads them: UTF-8, and nothing else. Invalid UTF-8
 *  (a UTF-16 re-encoding included) cannot be read faithfully. */
function utf8(content: string | Uint8Array): string {
  if (typeof content === 'string') return content
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw new Undecidable('it is not valid UTF-8')
  }
}

/** The spec as a canonical tree. Throws `Undecidable` when it cannot be read
 *  faithfully. */
function readSpec(text: string): Canon {
  const doc = parseDocument(text, { version: '1.1', uniqueKeys: true, prettyErrors: false })
  const problem = doc.errors[0] ?? doc.warnings[0]
  if (problem !== undefined) throw new Undecidable(`it does not parse as YAML 1.1: ${problem.message.split('\n')[0]}`)
  let alias = false
  visit(doc, { Alias: () => { alias = true; return visit.BREAK } })
  if (alias) throw new Undecidable('it uses a YAML alias or merge key, which this comparison does not expand')
  const root = canon(doc.contents as YamlNode | null)
  if (root.kind !== 'map') throw new Undecidable('its top level is not a mapping')
  return root
}

const sameCanon = (a: Canon | undefined, b: Canon | undefined): boolean => JSON.stringify(plain(a)) === JSON.stringify(plain(b))

function plain(c: Canon | undefined): unknown {
  if (c === undefined) return null
  if (c.kind === 'scalar') return [c.text, c.quoted, c.tag ?? null]
  if (c.kind === 'seq') return c.items.map(plain)
  return [...c.entries.keys()].sort().map((k) => [k, plain(c.entries.get(k))])
}

const child = (c: Canon | undefined, key: string): Canon | undefined =>
  c?.kind === 'map' ? c.entries.get(key) : undefined

/** The keys a Swift-package dependency entry may carry. An entry with any
 *  other key, such as `target:`, `framework:`, `carthage:`, `sdk:` or
 *  `bundle:` next to `package:`, is ambiguous about what it links, so it is
 *  not treated as a package entry. */
const PACKAGE_DEPENDENCY_KEYS: ReadonlySet<string> = new Set([
  'package', 'product', 'products', 'link', 'embed', 'codeSign', 'weak', 'platformFilter', 'platformFilters',
])

/** The keys a REMOTE package declaration may carry: where it lives and
 *  which version. Anything else (`path:` above all) is not remote. */
const REMOTE_PACKAGE_KEYS: ReadonlySet<string> = new Set([
  'url', 'github', 'version', 'from', 'exactVersion', 'revision', 'branch', 'minorVersion', 'majorVersion',
  'minVersion', 'maxVersion',
])

const isRemotePackage = (p: Canon | undefined): boolean =>
  p?.kind === 'map' && (p.entries.has('url') || p.entries.has('github')) &&
  [...p.entries.keys()].every((k) => REMOTE_PACKAGE_KEYS.has(k))

/** The `packages` map without its remote declarations. Anything that is not
 *  a map is returned whole, so it still compares. */
function nonRemotePackages(packages: Canon | undefined): Canon | undefined {
  if (packages?.kind !== 'map') return packages
  return { kind: 'map', entries: new Map([...packages.entries].filter(([, p]) => !isRemotePackage(p))) }
}

/** True for an unambiguous `package:` dependency on a package `spec`
 *  declares as remote. */
function isRemotePackageDependency(d: Canon, spec: Canon): boolean {
  if (d.kind !== 'map' || ![...d.entries.keys()].every((k) => PACKAGE_DEPENDENCY_KEYS.has(k))) return false
  const name = d.entries.get('package')
  return name?.kind === 'scalar' && isRemotePackage(child(child(spec, 'packages'), name.text))
}

/** A dependency list without its unambiguous dependencies on remote packages.
 *  Anything that is not a list is returned whole, so it still compares. */
function nonPackageItems(deps: Canon | undefined, spec: Canon): Canon | undefined {
  if (deps?.kind !== 'seq') return deps
  return { kind: 'seq', items: deps.items.filter((d) => !isRemotePackageDependency(d, spec)) }
}

/** True when `targets.<name>` is a test bundle with no template, in `spec`. */
function isTestTarget(spec: Canon, name: string): boolean {
  const target = child(child(spec, 'targets'), name)
  const type = child(target, 'type')
  return type?.kind === 'scalar' && TEST_TARGET_TYPES.has(type.text) && child(target, 'templates') === undefined
}

/** The routine entry `path` falls under, given both sides, or `undefined`. */
function routineFor(path: readonly string[], before: Canon, after: Canon): string | undefined {
  for (const r of ROUTINE_XCODEGEN_PATHS) {
    const pattern = r.path.split('.')
    if (path.length < pattern.length) continue
    const hit = pattern.every((seg, i) => {
      const actual = path[i] as string
      if (seg === '*') return true
      if (seg === TEST_TARGET) return isTestTarget(before, actual) && isTestTarget(after, actual)
      return seg === actual
    })
    if (!hit) continue
    const at = (spec: Canon) => pattern.reduce<Canon | undefined>((c, _seg, i) => child(c, path[i] as string), spec)
    if (r.when === undefined || r.when(at(before), at(after), { before, after })) return r.path
  }
  return undefined
}

interface Change {
  path: readonly string[]
  before: Canon | undefined
  after: Canon | undefined
}

/** Every changed path that no routine entry covers, outermost first. */
function nonRoutineChanges(
  a: Canon | undefined, b: Canon | undefined, path: string[], before: Canon, after: Canon, out: Change[],
): void {
  if (sameCanon(a, b)) return
  if (path.length > 0 && routineFor(path, before, after) !== undefined) return
  if (a?.kind === 'map' && b?.kind === 'map') {
    for (const k of new Set([...a.entries.keys(), ...b.entries.keys()])) {
      nonRoutineChanges(a.entries.get(k), b.entries.get(k), [...path, k], before, after, out)
    }
    return
  }
  if (a?.kind === 'seq' && b?.kind === 'seq') {
    // Down to the first item that differs, so the refusal names it rather
    // than two long lists that look the same.
    for (let i = 0; i < Math.max(a.items.length, b.items.length); i += 1) {
      if (sameCanon(a.items[i], b.items[i])) continue
      out.push({ path: [...path, `[${i}]`], before: a.items[i], after: b.items[i] })
      return
    }
  }
  out.push({ path, before: a, after: b })
}

const MAX_SHOWN = 80

/** A node in YAML flow style, in its original key order. */
function render(c: Canon): string {
  if (c.kind === 'scalar') return c.quoted ? JSON.stringify(c.text) : c.text
  if (c.kind === 'seq') return `[${c.items.map(render).join(', ')}]`
  return `{${[...c.entries].map(([k, v]) => `${k}: ${render(v)}`).join(', ')}}`
}

function show(c: Canon | undefined): string {
  if (c === undefined) return '(absent)'
  const s = render(c)
  return s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN)}…` : s
}

const dotted = (path: readonly string[]): string =>
  path.reduce((acc, seg) => (acc === '' ? seg : seg.startsWith('[') ? `${acc}${seg}` : `${acc}.${seg}`), '')

/**
 * Why changing the XcodeGen spec from `before` to `after` is a trust-anchor
 * change, or `undefined` when every change is routine. `undefined` for a side
 * means the file does not exist there. Creating or deleting the spec is always
 * held.
 *
 * The reason starts with "its …" so it reads after the file name in the
 * refusal. It names the first non-routine path and its old and new values, so
 * the person asked to sign off sees exactly which setting moved.
 */
export function xcodegenTrustFinding(
  before: string | Uint8Array | undefined, after: string | Uint8Array | undefined,
): string | undefined {
  if (before === undefined || after === undefined) {
    return `its diff ${before === undefined ? 'creates' : 'deletes'} the spec`
  }
  let a: Canon
  let b: Canon
  try {
    a = readSpec(utf8(before))
  } catch (e) {
    if (!(e instanceof Undecidable)) throw e
    return `its content at the merge base cannot be read faithfully (${e.message}), so no change to it can be shown routine`
  }
  try {
    b = readSpec(utf8(after))
  } catch (e) {
    if (!(e instanceof Undecidable)) throw e
    return `its content at the head cannot be read faithfully (${e.message}), so no change to it can be shown routine`
  }
  const changes: Change[] = []
  nonRoutineChanges(a, b, [], a, b, changes)
  const first = changes[0]
  if (first === undefined) return undefined
  const more = changes.length > 1 ? ` and ${changes.length - 1} other non-routine path(s)` : ''
  return `its diff changes \`${dotted(first.path)}\` (${show(first.before)} → ${show(first.after)})${more}, ` +
    'which is not one of the routine XcodeGen paths (test-target sources/settings/dependencies, scheme test lists, ' +
    'remote Swift packages, the xcodeVersion option)'
}
