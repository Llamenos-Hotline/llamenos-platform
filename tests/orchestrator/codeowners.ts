import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ignore from 'ignore'

/**
 * CODEOWNERS stopped being documentation with this change: it IS the fleet's
 * "this needs a human" gate now, enforced by GitHub's "require review from
 * Code Owners" rule rather than by a function in this repo that only this
 * repo obeyed. So the tests that used to assert `mayAutoMerge` refused a
 * sensitive diff assert coverage of this file instead — against the real
 * file and the real tracked tree, never a fixture, because a fixture would
 * keep passing while the shipped one lost an entry.
 *
 * Matched with the `ignore` package, which implements gitignore semantics —
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
  return readFileSync(join(repoRoot, 'CODEOWNERS'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0] ?? '')
    .filter((p) => p.length > 0)
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
  /** True when at least one CODEOWNERS rule matches this path, by gitignore
   *  semantics — the same semantics GitHub applies. */
  owns(file: string): boolean
}

export function codeownersMatcher(repoRoot: string = process.cwd()): CodeownersMatcher {
  const ig = ignore().add(codeownersPatterns(repoRoot))
  return { owns: (file) => ig.ignores(file) }
}

/** The tracked files under one high-impact path, where the path is either a
 *  directory prefix (ending in `/`) or an exact file. Returns `[]` when the
 *  path matches nothing — which is itself a failure the caller asserts on,
 *  since a gate over no files protects nothing. */
export function trackedFilesUnder(path: string, files: string[]): string[] {
  return path.endsWith('/') ? files.filter((f) => f.startsWith(path)) : files.filter((f) => f === path)
}
