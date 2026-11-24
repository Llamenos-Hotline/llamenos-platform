import { existsSync, readFileSync, statSync } from 'node:fs'
import { FLEET_BOT_LOGIN } from './config.js'
import { ghLoginResolver, verifyBotIdentity, type LoginResolver } from './identity.js'
import { FLEET_ENV_FILE } from './paths.js'

/**
 * `ok` means ONE thing: the file's `GH_TOKEN` was resolved and belongs to the
 * fleet bot (#2966). A file that merely has the right mode and a `GH_TOKEN=`
 * line is not `ok` — that is what this check used to call `ok`, and a line
 * holding the codeowner's credential passed it while inverting the one
 * property the review design depends on.
 *
 *   - `absent`     no file; the fleet runs as the operator's own `gh` account.
 *   - `unverified` a well-formed file whose token could not be resolved to a
 *                  login (network, revoked token). Neither wrong nor ok.
 *   - `fail`       misconfigured, or the token resolves to the wrong account.
 */
export type FleetEnvFileState = 'absent' | 'fail' | 'unverified' | 'ok'

export interface FleetEnvFileCheck {
  state: FleetEnvFileState
  message: string
}

/**
 * #773's bot account is not live yet, so the fleet running as the operator's
 * own `gh` auth is the EXPECTED state today — this is the one state `doctor`
 * must never fail on. Exported so `checkFleetEnvFile` and its tests don't
 * have two copies of this string to keep in sync.
 */
export const ABSENT_MESSAGE =
  "fleet runs as the operator's account; create ~/.llamenos-fleet/env with GH_TOKEN for the bot"

/**
 * Once `~/.llamenos-fleet/env` exists, though, it carries a real credential
 * read by two systemd units and the `llamenos-fleet` wrapper (see paths.ts's
 * `FLEET_ENV_FILE` comment) — at that point "missing" stops being the normal
 * case and a misconfigured file becomes a real problem:
 *
 *   - wrong permissions is a credential-leak risk (group/world-readable
 *     token file), reported as a hard FAIL, not a warning;
 *   - present with the right mode but no `GH_TOKEN` line silently does
 *     nothing while looking configured — also a hard FAIL, because a human
 *     who created the file believing it was wired up deserves to find out.
 *
 *   - a token that resolves to anyone but the fleet bot (`FLEET_BOT_LOGIN`) is
 *     a hard FAIL naming the resolved login (#2966): the reasoning above
 *     applies with more force, because that file also WORKS — as the wrong
 *     identity. A token that could not be resolved is `unverified`, never
 *     `ok` and never `fail`: nothing was learned about whose it is.
 *
 * Unit tested against a `FLEET_HOME` temp dir with an injected `resolve` — no
 * test needs a real credential or the network.
 */
export async function checkFleetEnvFile(resolve: LoginResolver = ghLoginResolver()): Promise<FleetEnvFileCheck> {
  if (!existsSync(FLEET_ENV_FILE)) {
    return { state: 'absent', message: ABSENT_MESSAGE }
  }

  let mode: number
  try {
    mode = statSync(FLEET_ENV_FILE).mode & 0o777
  } catch {
    return { state: 'fail', message: `${FLEET_ENV_FILE} exists but could not be stat'd` }
  }
  if (mode !== 0o600) {
    return {
      state: 'fail',
      message: `${FLEET_ENV_FILE} must be mode 0600 (found ${mode.toString(8).padStart(3, '0')}) — run: chmod 600 ${FLEET_ENV_FILE}`,
    }
  }

  let content: string
  try {
    content = readFileSync(FLEET_ENV_FILE, 'utf8')
  } catch {
    return { state: 'fail', message: `${FLEET_ENV_FILE} is mode 0600 but could not be read` }
  }
  const token = parseGhToken(content)
  if (token === undefined) {
    return { state: 'fail', message: `${FLEET_ENV_FILE} is mode 0600 but does not define GH_TOKEN` }
  }
  // `gh` and its wrapper both treat an empty GH_TOKEN as UNSET, so a blank
  // value is not a weak credential, it is no credential — and the worker then
  // silently runs as whichever account the wrapper's per-owner map picks.
  if (token === '') {
    return { state: 'fail', message: `${FLEET_ENV_FILE} defines GH_TOKEN with an empty value, which gh treats as unset` }
  }

  const identity = await verifyBotIdentity(token, resolve)
  switch (identity.state) {
    case 'bot':
      return { state: 'ok', message: `${FLEET_ENV_FILE} — GH_TOKEN verified as ${identity.login}` }
    case 'wrong':
      return { state: 'fail', message: `${FLEET_ENV_FILE}: GH_TOKEN ${identity.message}` }
    case 'unverified':
      return { state: 'unverified', message: `${FLEET_ENV_FILE}: GH_TOKEN present but ${identity.message}; expected ${FLEET_BOT_LOGIN}` }
  }
}

/**
 * The value of the LAST `GH_TOKEN=` assignment — later lines win, in a shell
 * `. file` and in systemd's `EnvironmentFile=` alike — with an optional
 * `export ` and one layer of matching quotes removed. `undefined` when there is
 * no assignment at all. The value is returned to the caller and never logged.
 */
export function parseGhToken(content: string): string | undefined {
  let value: string | undefined
  for (const line of content.split('\n')) {
    const m = /^\s*(?:export\s+)?GH_TOKEN=(.*)$/.exec(line.replace(/\r$/, ''))
    if (m === null) continue
    let v = (m[1] ?? '').trim()
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0] as string)) v = v.slice(1, -1)
    value = v
  }
  return value
}
