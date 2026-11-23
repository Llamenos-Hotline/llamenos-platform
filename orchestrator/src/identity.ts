import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { FLEET_BOT_LOGIN, TRUST_ANCHOR_APPROVERS } from './config.js'
import { describeGhFailure } from './gh.js'
import type { TmuxGlobalEnv } from './tmux-isolation.js'

const execFileAsync = promisify(execFile)

/**
 * #2966 — whose credential is this?
 *
 * The fleet's review design has two identities with non-interchangeable roles:
 * the bot (`FLEET_BOT_LOGIN`) authors pull requests and the codeowner reviews
 * them. A credential that resolves to anyone else is not "a bit off" — it
 * WORKS, as the wrong identity, and the pull request it opens is one the
 * codeowner is forbidden to review. This module is the one place that asks
 * whose a credential is, and answers with three outcomes that must never be
 * collapsed into each other:
 *
 *   - `bot`        the credential resolves to FLEET_BOT_LOGIN.
 *   - `wrong`      it resolves to some other login. A hard failure that names
 *                  the login — the one thing safe to print.
 *   - `unverified` it could not be resolved at all (network, revoked token,
 *                  GitHub down). NOT `wrong` — nothing was learned about whose
 *                  it is, and saying otherwise sends the operator to rotate a
 *                  credential that may be fine — and NOT `ok`, because "I
 *                  could not look" is the shape every silent failure here
 *                  takes. Callers that gate an action treat it as a refusal.
 *
 * The credential itself is never handled by this module's logic beyond handing
 * it to `gh` through the child's ENVIRONMENT (never argv, which `ps` shows),
 * and only the resolved login is ever reported. Every message is scrubbed of
 * the credential's literal value before it leaves.
 */

export type LoginResolution =
  | { kind: 'login'; login: string }
  | { kind: 'unresolved'; reason: string }

/**
 * Resolves the login a credential belongs to. `token` is the credential to
 * test; `undefined` means "whatever `gh` would use with the ambient
 * environment" — the path a worker's `gh pr create` takes when nothing in its
 * environment names a token. Injected so a unit test never needs a real
 * credential or the network.
 */
export type LoginResolver = (token: string | undefined) => Promise<LoginResolution>

export type BotIdentity =
  | { state: 'bot'; login: string }
  | { state: 'wrong'; login: string; message: string }
  | { state: 'unverified'; message: string }

/** A GitHub login: 1-39 alphanumerics or hyphens (plus `[bot]` for apps). */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/

/** The seam the default resolver runs `gh` through. */
export type GhRunner = (
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string }>

const defaultRunner: GhRunner = (args, opts) =>
  execFileAsync('gh', args, { ...opts, maxBuffer: 1024 * 1024 })

const RESOLVE_TIMEOUT_MS = 20_000

/**
 * Removes the credential from a `gh` failure before it becomes a message: its
 * literal value, and anything token-shaped (`gh*_…`, `github_pat_…`) in case
 * gh echoed a different one. Local on purpose — `github-app.ts`'s scrubber is
 * the GitHub App minting module's, and the set of modules allowed to import it
 * is pinned exactly (credential-boundary.test.ts, #1867); a resolver of logins
 * has no business being on that list.
 */
function scrubCredential(text: string, token: string | undefined): string {
  const literal = token !== undefined && token.length >= 8 ? text.split(token).join('[redacted]') : text
  return literal
    .replace(/\bgh[a-z]_[A-Za-z0-9_]{16,}/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[redacted]')
}

/**
 * The production resolver: `gh api user --jq .login`.
 *
 * Asking `gh` rather than calling the API directly is deliberate. The question
 * a worker's PR depends on is "who will `gh` act as?", and `gh` on this host is
 * a wrapper (`~/.local/bin/gh`) with a fixed precedence — an explicit
 * `GH_TOKEN` in the environment WINS and is passed straight through; without
 * one it picks an account from a per-owner map keyed on the working tree's git
 * remote; without a match, `gh`'s own active account. Reading the token's
 * owner straight from api.github.com would answer a different question, and
 * the two disagree exactly when it matters.
 *
 * With `token` given it is placed in the child's `GH_TOKEN` (explicit, so the
 * wrapper's map cannot override it). With `token` undefined the child gets the
 * ambient environment minus any inherited `GH_TOKEN`, so the answer is the
 * wrapper-or-default one and never the dispatcher's own token by accident.
 */
export function ghLoginResolver(run: GhRunner = defaultRunner): LoginResolver {
  return async (token) => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (token === undefined) delete env['GH_TOKEN']
    else env['GH_TOKEN'] = token
    try {
      const { stdout } = await run(['api', 'user', '--jq', '.login'], { env, timeout: RESOLVE_TIMEOUT_MS })
      const login = stdout.trim()
      // `.login` of a body with no login prints the literal `null`, which is a
      // syntactically valid login — and an account someone could register.
      if (!LOGIN_RE.test(login) || login === 'null') {
        return { kind: 'unresolved', reason: 'gh api user returned something that is not a GitHub login' }
      }
      return { kind: 'login', login }
    } catch (e) {
      return { kind: 'unresolved', reason: scrubCredential(describeGhFailure(e), token) }
    }
  }
}

