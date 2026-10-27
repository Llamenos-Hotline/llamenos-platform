import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PR_COMMITS_PAGE_SIZE, type PrCommitIdentity } from './ci.js'

const execFileAsync = promisify(execFile)

/**
 * The repo is pinned rather than inferred. A second git remote makes every `gh`
 * invocation exit with "multiple remotes detected", which reads at a call site
 * like an auth or network failure rather than a configuration one. This repo is
 * meant to have exactly one remote (asserted by `doctor`); the pin means a
 * violation cannot silently retarget the fleet at another repository.
 *
 * The owner is `Llamenos-Hotline` since the org move (#1218). The pin MUST be
 * the live path, never the pre-move one, and this is the reason it is a
 * blocker rather than tidying: GitHub serves the owner redirect
 * `rhonda-rodododo/llamenos-platform -> Llamenos-Hotline/llamenos-platform`
 * only for as long as the old path stays unoccupied. Recreating a repo at that
 * name takes the redirect down and inherits it — and every write this pin
 * governs (issue comments, PR merges, review verdicts, label edits) would then
 * land in that repository instead, silently, with `gh` reporting success.
 *
 * To be precise about the threat, since a vague one invites being dismissed:
 * a repo under `rhonda-rodododo/` can only be created by that account, so this
 * is not a name a stranger can grab today. It becomes one if the account is
 * ever deleted or renamed, which frees the username for anyone to register.
 * Either way the redirect's lifetime is a condition this project does not
 * control, and pinning the post-move path removes the dependency on it.
 */
export const REPO = 'Llamenos-Hotline/llamenos-platform'

/**
 * A commit SHA fit to sit in an API path segment, or a throw. Every caller
 * that builds `repos/${REPO}/commits/${commitSha(x)}/…` goes through here
 * because the segment is otherwise the caller's to fill: `fetch` and `gh api`
 * resolve `..` (and `%2e%2e`) under WHATWG URL rules, so a commit's
 * check-run READ with `..` as its ref lands on the endpoint that CREATES a
 * check run (#1673). Forty lowercase hex characters cannot contain a dot, a
 * percent sign or a slash, so a path built from one stays on the commit it
 * names. The check-run rail in `guards.test.ts` admits a reader outside
 * `review-and-merge.ts` only when its path is built through this function.
 */
export function commitSha(ref: string): string {
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`not a 40-hex commit SHA: ${JSON.stringify(ref)}`)
  return ref
}

/**
 * `gh api` has no `-R`/`--repo` flag at all — confirmed against the real
 * binary (`gh api <endpoint> -R owner/repo` and `gh -R owner/repo api
 * <endpoint>` both fail with `unknown shorthand flag: 'R' in -R`; `--repo`
 * fails the same way with `unknown flag: --repo`). Every subcommand other
 * than `api` DOES accept it (`gh issue list -R owner/repo`, etc.) — `api` is
 * the one raw HTTP passthrough where the repo has to be embedded in the
 * endpoint path itself, which every caller in this codebase already does
 * (`repos/${REPO}/...` — see `review-cache.ts`'s `lookup`, and this PR's own
 * `GitHubSink.editComment`, which hit the identical failure while adding
 * digest/halt-resume reporting). Appending `-R` onto an `api` call used to
 * make `gh` itself reject the whole invocation before it ever reached
 * GitHub, which `ghJson`'s catch-all then silently turned into an
 * indistinguishable-from-a-genuine-miss `undefined` — so the one real
 * consumer of this path (the review-verdict artifact cache) was unable to
 * ever record a hit, not just on an edge case but on every single call,
 * forever.
 */
export function ghArgs(args: string[]): string[] {
  if (args[0] === 'api') return args
  return args.includes('-R') || args.includes('--repo') ? args : [...args, '-R', REPO]
}

/** Runs gh by argv — never through a shell. Returns stdout. Throws on non-zero exit. */
export async function gh(args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync('gh', ghArgs(args), {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout
}

const STDERR_SNIPPET_CHARS = 200

/**
 * A `gh` failure rendered for a human, in one line. Exit code first because
 * it separates the classes at a glance — a non-zero code is gh refusing
 * (auth, 404, rate limit), a signal is a timeout, and neither is a JSON
 * parse error. The stderr snippet is bounded because this goes in a log
 * line, and `gh` can emit a great deal of it.
 */
export function describeGhFailure(e: unknown): string {
  const err = e as { code?: unknown; signal?: unknown; killed?: boolean; stderr?: string; message?: string }
  const how = typeof err.code === 'number' ? `exit ${err.code}`
    : err.killed === true || err.signal != null ? `killed (${String(err.signal ?? 'timeout')})`
    : err.code != null ? `error ${String(err.code)}`
    : 'threw'
  const detail = (err.stderr ?? '').trim() || (err.message ?? String(e)).trim()
  return `${how}: ${detail.replace(/\s+/g, ' ').slice(0, STDERR_SNIPPET_CHARS)}`
}

/**
 * Returns `undefined` on ANY failure — never an empty array or null. Callers
 * must be able to tell "nothing there" from "could not look". Collapsing those
 * two is how a fleet reports a quiet night over a full backlog.
 *
 * `onFailure` exists because returning `undefined` alone destroys the one
 * thing needed to diagnose the failure. The fleet's first scheduled tick
 * after going live aborted with `source unreadable for lane backend` and
 * nothing else — no exit code, no stderr, no error class — so a credential
 * problem, a rate limit, a network blip and a real outage were
 * indistinguishable, and the pass that fails closed also failed silently.
 */
export async function ghJson<T>(
  args: string[],
  timeoutMs = 60_000,
  onFailure?: (detail: string) => void,
): Promise<T | undefined> {
  try {
    const out = await gh(args, timeoutMs)
    return JSON.parse(out) as T
  } catch (e) {
    onFailure?.(describeGhFailure(e))
    return undefined
  }
}

/**
 * The PR's commits by identity — ONE page, `PR_COMMITS_PAGE_SIZE` — or
 * `undefined` when unreadable (`commitsAllBotAuthored` reads that as "not all
 * bot": fail closed). Needs only `pull-requests: read`.
 */
export async function readPrCommits(
  pr: string,
  onFailure?: (detail: string) => void,
): Promise<PrCommitIdentity[] | undefined> {
  if (!/^[0-9]+$/.test(pr)) return undefined
  const data = await ghJson<{
    sha: string
    author?: { login?: string | null } | null
    committer?: { login?: string | null } | null
  }[]>(['api', `repos/${REPO}/pulls/${pr}/commits?per_page=${PR_COMMITS_PAGE_SIZE}`], 30_000, onFailure)
  if (!Array.isArray(data)) return undefined
  return data.map((c) => ({ sha: c.sha, authorLogin: c.author?.login, committerLogin: c.committer?.login }))
}
