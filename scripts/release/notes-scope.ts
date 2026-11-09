/**
 * Which commits reach the user-facing release notes, and the changesets that put
 * them there. Operator ruling (2026-11-08): the notes contain only changes an end
 * user or self-hoster would care about.
 *
 * `placeCommit` is THE rule; the changesets, the verification and the "left out"
 * list are all views of it. A commit reaches the notes only if it passes, in
 * order:
 *
 *   1. Type. `feat`, `fix`, any breaking change, or a type opted in through
 *      `[package] extra_changelog_sections`. Everything else — test, ci, chore,
 *      build, docs, refactor, style, revert, any unknown type, any
 *      non-conventional subject — is out, whatever its scope.
 *   2. Scope. `[package] scopes` is the allowlist, or the commit has no scope.
 *   3. Paths. A commit whose every changed path is test code, CI or test tooling
 *      is out even under a product scope: `fix(ios): flaky XCUITest` and
 *      `perf(ios): parallelize XCUITests` shipped nothing to anyone.
 *
 * knope.toml is the single source of truth for both configured lists; nothing
 * here keeps a second copy. Opting a new type in is one edit there.
 *
 *   bun scripts/release/notes-scope.ts excluded   <from-ref> [<to-ref>]
 *   bun scripts/release/notes-scope.ts changesets [<from-ref> [<to-ref>]]
 *   bun scripts/release/notes-scope.ts verify     [<from-ref> [<to-ref>]]
 *   bun scripts/release/notes-scope.ts last-tag
 *   bun scripts/release/notes-scope.ts admitted [<from-ref> [<to-ref>]]
 *
 * `excluded` prints, as Markdown, every commit in <from-ref>..<to-ref> (default
 * HEAD) that the rule keeps OUT of the notes. knope-release-pr.yml appends it
 * to the release PR body, so a product change the rule misjudged is seen at
 * release review instead of vanishing.
 *
 * `changesets` and `verify` are knope.toml `prepare-release` steps, before and
 * after PrepareRelease. <from-ref> defaults to `last-tag`: the highest
 * `v<semver>` tag reachable from HEAD, the same release knope builds on.
 *
 * `admitted` prints how many notes entries the rule admits. Every entry is a
 * changeset and every changeset bumps the version, so knope reporting
 * `no_release` while this is above zero means the changesets never reached it —
 * knope-release-pr.yml treats that as a failure, not as "nothing to release".
 *
 * Why every type goes through changesets: knope can only filter commits it reads
 * itself by `scopes`, so `fix(ios): flaky XCUITest` was listed whatever this rule
 * said (85 of 1,266 historical feat/fix commits changed only tests or CI), and
 * it matches `extra_changelog_sections` types against changesets only, so a
 * `security(...)` commit never appeared at all (18 in history, #2584).
 * knope.toml therefore sets `[changes] ignore_conventional_commits`, and this
 * script writes one changeset for each entry the rule admits. `verify` then fails
 * the release unless every entry appears as many times as it should — so a knope
 * upgrade that stops reading the changesets (missing entry) or starts reading
 * commits again (duplicate entry) is a red release job, not a quiet gap.
 *
 * What knope did with a commit is reproduced here exactly, on knope 0.22.4:
 * `feat` → `minor`, `fix` → `patch`, breaking → `major` changesets, which give the
 * same 0.x bumps as the commits did (minor and patch → patch; major → minor). The
 * `Changelog-Note` footer is the one thing not carried over: no commit in this
 * repository's history has ever used it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const KNOPE_TOML = join(ROOT, 'knope.toml')

/** knope's built-in changeset type and the heading it files that type under. */
interface Listing {
  /** The changeset type, e.g. `minor` or an `extra_changelog_sections` type. */
  type: string
  section: string
}

/**
 * The commit types that map onto knope's built-in change types. This describes
 * knope's behaviour; types WE add live in knope.toml.
 */
const KNOPE_LISTINGS: ReadonlyMap<string, Listing> = new Map([
  ['feat', { type: 'minor', section: 'Features' }],
  ['fix', { type: 'patch', section: 'Fixes' }],
])

const BREAKING: Listing = { type: 'major', section: 'Breaking Changes' }

export interface ConventionalSubject {
  type: string
  /** The scope exactly as written, or null for an unscoped commit. */
  scope: string | null
  /** The subject carries `!`. A `BREAKING CHANGE` footer is reported separately. */
  breaking: boolean
  description: string
}

