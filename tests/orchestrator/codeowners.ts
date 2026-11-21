import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { codeOwnersOf, parseCodeOwners, type CodeOwnerRule } from '../../orchestrator/src/board.js'

/**
 * CODEOWNERS stopped being documentation with this change: it IS the fleet's
 * "this needs a human" gate now, enforced by GitHub's "require review from
 * Code Owners" rule rather than by a function in this repo that only this
 * repo obeyed. So the tests that used to assert `mayAutoMerge` refused a
 * sensitive diff assert coverage of this file instead — against the real
 * file and the real tracked tree, never a fixture, because a fixture would
 * keep passing while the shipped one lost an entry.
 *
 * Matched (via `codeOwnersOf`, orchestrator/src/board.ts) with the `ignore`
 * package, which implements gitignore semantics —
 * the SAME syntax GitHub parses CODEOWNERS with. This is the whole point of
 * the round that introduced it: the previous check compared pattern strings
 * with `startsWith`, so `apps/worker/lib/auth` "covered"
 * `apps/worker/lib/auth.ts` as far as the test was concerned, while GitHub
 * read it as a file literally named `auth` and matched nothing at all. A
 * string comparison can only ever check that two lists agree with each other;
 * it cannot check that either one means anything. Do not replace this with a
 * bespoke glob — the value here is using the same semantics as the consumer.
 */
export function codeownersPatterns(repoRoot: string = process.cwd()): string[] {
  return codeownersRules(repoRoot).map((r) => r.pattern)
}

/**
 * Every file the repository actually contains at this commit. The tree is the
 * source of truth for "does this pattern protect anything" — a list of
 * strings cannot answer it.
 *
 * Two environments, one answer. On a checkout, `git ls-files` is exact. Under
 * `fleet/verify` the suite runs inside a `git archive` EXPORT of the commit
 * under judgement — deliberately no `.git`, so no git command can run there —
 * and a walk of that directory is if anything MORE exact, because an archive
 * contains precisely the tracked files at that commit and nothing else. The
 * only thing to exclude is `node_modules`, which the workflow symlinks in
 * from the trusted base install and which git never tracked.
 *
 * The result is asserted non-trivial before it is returned: a walk that
 * silently found nothing would turn every coverage assertion below into a
 * vacuous pass, which is the precise failure mode these tests exist to
 * prevent.
 *
 * `-z`, because without it git C-quotes any path holding a non-ASCII byte:
 * the caller gets `"caf\303\251.ts"`, which matches no pattern and names no
 * file on disk, so the path drops out of every check without an error.
 */
export function trackedFiles(repoRoot: string = process.cwd()): string[] {
  let files: string[]
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0').filter((l) => l.length > 0)
  } catch {
    files = walk(repoRoot, '')
  }
  if (files.length < 100 || !files.includes('CODEOWNERS')) {
    throw new Error(
      `trackedFiles(${repoRoot}) found ${files.length} file(s) and ` +
      `${files.includes('CODEOWNERS') ? 'did' : 'did NOT'} see CODEOWNERS — refusing to let ` +
      'every coverage assertion pass vacuously over an empty or wrong tree',
    )
  }
  return files
}

const WALK_SKIP = new Set(['node_modules', '.git'])

function walk(root: string, rel: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (WALK_SKIP.has(e.name)) continue
    const child = rel.length === 0 ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...walk(root, child))
    // A tracked symlink (root AGENTS.md -> CLAUDE.md) is one `git ls-files` entry
    // and one archive member, but `isFile()` is false for a link — so the export
    // walk lost it while the git path kept it, and a test that passed locally
    // failed in fleet/verify (#2894). A symlink is a file here, never descended.
    else if (e.isFile() || e.isSymbolicLink()) out.push(child)
  }
  return out
}

export interface CodeownersMatcher {
  /** True when `file` resolves to at least one owner. */
  owns(file: string): boolean
}

// Paths a catch-all must own, chosen so each shape that distinguishes one
// all-path spelling from a merely broad one is present: a root file, a
// dotfile, an extensionless name, nested files at several depths, a name with
// a space, a non-ASCII name. A pattern that owns all of them is, for every
// purpose these tests have, a catch-all; one that misses any (`*/` and `**/`
// miss the root files, `**/*.*` misses the extensionless ones) is narrower
// and is a legitimate named entry.
const CATCH_ALL_PROBES: readonly string[] = [
  'README.md', '.env', 'LICENSE', 'a', 'a/b', 'a/b/c.d', 'deep/er/est/file', '.github/workflows/x.yml',
  'dir with space/f', 'é/ü.ts', 'x.pem',
]

