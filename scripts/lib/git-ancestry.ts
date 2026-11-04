/**
 * git-ancestry.ts — make "is <base> an ancestor of HEAD?" answerable in a
 * shallow clone, instead of guessing how deep to fetch (#2455).
 *
 * actions/checkout fetches depth 1. `git fetch --deepen=10` assumes the base
 * is within ten commits, which is an assumption about queue length and about
 * how fast main moves, and it was wrong exactly when the merge queue was busy:
 * the checker then reported "could not run" and the gate treated that as drift.
 *
 * `ensureAncestor` deepens in growing steps, asking the question after every
 * one, and finishes with a full unshallow. It answers `true` only when git has
 * proved the ancestry. It answers `false` only when it had the WHOLE history and
 * the base is still not an ancestor, which is a fact about the refs and not
 * about the clone. A fetch that fails (network, auth) throws: the question went
 * unanswered, and the caller must say so rather than report a verdict.
 */

/** Commits to deepen by per attempt; the last resort is a full unshallow. */
export const DEEPEN_STEPS = [10, 50, 250, 1000] as const

export type GitRunner = (args: string[]) => { exitCode: number; stdout: string; stderr: string }

export function spawnGit(cwd: string): GitRunner {
  return (args) => {
    const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  }
}

export interface AncestryResult {
  ancestor: boolean
  /** What was fetched, in order, for the log: the proof of how the answer was reached. */
  steps: string[]
}

function isAncestor(git: GitRunner, base: string): boolean {
  return git(['merge-base', '--is-ancestor', base, 'HEAD']).exitCode === 0
}

function mustGit(git: GitRunner, args: string[]): void {
  const r = git(args)
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed (${r.exitCode}): ${r.stderr.trim()}`)
}

export function ensureAncestor(git: GitRunner, base: string, remote = 'origin'): AncestryResult {
  const steps: string[] = []
  if (isAncestor(git, base)) return { ancestor: true, steps }

  const head = git(['rev-parse', 'HEAD']).stdout.trim()
  const shallow = () => git(['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true'

  // The base commit itself: a base that moved can be absent from the clone entirely.
  steps.push(`fetch --depth=1 ${base.slice(0, 12)}`)
  mustGit(git, ['fetch', '--no-tags', '--depth=1', remote, base])
  if (isAncestor(git, base)) return { ancestor: true, steps }

  for (const n of DEEPEN_STEPS) {
    if (!shallow()) break
    steps.push(`fetch --deepen=${n}`)
    mustGit(git, ['fetch', '--no-tags', `--deepen=${n}`, remote, head])
    if (isAncestor(git, base)) return { ancestor: true, steps }
  }
  if (shallow()) {
    steps.push('fetch --unshallow')
    mustGit(git, ['fetch', '--no-tags', '--unshallow', remote])
    if (isAncestor(git, base)) return { ancestor: true, steps }
  }
  return { ancestor: false, steps }
}