// `[\w-]+`, not letters only: a type opted in through knope.toml can be any
// changeset type, and one with a digit must not silently fail to parse.
// `:[ \t]*`, not `: `: knope accepts `fix:no space` and we must not lose it.
const SUBJECT = /^(?<type>[\w-]+)(?:\((?<scope>[^()]*)\))?(?<bang>!)?:[ \t]*(?<description>\S.*)$/

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

export interface ConventionalMessage extends ConventionalSubject {
  /** The text of each `BREAKING CHANGE`/`BREAKING-CHANGE` footer, on one line. */
  breakingFooters: readonly string[]
}

/** A footer line: a token (only `BREAKING CHANGE` may hold a space), then `: ` or ` #`. */
const FOOTER_START = /^(BREAKING CHANGE|[\w-]+)(?:: | #)(.*)$/

/**
 * knope's footer rule, tested against 0.22.4: the footers begin at the first line
 * that opens a paragraph and looks like a footer; from there each such line starts
 * a new one and anything else continues the current one, blank lines included. So
 * `BREAKING CHANGE:` in the middle of a prose paragraph is not a footer, and the
 * token is case-sensitive. Each footer collapses to one line, because it becomes
 * one bullet.
 */
function breakingFooters(body: string): string[] {
  const lines = body.split('\n')
  const first = lines.findIndex((line, i) => (i === 0 || lines[i - 1].trim() === '') && FOOTER_START.test(line))
  if (first === -1) return []
  const footers: { token: string; value: string[] }[] = []
  for (const line of lines.slice(first)) {
    const m = FOOTER_START.exec(line)
    if (m) footers.push({ token: m[1], value: [m[2]] })
    else footers[footers.length - 1].value.push(line)
  }
  return footers
    .filter((f) => f.token === 'BREAKING CHANGE' || f.token === 'BREAKING-CHANGE')
    .map((f) => f.value.join(' ').replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0)
}

/** A whole commit message, parsed the way knope parses it. */
export function parseMessage(message: string): ConventionalMessage | null {
  const [subject, ...rest] = message.replace(/\r\n/g, '\n').split('\n')
  // knope rejects a message whose subject is not followed by a blank line.
  if (rest.length > 0 && rest[0].trim() !== '') return null
  const parsed = parseSubject(subject)
  return parsed && { ...parsed, breakingFooters: breakingFooters(rest.join('\n')) }
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
 * knope.toml's `extra_changelog_sections`, as type → section heading. This is
 * the whole opt-in: a type listed there is a release-note type and its commits
 * land in the section knope.toml names. A type not listed there is not.
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
 * Paths that never reach a user: test code wherever it lives, CI, and test or CI
 * tooling. Everything else counts as shipping, so a new product directory needs
 * no entry here and a path nobody thought of errs towards being in the notes.
 *
 * `scripts/ios-build.sh` and `apps/ios/project.yml` earn their place from the
 * commit this rule exists for: 9bcdf2d32 `perf(ios): parallelize XCUITests`
 * changed a test helper, the CI workflow, that script and the test-scheme stanza
 * of the XcodeGen spec. Do NOT widen this to all of `scripts/` or
 * `packages/*\/scripts/`: the Dockerfiles copy `scripts/run-migrations.ts` and
 * its siblings into the app image, `deploy/docker/first-run.sh` sources
 * `scripts/lib/server-hash-keys.sh`, `scripts/iso-builder/` builds the ISO, and
 * `packages/crypto/scripts/build-server.sh` builds the server's crypto library.
 * A security fix in any of those belongs in the notes.
 */
const NON_SHIPPING_PATHS: readonly RegExp[] = [
  // Test code: test directories on every platform, then test-named files that
  // sit beside the source they cover.
  /(^|\/)(tests?|Tests|__tests__|__mocks__|androidTest|e2e|test-specs)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /Tests?\.(swift|kt)$/,
  /_test\.(rs|go)$/,
  // Test-runner configuration.
  /^(playwright|vitest)[^/]*$/,
  /^tsconfig\.tests\.json$/,
  // CI.
  /^\.github\//,
  // Test and CI tooling, named individually (see above).
  /^scripts\/ci\//,
  /^scripts\/test-[^/]*$/,
  /^scripts\/ios-build\.sh$/,
  /^apps\/ios\/scripts\//,
  /^apps\/ios\/project\.yml$/,
  /^orchestrator\//,
  /^\.claude\//,
]

/** True only when there is at least one path and none of them ships. */
export function touchesOnlyNonShippingPaths(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((p) => NON_SHIPPING_PATHS.some((re) => re.test(p)))
}

export interface Commit {
  sha: string
  /** The full commit message: the subject, then any body. */
  message: string
  /** Every path the commit changed. A rename contributes both of its sides. */
  paths: readonly string[]
}

function subjectOf(commit: Commit): string {
  return commit.message.split('\n', 1)[0].trim()
}

export type ExclusionReason =
  /** Not a release-note type, or not a conventional subject at all. */
  | 'type'
  /** A release-note type under a scope outside the allowlist. */
  | 'scope'
  /** A release-note type under a product scope that changed nothing that ships. */
  | 'non-shipping-paths'

/** One bullet in the notes: the changeset that produces it, and where it lands. */
export interface ListedEntry extends Listing {
  description: string
}

export type Placement =
  | { kind: 'listed'; entries: readonly ListedEntry[] }
  | { kind: 'excluded'; reason: ExclusionReason; type: string | null; scope: string | null }

/**
 * THE rule (see the module header). Which entries an admitted commit produces is
 * what knope produced from the same commit:
 *
 *   - a `!` with no footer: one Breaking Changes entry, and nothing else;
 *   - a `BREAKING CHANGE` footer: a Breaking Changes entry with the footer's text,
 *     beside the commit's usual entry.
 */
export function placeCommit(
  commit: Commit,
  productScopes: ReadonlySet<string>,
  noteSections: ReadonlyMap<string, string>,
): Placement {
  const c = parseMessage(commit.message)
  if (!c) return { kind: 'excluded', reason: 'type', type: null, scope: null }
  const excluded = (reason: ExclusionReason): Placement => ({ kind: 'excluded', reason, type: c.type, scope: c.scope })

  const extraSection = noteSections.get(c.type)
  const listing = KNOPE_LISTINGS.get(c.type) ?? (extraSection === undefined ? undefined : { type: c.type, section: extraSection })
  const hasFooter = c.breakingFooters.length > 0
  if (listing === undefined && !c.breaking && !hasFooter) return excluded('type')
  if (!scopeIsProduct(c.scope, productScopes)) return excluded('scope')
  if (touchesOnlyNonShippingPaths(commit.paths)) return excluded('non-shipping-paths')

  const entries: ListedEntry[] = c.breakingFooters.map((description) => ({ ...BREAKING, description }))
  if (c.breaking && !hasFooter) entries.push({ ...BREAKING, description: c.description })
  if (listing !== undefined && (!c.breaking || hasFooter)) entries.push({ ...listing, description: c.description })
  return { kind: 'listed', entries }
}

export interface Excluded {
  sha: string
  subject: string
  reason: ExclusionReason
  type: string | null
  scope: string | null
}

export function excludedCommits(
  commits: readonly Commit[],
  productScopes: ReadonlySet<string>,
  noteSections: ReadonlyMap<string, string>,
): Excluded[] {
  const out: Excluded[] = []
  for (const commit of commits) {
    const placement = placeCommit(commit, productScopes, noteSections)
    if (placement.kind !== 'excluded') continue
    const { reason, type, scope } = placement
    out.push({ sha: commit.sha, subject: subjectOf(commit), reason, type, scope })
  }
  return out
}

/**
 * The lowest-value tier (`chore:`, `test:`, …) is bounded so a release after a
 * long gap cannot push the PR body past GitHub's 65,536-character limit, which
 * would fail the workflow step. The cut is stated in the output, never silent.
 */
export const MAX_LISTED_OTHER_TYPES = 200

export function renderExcluded(
  excluded: readonly Excluded[],
  range: string,
  noteSections: ReadonlyMap<string, string>,
): string {
  const line = (e: Excluded): string => {
    const why = e.reason === 'scope' ? `\`${e.scope}\` — ` : e.reason === 'non-shipping-paths' ? 'tests/CI/tooling only — ' : ''
    return `- ${why}${e.subject} (${e.sha.slice(0, 9)})`
  }
  const sectionOf = (e: Excluded): string | undefined => (e.type === null ? undefined : noteSections.get(e.type))
  const flagged = excluded.filter((e) => sectionOf(e) !== undefined)
  // Everything left out by scope or by paths. `type` drops go in the block below.
  const otherScopes = excluded.filter((e) => e.reason !== 'type' && sectionOf(e) === undefined)
  const otherTypes = excluded.filter((e) => e.reason === 'type')
  const lines = [
    '### Left out of these notes',
    '',
    `Commits in \`${range}\` that the release-notes rule (knope.toml, \`scripts/release/notes-scope.ts\`) keeps out of the changelog. ` +
      'If one of these changed the product, fix its scope or type: a scope belongs in the `scopes` allowlist (multi-scope commits are always left out), a type in `extra_changelog_sections`, and a path that really ships must not be listed as test or CI tooling in `NON_SHIPPING_PATHS`.',
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
      `**${[...new Set(flagged.map(sectionOf))].join(' / ')} commits left out — confirm each is internal-only:**`,
      '',
      ...flagged.map(line),
      '',
    )
  }
  if (otherScopes.length > 0) {
    if (flagged.length > 0) lines.push('Other commits left out:', '')
    lines.push(...otherScopes.map(line), '')
  }
  if (otherTypes.length > 0) {
    const listed = otherTypes.slice(0, MAX_LISTED_OTHER_TYPES)
    const unlisted = otherTypes.length - listed.length
    lines.push(`<details><summary>Not a release-note type (${otherTypes.length})</summary>`, '', ...listed.map(line))
    if (unlisted > 0) lines.push(`- …and ${unlisted} more: \`git log --no-merges ${range}\``)
    lines.push('', '</details>')
  }
  return lines.join('\n').trimEnd()
}

/** One changeset the rule asks for — and that `verify` then expects in the notes. */
export interface NoteEntry extends ListedEntry {
  sha: string
}

export function noteEntries(
  commits: readonly Commit[],
  productScopes: ReadonlySet<string>,
  noteSections: ReadonlyMap<string, string>,
): NoteEntry[] {
  const out: NoteEntry[] = []
  for (const commit of commits) {
    const placement = placeCommit(commit, productScopes, noteSections)
    if (placement.kind !== 'listed') continue
    for (const entry of placement.entries) out.push({ ...entry, sha: commit.sha })
  }
  return out
}

/** The changeset knope 0.22.4 reads: `default` is the single package's name. */
export function renderChangeset(e: NoteEntry): string {
  return `---\ndefault: ${e.type}\n---\n\n# ${e.description}\n`
}

/** knope lists changesets by file name, so the index keeps commit order in the notes. */
export function changesetFileName(e: NoteEntry, index: number): string {
  return `commit-${String(index).padStart(5, '0')}-${e.type}-${e.sha.slice(0, 12)}.md`
}

/**
 * Every expected entry must appear as a `- <description>` bullet under its
 * `### <section>` heading in the `## <version>` section knope wrote for the
 * release being prepared, exactly as many times as the rule asked for it: two
 * commits with the same description legitimately produce two identical bullets.
 * That section is located by version, not by position: CHANGELOG.md keeps its
 * pre-knope `## [x.y.z]` sections above the knope ones. Returns one
 * human-readable problem per violation.
 */
export function verifyEntries(changelog: string, version: string, entries: readonly NoteEntry[]): string[] {
  if (entries.length === 0) return []
  const lines = changelog.split('\n')
  const isHeading = (l: string): boolean => l === `## ${version}` || l.startsWith(`## ${version} `)
  const start = lines.findIndex(isHeading)
  if (start === -1) {
    return [`CHANGELOG.md has no "## ${version}" section, but ${entries.length} entr${entries.length === 1 ? 'y was' : 'ies were'} expected in it`]
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

  const expected = new Map<string, NoteEntry[]>()
  for (const e of entries) {
    const key = `${e.section}\0${e.description.trim()}`
    expected.set(key, [...(expected.get(key) ?? []), e])
  }

  const problems: string[] = []
  for (const group of expected.values()) {
    const [e] = group
    const n = (bulletsBySection.get(e.section) ?? []).filter((b) => b === e.description.trim()).length
    if (n !== group.length) {
      const shas = group.map((g) => g.sha.slice(0, 9)).join(', ')
      problems.push(`${e.type} commit ${shas} "${e.description}" appears ${n}× under "### ${e.section}" in ${version} (expected exactly ${group.length})`)
    }
  }
  return problems
}

function gitLog(range: string): Commit[] {
  // --no-renames: a file moved out of the product into tests/ is a product change.
  const r = Bun.spawnSync(['git', 'log', '--no-merges', '--no-renames', '--name-only', '--format=%x01%H%x00%B%x02', range], {
    cwd: ROOT,
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`git log ${range} failed: ${r.stderr.toString().trim()}`)
  return r.stdout
    .toString()
    .split('\x01')
    .slice(1)
    .map((record) => {
      const [header, paths = ''] = record.split('\x02')
      const [sha, message] = header.split('\0')
      return { sha, message: message.trim(), paths: paths.split('\n').filter(Boolean) }
    })
}

function semver(json: string, where: string): string {
  const version = (JSON.parse(json) as { version?: unknown }).version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${where} has no semver "version" (got ${JSON.stringify(version)})`)
  }
  return version
}

/**
 * The release HEAD is built on: the highest `v<semver>` tag reachable from it,
 * which is what knope builds on too. Platform tags (`v0.21.8-desktop`) are not
 * bare semver, so they do not count. This is not `v<package.json version>`: for a
 * few minutes after a release PR merges, main holds a version whose tag does not
 * exist yet, and the release workflow must not fail on that.
 */
function lastReleaseTag(): string {
  const r = Bun.spawnSync(['git', 'tag', '--merged', 'HEAD', '--list', 'v*'], { cwd: ROOT, stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git tag --merged HEAD failed: ${r.stderr.toString().trim()}`)
  const tag = highestReleaseTag(r.stdout.toString().split('\n'))
  if (tag === null) throw new Error('no v<semver> release tag is reachable from HEAD')
  return tag
}

export function highestReleaseTag(tags: readonly string[]): string | null {
  const parts = (t: string): number[] => t.slice(1).split('.').map(Number)
  const newerFirst = (a: string, b: string): number => {
    const [x, y] = [parts(a), parts(b)]
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]
  }
  return tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort(newerFirst)[0] ?? null
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
        '       bun scripts/release/notes-scope.ts changesets|verify|admitted [<from-ref> [<to-ref>]]\n' +
        '       bun scripts/release/notes-scope.ts last-tag',
    )
    process.exit(2)
  }
  const productScopes = loadProductScopes()
  const noteSections = loadNoteSections()

  if (command === 'excluded') {
    if (!fromArg) usage()
    const range = `${fromArg}..${to}`
    console.log(renderExcluded(excludedCommits(gitLog(range), productScopes, noteSections), range, noteSections))
  } else if (command === 'last-tag') {
    console.log(lastReleaseTag())
  } else if (command === 'changesets' || command === 'verify' || command === 'admitted') {
    const from = fromArg ?? lastReleaseTag()
    const range = `${from}..${to}`
    // git log is newest-first; the changeset file names fix the order in the notes.
    const entries = noteEntries(gitLog(range).reverse(), productScopes, noteSections)
    if (command === 'admitted') {
      console.log(entries.length)
    } else if (command === 'changesets') {
      const dir = join(ROOT, '.changeset')
      if (entries.length > 0) mkdirSync(dir, { recursive: true })
      entries.forEach((e, index) => {
        const file = join(dir, changesetFileName(e, index))
        writeFileSync(file, renderChangeset(e))
        console.log(`${e.section}: ${e.description} (${e.sha.slice(0, 9)}) → ${file}`)
      })
      console.log(`${entries.length} changeset(s) written for ${range}.`)
    } else {
      const problems = verifyEntries(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), preparedVersion(), entries)
      if (problems.length > 0) {
        for (const p of problems) console.error(`::error::release notes: ${p}`)
        console.error(
          `${problems.length} release-note entr${problems.length === 1 ? 'y is' : 'ies are'} missing or duplicated in CHANGELOG.md. ` +
            'A self-hoster decides whether to upgrade from these notes — the release must not go out without them. ' +
            'See scripts/release/notes-scope.ts for how the notes are built.',
        )
        process.exit(1)
      }
      console.log(`All ${entries.length} release-note entr${entries.length === 1 ? 'y is' : 'ies are'} in CHANGELOG.md exactly as expected (${range}).`)
    }
  } else {
    usage()
  }
}
