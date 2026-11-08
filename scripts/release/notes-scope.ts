/**
 * Which commits reach the user-facing release notes — the same rule knope
 * applies through `[package] scopes` in knope.toml, made inspectable — and the
 * bridge that gets `security(...)`/`perf(...)` commits into those notes at all.
 *
 * knope.toml is the single source of truth for both lists this module uses:
 * `[package] scopes` (the allowlist of product scopes) and
 * `[package] extra_changelog_sections` (the Security/Performance sections and
 * the types that feed them). Nothing here keeps a second copy of either.
 *
 *   bun scripts/release/notes-scope.ts excluded   <from-ref> [<to-ref>]
 *   bun scripts/release/notes-scope.ts changesets [<from-ref> [<to-ref>]]
 *   bun scripts/release/notes-scope.ts verify     [<from-ref> [<to-ref>]]
 *
 * `excluded` prints, as Markdown, every note-worthy commit in
 * <from-ref>..<to-ref> (default HEAD) that the rule keeps OUT of the notes.
 * knope-release-pr.yml appends it to the release PR body, so a product change
 * filed under a scope missing from the allowlist is seen at release review
 * instead of vanishing.
 *
 * `changesets` and `verify` are knope.toml `prepare-release` steps, before and
 * after PrepareRelease. <from-ref> defaults to `v<version>` read from
 * HEAD:package.json — the release being built on, which PrepareRelease has not
 * yet committed a bump over.
 *
 * Why the bridge exists (#2584): knope 0.22.4 matches `extra_changelog_sections`
 * `types` against CHANGESET types only, never against conventional-commit
 * types. Run against this repo, a `security(worker): …`, an unscoped
 * `security: …` and a `perf(worker): …` commit produced no entry, while a
 * `.changeset/*.md` with `default: security` produced one under "### Security"
 * (and a patch bump on its own). So 18 security/perf commits in history never
 * reached a release note, and a self-hoster could not see that a release
 * patched something. `changesets` writes one changeset per product-scoped
 * security/perf commit; `verify` then fails the release unless each of them
 * appears exactly once in its section — so a knope upgrade that stops reading
 * the changesets (missing entry) or starts matching commit types itself
 * (duplicate entry) is a red release job, not a quiet gap.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const KNOPE_TOML = join(ROOT, 'knope.toml')

/** Conventional-commit types knope itself turns into changelog entries. */
const KNOPE_COMMIT_TYPES = new Set(['feat', 'fix'])

export interface ConventionalSubject {
  type: string
  /** The scope exactly as written, or null for an unscoped commit. */
  scope: string | null
  breaking: boolean
  description: string
}

const SUBJECT = /^(?<type>[A-Za-z]+)(?:\((?<scope>[^()]*)\))?(?<bang>!)?: (?<description>.+)$/

export function parseSubject(subject: string): ConventionalSubject | null {
  const m = SUBJECT.exec(subject.trim())
  if (!m?.groups) return null
  const { type, scope, bang, description } = m.groups
  return {
    type: type.toLowerCase(),
    scope: scope === undefined ? null : scope,
    breaking: bang === '!',
    description,
  }
}

interface KnopePackage {
  scopes?: unknown
  extra_changelog_sections?: unknown
}

function loadPackage(path: string): KnopePackage {
  const config = Bun.TOML.parse(readFileSync(path, 'utf8')) as { package?: KnopePackage }
  return config.package ?? {}
}

export function loadProductScopes(path: string = KNOPE_TOML): ReadonlySet<string> {
  const scopes = loadPackage(path).scopes
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === 'string')) {
    throw new Error(`${path}: [package] scopes must be a non-empty array of strings`)
  }
  return new Set(scopes.map((s: string) => s.toLowerCase()))
}

/**
 * knope.toml's `extra_changelog_sections`, as type → section heading. These
 * types are also the conventional-commit types the bridge carries, so the
 * section a `security(...)` commit lands in is the one knope.toml names.
 */
export function loadNoteSections(path: string = KNOPE_TOML): ReadonlyMap<string, string> {
  const sections = loadPackage(path).extra_changelog_sections
  const bad = (): never => {
    throw new Error(`${path}: [package] extra_changelog_sections must be a non-empty array of { name, types }`)
  }
  if (!Array.isArray(sections) || sections.length === 0) bad()
  const out = new Map<string, string>()
  for (const section of sections as unknown[]) {
    if (typeof section !== 'object' || section === null) bad()
    const { name, types } = section as { name?: unknown; types?: unknown }
    if (typeof name !== 'string' || !Array.isArray(types) || !types.every((t) => typeof t === 'string')) bad()
    for (const t of types as string[]) out.set(t.toLowerCase(), name as string)
  }
  return out
}

