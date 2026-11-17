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
    else if (e.isFile()) out.push(child)
  }
  return out
}

export interface CodeownersMatcher {
  /** True when `file` resolves to at least one owner. */
  owns(file: string): boolean
}

/**
 * The patterns that own EVERY path: GitHub's catch-all. `*` is the one this
 * file uses (#2825); `**` and `/**` mean the same thing to a gitignore
 * matcher and are recognised so a respelling cannot slip past
 * `namedCodeownersMatcher` and turn every coverage rail vacuous.
 */
export const CATCH_ALL_PATTERNS: readonly string[] = ['*', '**', '/**']

export function codeownersRules(repoRoot: string = process.cwd()): CodeOwnerRule[] {
  return parseCodeOwners(readFileSync(join(repoRoot, 'CODEOWNERS'), 'utf8'))
}

/**
 * What GitHub will actually do with this path: the LAST matching rule decides,
 * catch-all included, and a matching rule that names nobody leaves the path
 * unowned. Resolved by `codeOwnersOf` (orchestrator/src/board.ts) — the same
 * parser and matcher the fleet's merge-blocker reads use — so the tests and
 * the board cannot disagree about who owns a file.
 *
 * This is the matcher for "can a PR touching this path ever earn a review"
 * (#2825). It is the WRONG matcher for "is this sensitive path deliberately
 * owned": with a catch-all every path is owned, so asking it that question
 * passes whether or not the named entry survives — use
 * `namedCodeownersMatcher` for those.
 */
export function codeownersMatcher(repoRoot: string = process.cwd()): CodeownersMatcher {
  const rules = codeownersRules(repoRoot)
  return { owns: (file) => codeOwnersOf(rules, file).length > 0 }
}

/**
 * Ownership by a NAMED rule — the catch-all removed before resolving. Every
 * rail that asserts a sensitive path (crypto, secrets, trust anchors, the
 * gates, HIGH_IMPACT_PATHS) is owned uses this, because the explicit entry is
 * the control: it states WHY the path needs its owner, it survives the
 * catch-all ever being narrowed or handed to someone else, and deleting it
 * must fail a test. Against `codeownersMatcher` it would not — the catch-all
 * would answer for it.
 */
export function namedCodeownersMatcher(repoRoot: string = process.cwd()): CodeownersMatcher {
  const rules = codeownersRules(repoRoot).filter((r) => !CATCH_ALL_PATTERNS.includes(r.pattern))
  return { owns: (file) => codeOwnersOf(rules, file).length > 0 }
}

/** The tracked files under one high-impact path, where the path is either a
 *  directory prefix (ending in `/`) or an exact file. Returns `[]` when the
 *  path matches nothing — which is itself a failure the caller asserts on,
 *  since a gate over no files protects nothing. */
export function trackedFilesUnder(path: string, files: string[]): string[] {
  return path.endsWith('/') ? files.filter((f) => f.startsWith(path)) : files.filter((f) => f === path)
}
