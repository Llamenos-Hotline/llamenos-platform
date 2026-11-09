/**
 * Which commits reach the user-facing release notes, and the bridge that gets
 * the extra types knope.toml opts in (`security`, `perf`) into those notes at
 * all. Operator ruling (2026-11-08): the notes contain only changes an end user
 * or self-hoster would care about.
 *
 * `placeCommit` is THE rule; the changesets, the verification and the "left
 * out" list are all views of it. A commit reaches the notes only if it passes,
 * in order:
 *
 *   1. Type. knope's own (`feat`, `fix`, any breaking change), or a type opted
 *      in through `[package] extra_changelog_sections`. Everything else — test,
 *      ci, chore, build, docs, refactor, style, revert, any unknown type, any
 *      non-conventional subject — is out, whatever its scope.
 *   2. Scope. `[package] scopes` is the allowlist, or the commit has no scope.
 *   3. Paths, for the opted-in types only. A commit whose every changed path is
 *      test code, CI or test tooling is out even under a product scope:
 *      `perf(ios): parallelize XCUITests` shipped nothing to anyone. knope
 *      reads feat/fix itself and cannot apply this; see `placeCommit`.
 *
 * knope.toml is the single source of truth for both configured lists; nothing
 * here keeps a second copy. Opting a new type in is one edit there.
 *
 *   bun scripts/release/notes-scope.ts excluded   <from-ref> [<to-ref>]
 *   bun scripts/release/notes-scope.ts changesets [<from-ref> [<to-ref>]]
 *   bun scripts/release/notes-scope.ts verify     [<from-ref> [<to-ref>]]
 *
 * `excluded` prints, as Markdown, every commit in <from-ref>..<to-ref> (default
 * HEAD) that the rule keeps OUT of the notes. knope-release-pr.yml appends it
 * to the release PR body, so a product change the rule misjudged is seen at
 * release review instead of vanishing.
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
 * patched something. `changesets` writes one changeset per commit the rule
 * bridges; `verify` then fails the release unless each of them appears exactly
 * once in its section — so a knope upgrade that stops reading the changesets
 * (missing entry) or starts matching commit types itself (duplicate entry) is a
 * red release job, not a quiet gap.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const KNOPE_TOML = join(ROOT, 'knope.toml')

/**
 * Conventional-commit types knope itself turns into changelog entries. This
 * describes knope's built-in behaviour; types WE add live in knope.toml.
 */
const KNOPE_COMMIT_TYPES = new Set(['feat', 'fix'])

export interface ConventionalSubject {
  type: string
  /** The scope exactly as written, or null for an unscoped commit. */
  scope: string | null
  breaking: boolean
  description: string
}

// `[\w-]+`, not letters only: a type opted in through knope.toml can be any
// changeset type, and one with a digit must not silently fail to parse.
const SUBJECT = /^(?<type>[\w-]+)(?:\((?<scope>[^()]*)\))?(?<bang>!)?: (?<description>.+)$/

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
 * knope.toml's `extra_changelog_sections`, as type → section heading. This is
 * the whole opt-in: a type listed there is a release-note type and the bridge
 * carries it to the section knope.toml names. A type not listed there is not.
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
  subject: string
  /** Every path the commit changed. A rename contributes both of its sides. */
  paths: readonly string[]
}

export type ExclusionReason =
  /** Not a release-note type, or not a conventional subject at all. */
  | 'type'
  /** A release-note type under a scope outside the allowlist. */
  | 'scope'
  /** A bridged type under a product scope that changed nothing that ships. */
  | 'non-shipping-paths'

export type Placement =
  /** knope lists it itself; nothing for us to do. */
  | { kind: 'knope' }
  /** knope cannot see it; the bridge writes a changeset for it. */
  | { kind: 'bridged'; type: string; section: string; description: string }
  | { kind: 'excluded'; reason: ExclusionReason; type: string | null; scope: string | null }

/**
 * THE rule (see the module header). A breaking commit of any type is knope's:
 * it files every one under "### Breaking Changes", so bridging one too would
 * list it twice.
 *
 * The path check is reachable only for bridged types, on purpose. knope reads
 * feat/fix commits straight out of git and offers no per-commit filter beyond
 * `scopes`, so `fix(ios): flaky XCUITest` is listed whatever this function says.
 * The type is the guard there: test work is `test(ios)`.
 */