/**
 * knope's scope rule: no scope → considered; otherwise the WHOLE scope string
 * must be in the allowlist (so `desktop,worker` is out even though both parts
 * are product scopes). Matching is case-insensitive, as knope's is.
 */
export function scopeIsProduct(scope: string | null, productScopes: ReadonlySet<string>): boolean {
  return scope === null || productScopes.has(scope.toLowerCase())
}

/**
 * A commit that would produce a release-note entry if its scope were
 * admitted: one knope reads itself (feat, fix, any breaking change), or one of
 * the extra-section types the bridge carries (security, perf).
 */
export function isChangelogEligible(c: ConventionalSubject, noteSections: ReadonlyMap<string, string>): boolean {
  return KNOPE_COMMIT_TYPES.has(c.type) || c.breaking || noteSections.has(c.type)
}

export interface Commit {
  sha: string
  subject: string
}

export interface Excluded extends Commit {
  type: string
  scope: string
}

export function excludedCommits(
  commits: readonly Commit[],
  productScopes: ReadonlySet<string>,
  noteSections: ReadonlyMap<string, string>,
): Excluded[] {
  const out: Excluded[] = []
  for (const { sha, subject } of commits) {
    const c = parseSubject(subject)
    if (!c || !isChangelogEligible(c, noteSections) || scopeIsProduct(c.scope, productScopes)) continue
    // scopeIsProduct(null) is true, so a commit reaching here has a scope.
    out.push({ sha, subject, type: c.type, scope: c.scope as string })
  }
  return out
}

export function renderExcluded(
  excluded: readonly Excluded[],
  range: string,
  noteSections: ReadonlyMap<string, string>,
): string {
  const line = (e: Excluded): string => `- \`${e.scope}\` — ${e.subject} (${e.sha.slice(0, 9)})`
  const flagged = excluded.filter((e) => noteSections.has(e.type))
  const rest = excluded.filter((e) => !noteSections.has(e.type))
  const lines = [
    '### Left out of these notes (not a product scope)',
    '',
    `Commits in \`${range}\` that knope.toml's \`scopes\` allowlist keeps out of the changelog and the version bump. ` +
      'If one of these changed the product, its scope belongs in that allowlist (multi-scope commits are always left out).',
    '',
  ]
  if (excluded.length === 0) {
    lines.push('_None._')
    return lines.join('\n')
  }
  if (flagged.length > 0) {
    // A left-out security fix is the one omission a self-hoster cannot afford
    // to miss, so it is called out on its own, above everything else.
    lines.push(
      `**${[...new Set(flagged.map((e) => noteSections.get(e.type)))].join(' / ')} commits left out — confirm each is internal-only:**`,
      '',
      ...flagged.map(line),
      '',
    )
    if (rest.length > 0) lines.push('Other commits left out:', '')
  }
  lines.push(...rest.map(line))
  return lines.join('\n')
}

/** A commit the bridge turns into a changeset — and that `verify` then expects. */
export interface NoteEntry {
  sha: string
  /** The knope changeset type (= the commit type), e.g. `security`. */
  type: string
  /** The extra_changelog_sections heading it lands under, e.g. `Security`. */
  section: string
  description: string
}

/**
 * Product-scoped (or unscoped) commits of an extra-section type. A breaking
 * one (`security(worker)!: …`) is left to knope, which already files every
 * breaking commit under "### Breaking Changes" — bridging it too would list
 * it twice.
 */
export function noteEntries(
  commits: readonly Commit[],
  productScopes: ReadonlySet<string>,
  noteSections: ReadonlyMap<string, string>,
): NoteEntry[] {
  const out: NoteEntry[] = []
  for (const { sha, subject } of commits) {
    const c = parseSubject(subject)
    if (!c || c.breaking || !scopeIsProduct(c.scope, productScopes)) continue
    const section = noteSections.get(c.type)
    if (section === undefined) continue
    out.push({ sha, type: c.type, section, description: c.description })
  }
  return out
}

/** The changeset knope 0.22.4 reads: `default` is the single package's name. */
export function renderChangeset(e: NoteEntry): string {
  return `---\ndefault: ${e.type}\n---\n\n# ${e.description}\n`
}

/**
 * Every expected entry must appear exactly once, as a `- <description>` bullet,
 * under its `### <section>` heading in the `## <version>` section knope wrote
 * for the release being prepared. That section is located by version, not by
 * position: CHANGELOG.md keeps its pre-knope `## [x.y.z]` sections above the
 * knope ones. Returns one human-readable problem per violation.
 */