// True when `pattern`, taken alone, owns EVERY path — GitHub's catch-all, in
// any spelling. Decided by asking the matcher (`codeOwnersOf`, the one
// board.ts resolves ownership with) rather than by comparing strings: the
// first cut listed `*`, `**` and `/**`, and `**/*` — which the matcher treats
// identically — slipped past it (#2826). A later `**/* @owner` would then
// have overridden every named entry under last-match-wins (the secret-shaped
// globs included) while `namedCodeownersMatcher` kept it as an ordinary named
// entry and every rail stayed green over a control that no longer controlled
// anything. `/*`, `***`, `?*`, `[!/]*` and `**/**/*` are caught the same way.
// Owner-independent: a catch-all that names nobody still un-owns every path
// above it.
export function isCatchAllPattern(pattern: string): boolean {
  const rule: CodeOwnerRule = { pattern, owners: ['probe'] }
  return CATCH_ALL_PROBES.every((path) => codeOwnersOf([rule], path).length > 0)
}

export function codeownersRules(repoRoot: string = process.cwd()): CodeOwnerRule[] {
  return parseCodeOwners(readFileSync(join(repoRoot, 'CODEOWNERS'), 'utf8'))
}

/**
 * Everything wrong with where the catch-all sits, as human-readable lines
 * (empty = fine). Pure over `rules` so the mutation tests can hand it a
 * CODEOWNERS the real file does not contain.
 */
export function catchAllViolations(rules: readonly CodeOwnerRule[]): string[] {
  const at = rules.flatMap((r, i) => (isCatchAllPattern(r.pattern) ? [i] : []))
  const out: string[] = []
  if (at.length !== 1) out.push(`expected exactly one catch-all rule, found ${at.length} at index [${at.join(', ')}]`)
  if (at[0] !== 0) out.push(`the catch-all must be the FIRST rule, found first at index ${at[0] ?? 'none'}`)
  const first = at[0] === undefined ? undefined : rules[at[0]]
  if (first !== undefined && first.owners.length === 0) out.push('the catch-all names no owner, so it owns nothing')
  return out
}

/**
 * What GitHub will actually do with a path: the LAST matching rule decides,
 * catch-all included, and a matching rule that names nobody leaves the path
 * unowned. Resolved by `codeOwnersOf` (orchestrator/src/board.ts) — the same
 * parser and matcher the fleet's merge-blocker reads use — so the tests and
 * the board cannot disagree about who owns a file.
 *
 * This is the matcher for "can a PR touching this path ever earn a review"
 * (#2825). It is the WRONG matcher for "is this sensitive path deliberately
 * owned": with a catch-all every path is owned, so asking it that question
 * passes whether or not the named entry survives — use
 * `namedCodeownersMatcherOf` for those.
 */
export function codeownersMatcherOf(rules: readonly CodeOwnerRule[]): CodeownersMatcher {
  return { owns: (file) => codeOwnersOf([...rules], file).length > 0 }
}

/**
 * Ownership by a NAMED rule — every catch-all (in ANY spelling, see
 * `isCatchAllPattern`) removed before resolving. Every rail that asserts a
 * sensitive path (crypto, secrets, trust anchors, the gates,
 * HIGH_IMPACT_PATHS) is owned uses this, because the explicit entry is the
 * control: it states WHY the path needs its owner, it survives the catch-all
 * ever being narrowed or handed to someone else, and deleting it must fail a
 * test. Against `codeownersMatcher` it would not — the catch-all would answer
 * for it.
 */
export function namedCodeownersMatcherOf(rules: readonly CodeOwnerRule[]): CodeownersMatcher {
  return codeownersMatcherOf(rules.filter((r) => !isCatchAllPattern(r.pattern)))
}

export function codeownersMatcher(repoRoot: string = process.cwd()): CodeownersMatcher {
  return codeownersMatcherOf(codeownersRules(repoRoot))
}

export function namedCodeownersMatcher(repoRoot: string = process.cwd()): CodeownersMatcher {
  return namedCodeownersMatcherOf(codeownersRules(repoRoot))
}

/** The tracked files under one high-impact path, where the path is either a
 *  directory prefix (ending in `/`) or an exact file. Returns `[]` when the
 *  path matches nothing — which is itself a failure the caller asserts on,
 *  since a gate over no files protects nothing. */
export function trackedFilesUnder(path: string, files: string[]): string[] {
  return path.endsWith('/') ? files.filter((f) => f.startsWith(path)) : files.filter((f) => f === path)
}
