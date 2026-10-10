import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { DISPATCH_SCRIPT, DISPATCH_SKILL_DIR } from './paths.js'

/**
 * The commit at which the Llamenos worker rules were fixed to point at
 * `llamenos-platform` (this monorepo) instead of the retired `llamenos-hotline`
 * v1 repo, and to drop the two commands (`bun run dev:docker`, `bun run
 * test:unit`) that repo never had. Recorded here as documentation of the floor
 * this dependency must be at or past — `checkDispatchDependency` verifies the
 * live rules content directly rather than comparing commit hashes, because a
 * hash comparison would pass on a checkout that reverted the fix's content
 * while keeping a later commit on top of it.
 */
export const MIN_DISPATCH_COMMIT = '1facb484b5101e2e74a429425c604d73a97bbbf9'

export interface DependencyFacts {
  exists: boolean
  executable: boolean
  isGitRepo: boolean
  /** Uncommitted changes in the dependency repo. A dispatch driven by an
   *  uncommitted edit is not reproducible — this is exactly how a fix to the
   *  worker rules once sat in a working tree while the llamenos PR that
   *  depended on it carried only the fix's generated output, not the fix
   *  itself. */
  dirty: boolean
  rulesClean: boolean
  /** True only when `isGitRepo` is also true but the repo's state could not
   *  be fully read — `rev-parse HEAD` fails on a repo with zero commits
   *  ("fatal: ambiguous argument 'HEAD'"), and either call can fail if the
   *  repo becomes unreadable between them. Optional (defaults to "readable")
   *  so existing call sites that predate this fact stay valid. */
  unreadable?: boolean
}

export interface DependencyReport {
  ok: boolean
  problems: string[]
  commit?: string
}

/**
 * Pure predicate over dependency facts. Kept separate from the impure fact-
 * gathering below so the failure-mode logic (what counts as a problem) can be
 * tested without touching the filesystem or spawning git.
 */
export function problemsWith(facts: DependencyFacts): string[] {
  const problems: string[] = []
  if (!facts.exists) {
    problems.push(`dispatch script not found at ${DISPATCH_SCRIPT}`)
    return problems // nothing else here is checkable if the script itself is missing
  }
  if (!facts.executable) {
    problems.push(`dispatch script is not executable: ${DISPATCH_SCRIPT}`)
  }
  if (!facts.isGitRepo) {
    problems.push(`dispatch skill directory is not inside a git repository: ${DISPATCH_SKILL_DIR} — its version cannot be pinned or traced`)
  } else if (facts.unreadable) {
    problems.push(
      `dispatch dependency repo's state could not be fully read (git rev-parse HEAD or git status failed) — ` +
      'possibly a repo with zero commits, or one that became unreadable mid-check',
    )
  }
  if (facts.dirty) {
    problems.push('dispatch dependency repo has uncommitted changes — a dispatch driven by an uncommitted edit is not reproducible')
  }
  if (!facts.rulesClean) {
    problems.push(
      'llamenos worker rules reference a command this repo does not have (dev:docker, test:unit) ' +
      'or the retired sibling repo (llamenos-hotline)',
    )
  }
  return problems
}

/** A path-shaped or command-shaped reference inside a fenced code block is a
 *  worker being told to run something; the same words inside prose are not —
 *  see the long comment on the "does not flag prose" test in
 *  dependency.test.ts for the production case (`prompt-rules-llamenos.md`'s
 *  own disambiguation sentence) this distinction exists to avoid flagging. */
const DEAD_REFERENCE_PATTERN = /\bdev:docker\b|\brun test:unit\b|\bllamenos-hotline\b/

function fencedCodeBlocks(markdown: string): string[] {
  const out: string[] = []
  for (const m of markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    if (m[1] !== undefined) out.push(m[1])
  }
  return out
}

export function rulesReferenceDeadCommands(markdown: string): boolean {
  return fencedCodeBlocks(markdown).some((block) => DEAD_REFERENCE_PATTERN.test(block))
}

function isExecutable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0
  } catch {
    return false
  }
}

export interface GitFacts {
  isGitRepo: boolean
  dirty: boolean
  commit?: string
  /** See DependencyFacts.unreadable — set when isGitRepo but a later git call failed. */
  unreadable: boolean
}

/** Runs one git subcommand, returning its stdout or `undefined` on ANY
 *  failure. Never throws — this function's entire purpose is to keep a
 *  single failing git call (a repo with zero commits, one that becomes
 *  unreadable mid-check) from crashing the caller instead of being reported
 *  as a problem. */
function tryGit(dir: string, args: string[]): string | undefined {
  try {
    // stderr piped (not inherited): a zero-commit repo's expected
    // "fatal: ambiguous argument 'HEAD'" is a normal, handled outcome here,
    // not something that should print to this process's own stderr.
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return undefined
  }
}

/**
 * Each git call after confirming this is a repo is guarded independently.
 * The original version let `rev-parse HEAD` or `status --porcelain` throw
 * straight out of this function — exactly backwards for something whose
 * whole job is to make dependency state never surprise the caller. A repo
 * with zero commits fails `rev-parse HEAD` ("fatal: ambiguous argument
 * 'HEAD'") while `status --porcelain` still works fine; a repo that becomes
 * unreadable between the two calls (permissions change, filesystem hiccup)
 * can fail either one independently. Both are reported as `unreadable`
 * rather than thrown.
 */
export function gitFactsFor(dir: string): GitFacts {
  if (tryGit(dir, ['rev-parse', '--is-inside-work-tree']) === undefined) {
    return { isGitRepo: false, dirty: false, unreadable: false }
  }
  const commitRaw = tryGit(dir, ['rev-parse', 'HEAD'])
  const statusRaw = tryGit(dir, ['status', '--porcelain'])
  return {
    isGitRepo: true,
    dirty: statusRaw !== undefined && statusRaw.trim().length > 0,
    commit: commitRaw?.trim(),
    unreadable: commitRaw === undefined || statusRaw === undefined,
  }
}

function rulesAreClean(): boolean {
  const rulesFile = join(DISPATCH_SKILL_DIR, 'prompt-rules-llamenos.md')
  if (!existsSync(rulesFile)) return true // nothing to check — cannot fail a check that can't run
  return !rulesReferenceDeadCommands(readFileSync(rulesFile, 'utf8'))
}

/**
 * Gathers the live facts and reports the dependency's state. Called by
 * `doctor` (surfaced as path + HEAD commit + every problem, ALL of them
 * hard failures since issue #1801 — an uncommitted edit to dispatch-one.sh
 * is the same provenance hole as a stale runtime checkout: code runs that
 * no reviewed commit describes) and by the engine adapter at dispatch time,
 * which records the HEAD commit in the run's ledger note so a run's
 * behaviour can always be traced back to the exact version of the script
 * that produced it — the version pin llamenos cannot otherwise express for
 * a dependency it does not vendor.
 */
export function checkDispatchDependency(): DependencyReport {
  const exists = existsSync(DISPATCH_SCRIPT)
  const executable = exists && isExecutable(DISPATCH_SCRIPT)
  const git = gitFactsFor(DISPATCH_SKILL_DIR)
  const rulesClean = rulesAreClean()
  const problems = problemsWith({
    exists, executable, isGitRepo: git.isGitRepo, dirty: git.dirty, rulesClean, unreadable: git.unreadable,
  })
  return { ok: problems.length === 0, problems, commit: git.commit }
}