export function verifyEntries(changelog: string, version: string, entries: readonly NoteEntry[]): string[] {
  if (entries.length === 0) return []
  const lines = changelog.split('\n')
  const isHeading = (l: string): boolean => l === `## ${version}` || l.startsWith(`## ${version} `)
  const start = lines.findIndex(isHeading)
  if (start === -1) {
    return [`CHANGELOG.md has no "## ${version}" section, but ${entries.length} security/performance entr${entries.length === 1 ? 'y was' : 'ies were'} expected in it`]
  }
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  const release = lines.slice(start + 1, end === -1 ? undefined : end)

  const bulletsBySection = new Map<string, string[]>()
  let heading: string | null = null
  for (const l of release) {
    if (l.startsWith('### ')) heading = l.slice(4).trim()
    else if (heading !== null && l.startsWith('- ')) {
      const list = bulletsBySection.get(heading) ?? []
      list.push(l.slice(2).trim())
      bulletsBySection.set(heading, list)
    }
  }

  const problems: string[] = []
  for (const e of entries) {
    const n = (bulletsBySection.get(e.section) ?? []).filter((b) => b === e.description.trim()).length
    if (n !== 1) {
      problems.push(
        `${e.type} commit ${e.sha.slice(0, 9)} "${e.description}" appears ${n}× under "### ${e.section}" in ${version} (expected exactly 1)`,
      )
    }
  }
  return problems
}

function gitLog(range: string): Commit[] {
  const r = Bun.spawnSync(['git', 'log', '--no-merges', '--format=%H%x00%s', range], { cwd: ROOT, stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git log ${range} failed: ${r.stderr.toString().trim()}`)
  return r.stdout
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\0')
      return { sha, subject }
    })
}

function semver(json: string, where: string): string {
  const version = (JSON.parse(json) as { version?: unknown }).version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${where} has no semver "version" (got ${JSON.stringify(version)})`)
  }
  return version
}

/** `v<version>` of the release HEAD is built on (PrepareRelease bumps only the working tree). */
function lastReleaseTag(): string {
  const r = Bun.spawnSync(['git', 'show', 'HEAD:package.json'], { cwd: ROOT, stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git show HEAD:package.json failed: ${r.stderr.toString().trim()}`)
  return `v${semver(r.stdout.toString(), 'HEAD:package.json')}`
}

/** The version PrepareRelease just bumped the working tree to. */
function preparedVersion(): string {
  return semver(readFileSync(join(ROOT, 'package.json'), 'utf8'), 'package.json')
}

if (import.meta.main) {
  const [command, fromArg, to = 'HEAD'] = process.argv.slice(2)
  const usage = (): never => {
    console.error(
      'usage: bun scripts/release/notes-scope.ts excluded <from-ref> [<to-ref>]\n' +
        '       bun scripts/release/notes-scope.ts changesets|verify [<from-ref> [<to-ref>]]',
    )
    process.exit(2)
  }
  const productScopes = loadProductScopes()
  const noteSections = loadNoteSections()

  if (command === 'excluded') {
    if (!fromArg) usage()
    const range = `${fromArg}..${to}`
    console.log(renderExcluded(excludedCommits(gitLog(range), productScopes, noteSections), range, noteSections))
  } else if (command === 'changesets' || command === 'verify') {
    const from = fromArg ?? lastReleaseTag()
    const range = `${from}..${to}`
    const entries = noteEntries(gitLog(range), productScopes, noteSections)
    if (command === 'changesets') {
      const dir = join(ROOT, '.changeset')
      if (entries.length > 0) mkdirSync(dir, { recursive: true })
      for (const e of entries) {
        const file = join(dir, `commit-${e.type}-${e.sha.slice(0, 12)}.md`)
        writeFileSync(file, renderChangeset(e))
        console.log(`${e.section}: ${e.description} (${e.sha.slice(0, 9)}) → ${file}`)
      }
      console.log(`${entries.length} security/performance changeset(s) written for ${range}.`)
    } else {
      const problems = verifyEntries(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), preparedVersion(), entries)
      if (problems.length > 0) {
        for (const p of problems) console.error(`::error::release notes: ${p}`)
        console.error(
          `${problems.length} security/performance entr${problems.length === 1 ? 'y is' : 'ies are'} missing or duplicated in CHANGELOG.md. ` +
            'A self-hoster decides whether to upgrade from these notes — the release must not go out without them. ' +
            'See scripts/release/notes-scope.ts for why knope needs the changeset bridge.',
        )
        process.exit(1)
      }
      console.log(`All ${entries.length} security/performance entr${entries.length === 1 ? 'y is' : 'ies are'} in CHANGELOG.md exactly once (${range}).`)
    }
  } else {
    usage()
  }
}