export function placeCommit(
  commit: Commit,
  productScopes: ReadonlySet<string>,
  noteSections: ReadonlyMap<string, string>,
): Placement {
  const c = parseSubject(commit.subject)
  if (!c) return { kind: 'excluded', reason: 'type', type: null, scope: null }
  const excluded = (reason: ExclusionReason): Placement => ({ kind: 'excluded', reason, type: c.type, scope: c.scope })

  const knopeReadsIt = c.breaking || KNOPE_COMMIT_TYPES.has(c.type)
  const section = knopeReadsIt ? undefined : noteSections.get(c.type)
  if (!knopeReadsIt && section === undefined) return excluded('type')
  if (!scopeIsProduct(c.scope, productScopes)) return excluded('scope')
  if (section === undefined) return { kind: 'knope' }
  if (touchesOnlyNonShippingPaths(commit.paths)) return excluded('non-shipping-paths')
  return { kind: 'bridged', type: c.type, section, description: c.description }
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
    out.push({ sha: commit.sha, subject: commit.subject, reason, type, scope })
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
  const otherScopes = excluded.filter((e) => e.reason === 'scope' && sectionOf(e) === undefined)
  const otherTypes = excluded.filter((e) => e.reason === 'type')
  const lines = [
    '### Left out of these notes',
    '',
    `Commits in \`${range}\` that the release-notes rule (knope.toml, \`scripts/release/notes-scope.ts\`) keeps out of the changelog. ` +
      'If one of these changed the product, fix its scope or type: a scope belongs in the `scopes` allowlist (multi-scope commits are always left out), a type in `extra_changelog_sections`.',
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

/** A commit the bridge turns into a changeset — and that `verify` then expects. */
export interface NoteEntry {
  sha: string
  /** The knope changeset type (= the commit type), e.g. `security`. */
  type: string
  /** The extra_changelog_sections heading it lands under, e.g. `Security`. */
  section: string
  description: string
}

export function noteEntries(
  commits: readonly Commit[],
  productScopes: ReadonlySet<string>,
  noteSections: ReadonlyMap<string, string>,
): NoteEntry[] {
  const out: NoteEntry[] = []
  for (const commit of commits) {
    const placement = placeCommit(commit, productScopes, noteSections)
    if (placement.kind !== 'bridged') continue
    const { type, section, description } = placement
    out.push({ sha: commit.sha, type, section, description })
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
    return [`CHANGELOG.md has no "## ${version}" section, but ${entries.length} bridged entr${entries.length === 1 ? 'y was' : 'ies were'} expected in it`]
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
  // --no-renames: a file moved out of the product into tests/ is a product change.
  const r = Bun.spawnSync(['git', 'log', '--no-merges', '--no-renames', '--name-only', '--format=%x01%H%x00%s', range], {
    cwd: ROOT,
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`git log ${range} failed: ${r.stderr.toString().trim()}`)
  return r.stdout
    .toString()
    .split('\x01')
    .slice(1)
    .map((record) => {
      const [header, ...paths] = record.split('\n').filter(Boolean)
      const [sha, subject] = header.split('\0')
      return { sha, subject, paths }
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
      console.log(`${entries.length} bridged changeset(s) written for ${range}.`)
    } else {
      const problems = verifyEntries(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), preparedVersion(), entries)
      if (problems.length > 0) {
        for (const p of problems) console.error(`::error::release notes: ${p}`)
        console.error(
          `${problems.length} bridged entr${problems.length === 1 ? 'y is' : 'ies are'} missing or duplicated in CHANGELOG.md. ` +
            'A self-hoster decides whether to upgrade from these notes — the release must not go out without them. ' +
            'See scripts/release/notes-scope.ts for why knope needs the changeset bridge.',
        )
        process.exit(1)
      }
      console.log(`All ${entries.length} bridged entr${entries.length === 1 ? 'y is' : 'ies are'} in CHANGELOG.md exactly once (${range}).`)
    }
  } else {
    usage()
  }
}
