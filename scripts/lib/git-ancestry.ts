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

/**
 * One git invocation's outcome. `exitCode` is null and `signal` is set when git
 * was killed (a cancelled job, an OOM kill, a test runner's timeout) rather than
 * exiting. That is "no answer", never an exit status, and must not be read as one
 * (#2477: a SIGTERM reported as `exitCode 1` with empty stderr looked like a git
 * failure and hid the kill).
 */
export interface GitResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
}

export type GitRunner = (args: string[]) => GitResult

export function spawnGit(cwd: string): GitRunner {
  return (args) => {
    const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    return { exitCode: r.exitCode, signal: r.signalCode ?? null, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  }
}

export interface AncestryResult {
  ancestor: boolean
  /** What was fetched, in order, for the log: the proof of how the answer was reached. */
  steps: string[]
}

function gitFailure(args: string[], r: GitResult): Error {
  const how = r.signal !== null ? `killed by ${r.signal}` : `exit ${r.exitCode}`
  return new Error(`git ${args.join(' ')} failed (${how}): ${r.stderr.trim()}`)
}

/** Run git and return its stdout; anything but exit 0 is an unanswered question, so it throws. */
function mustGit(git: GitRunner, args: string[]): string {
  const r = git(args)
  if (r.exitCode !== 0) throw gitFailure(args, r)
  return r.stdout.trim()
}

/** Exit 128 from `merge-base --is-ancestor` when `base` is not in the clone at all. */
const NOT_A_VALID_OBJECT = 128

/**
 * `merge-base --is-ancestor` answers with its exit status: 0 is yes, 1 is no.
 * Before the base has been fetched it may be absent from the clone (128), which
 * is "not yet" and is what the fetch is for. Anything else — a kill, or 128 once
 * the base is present — is no answer, and is never read as "not an ancestor".
 */
function isAncestor(git: GitRunner, base: string, baseMayBeAbsent = false): boolean {
  const args = ['merge-base', '--is-ancestor', base, 'HEAD']
  const r = git(args)
  if (r.exitCode === 0) return true
  if (r.exitCode === 1) return false
  if (baseMayBeAbsent && r.exitCode === NOT_A_VALID_OBJECT) return false
  throw gitFailure(args, r)
}

export function ensureAncestor(git: GitRunner, base: string, remote = 'origin'): AncestryResult {
  const steps: string[] = []
  if (isAncestor(git, base, true)) return { ancestor: true, steps }

  const head = mustGit(git, ['rev-parse', 'HEAD'])
  const shallow = () => mustGit(git, ['rev-parse', '--is-shallow-repository']) === 'true'

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