/** GitHub logins are case-insensitive. */
const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Pure: the verdict for one resolution. Exported so the decision table is
 *  testable without a resolver. */
export function judgeLogin(resolution: LoginResolution, expected: string = FLEET_BOT_LOGIN): BotIdentity {
  if (resolution.kind === 'unresolved') {
    return {
      state: 'unverified',
      message: `could not establish whose credential this is (${resolution.reason}) — identity NOT verified`,
    }
  }
  const { login } = resolution
  if (sameLogin(login, expected)) return { state: 'bot', login }
  const codeowner = TRUST_ANCHOR_APPROVERS.some((a) => sameLogin(a, login))
  const why = codeowner
    ? `"${login}" is the codeowner: a pull request it authors cannot be reviewed by it, and merges with no codeowner review recorded`
    : `a pull request it authors is not the bot's and the codeowner review design does not apply to it`
  return {
    state: 'wrong',
    login,
    message: `credential resolves to "${login}", not the fleet bot "${expected}" — ${why}`,
  }
}

/** Resolve `token` (or the ambient credential when undefined) and judge it. */
export async function verifyBotIdentity(
  token: string | undefined,
  resolve: LoginResolver = ghLoginResolver(),
  expected: string = FLEET_BOT_LOGIN,
): Promise<BotIdentity> {
  return judgeLogin(await resolve(token), expected)
}

// ---------------------------------------------------------------------------
// The pre-dispatch gate
// ---------------------------------------------------------------------------

export interface WorkerIdentityFacts {
  /** `GH_TOKEN` in the DISPATCHER's environment. */
  dispatcherToken: string | undefined
  /** `GH_TOKEN` in the tmux server's global environment — what a worker's
   *  session is actually built from once a server is running. */
  tmuxToken: TmuxGlobalEnv
  resolve: LoginResolver
}

/**
 * Refuses to launch a worker whose `gh pr create` would not run as the bot, or
 * `undefined` when it would. This is the check that sits on the path the action
 * takes (#2966): `doctor` inspecting a file gates nothing, and a dispatcher
 * holding the right token proves nothing about a worker.
 *
 * Why the credential must be EXPLICIT, not inferred. The `gh` wrapper's
 * precedence is: a `GH_TOKEN` in the process environment wins and is passed
 * straight through; only without one does it pick an account from a per-owner
 * map keyed on the working tree's git remote. A worker with no `GH_TOKEN`
 * therefore runs as whichever account the remote's owner maps to — a function of
 * a remote URL, which has changed and which nothing here controls. Requiring an
 * explicit, verified `GH_TOKEN` reaching the worker is what makes the answer
 * deterministic. It reaches the worker through the tmux server's environment,
 * so that is read and verified too: when a server is already running, ITS token
 * is the worker's.
 *
 * Every non-`bot` outcome refuses, `unverified` included — a gate that lets an
 * unresolvable identity through reports "could not look" as "fine".
 */
export async function workerIdentityRefusal(f: WorkerIdentityFacts): Promise<string | undefined> {
  const remedy = 'put the bot\'s GH_TOKEN in ~/.llamenos-fleet/env'
  if (f.dispatcherToken === undefined || f.dispatcherToken === '') {
    return `refusing to dispatch: GH_TOKEN is not set in the dispatcher's environment, so a worker would act as ` +
      `whichever account the gh wrapper's per-owner map or gh's active account selects, not as ${FLEET_BOT_LOGIN} (#2966) — ${remedy}`
  }

  const checks: [string, string][] = [['the dispatcher', f.dispatcherToken]]
  switch (f.tmuxToken.kind) {
    case 'no-server':
      break // the server will be born from this process's environment, which is checked above
    case 'value':
      if (f.tmuxToken.value !== f.dispatcherToken) checks.push(['the tmux server', f.tmuxToken.value])
      break
    case 'unset':
      return `refusing to dispatch: the running tmux server has no GH_TOKEN in its environment. A worker's session is built ` +
        `from the SERVER's environment, not the dispatcher's, so it would act as whichever account the gh wrapper's ` +
        `per-owner map selects — the codeowner, for some remotes — not as ${FLEET_BOT_LOGIN} (#2966). ` +
        'Fix: from a shell that sourced the fleet env (set -a; . ~/.llamenos-fleet/env; set +a) run ' +
        'tmux set-environment -g GH_TOKEN "$GH_TOKEN", or end the server once idle so the next dispatch starts one that has it'
    case 'unreadable':
      return `refusing to dispatch: the tmux server's GH_TOKEN could not be read (${f.tmuxToken.reason}), so the ` +
        `identity a worker would run as is unknown (#2966)`
  }

  for (const [who, token] of checks) {
    const verdict = await verifyBotIdentity(token, f.resolve)
    if (verdict.state === 'wrong') return `refusing to dispatch: GH_TOKEN as ${who} holds it — ${verdict.message} (#2966)`
    if (verdict.state === 'unverified') return `refusing to dispatch: GH_TOKEN as ${who} holds it — ${verdict.message} (#2966)`
  }
  return undefined
}
