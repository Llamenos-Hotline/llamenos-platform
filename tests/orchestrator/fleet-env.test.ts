import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FLEET_BOT_LOGIN } from '../../orchestrator/src/config.js'
import type { LoginResolution, LoginResolver } from '../../orchestrator/src/identity.js'
import { fakeOperatorPat } from './fake-credentials.js'

/**
 * `checkFleetEnvFile` reads `FLEET_ENV_FILE`, which (see paths.ts) resolves
 * under `fleetHome()` — so, like paths.test.ts, these tests point
 * `FLEET_HOME` at their own per-test temp dir and re-import both modules
 * fresh via `vi.resetModules()`, rather than relying on the single shared
 * `FLEET_HOME` the whole suite already runs under
 * (`vitest.orchestrator.config.ts`'s `test.env`) — that dir is shared across
 * every test file in the run, so writing a real `env` file into it here
 * would leak into whatever else runs in the same process.
 */
const TOKEN = fakeOperatorPat('FleetEnvFileFixtureToken')

/** A resolver that records what it was asked about and answers `answer`. */
function fakeResolver(answer: LoginResolution): { resolve: LoginResolver; asked: (string | undefined)[] } {
  const asked: (string | undefined)[] = []
  return { asked, resolve: async (token) => { asked.push(token); return answer } }
}
const asBot = (): ReturnType<typeof fakeResolver> => fakeResolver({ kind: 'login', login: FLEET_BOT_LOGIN })

describe('checkFleetEnvFile — the states doctor surfaces', () => {
  const originalFleetHome = process.env['FLEET_HOME']
  let tempHome: string | undefined

  afterEach(() => {
    if (originalFleetHome === undefined) delete process.env['FLEET_HOME']
    else process.env['FLEET_HOME'] = originalFleetHome
    vi.resetModules()
    if (tempHome !== undefined) {
      try { rmSync(tempHome, { recursive: true, force: true }) } catch { /* already gone */ }
      tempHome = undefined
    }
  })

  async function freshModules() {
    vi.resetModules()
    const paths = await import('../../orchestrator/src/paths.js')
    const fleetEnv = await import('../../orchestrator/src/fleet-env.js')
    return { paths, fleetEnv }
  }

  function freshTempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'llamenos-fleet-env-test-'))
    tempHome = dir
    process.env['FLEET_HOME'] = dir
    return dir
  }

  it('absent — reports "absent" with the operator-account warning, never a failure', async () => {
    freshTempHome()
    const { fleetEnv } = await freshModules()
    const result = await fleetEnv.checkFleetEnvFile(asBot().resolve)
    expect(result.state).toBe('absent')
    expect(result.message).toBe(fleetEnv.ABSENT_MESSAGE)
    expect(result.message).toMatch(/operator's account/)
    expect(result.message).toMatch(/GH_TOKEN/)
  })

  it('present with the wrong mode (0644) — reports "fail" even though GH_TOKEN is defined', async () => {
    freshTempHome()
    const { paths, fleetEnv } = await freshModules()
    mkdirSync(dirname(paths.FLEET_ENV_FILE), { recursive: true })
    writeFileSync(paths.FLEET_ENV_FILE, `GH_TOKEN=${TOKEN}\n`)
    chmodSync(paths.FLEET_ENV_FILE, 0o644)
    const result = await fleetEnv.checkFleetEnvFile(asBot().resolve)
    expect(result.state).toBe('fail')
    expect(result.message).toMatch(/0600/)
  })

  it('present, mode 0600, GH_TOKEN resolves to the bot — reports "ok", naming the verified login', async () => {
    freshTempHome()
    const { paths, fleetEnv } = await freshModules()
    mkdirSync(dirname(paths.FLEET_ENV_FILE), { recursive: true })
    writeFileSync(paths.FLEET_ENV_FILE, `GH_TOKEN=${TOKEN}\n`)
    chmodSync(paths.FLEET_ENV_FILE, 0o600)
    const result = await fleetEnv.checkFleetEnvFile(asBot().resolve)
    expect(result.state).toBe('ok')
    expect(result.message).toContain(paths.FLEET_ENV_FILE)
    expect(result.message).toContain(`verified as ${FLEET_BOT_LOGIN}`)
  })

  // MUTATION GUARD: a version that only checked mode and never inspected
  // content would pass the 0644 test above (wrong mode is caught either way)
  // but would wrongly report "ok" here — a 0600 file that defines nothing
  // useful must still fail, since it looks configured while doing nothing.
  it('present, mode 0600, but GH_TOKEN missing — still reports "fail"', async () => {
    freshTempHome()
    const { paths, fleetEnv } = await freshModules()
    mkdirSync(dirname(paths.FLEET_ENV_FILE), { recursive: true })
    writeFileSync(paths.FLEET_ENV_FILE, 'SOME_OTHER_VAR=1\n')
    chmodSync(paths.FLEET_ENV_FILE, 0o600)
    const result = await fleetEnv.checkFleetEnvFile(asBot().resolve)
    expect(result.state).toBe('fail')
    expect(result.message).toMatch(/GH_TOKEN/)
  })

  // Non-self-referential: writes to a path built independently of
  // `paths.FLEET_ENV_FILE` — literally `join(FLEET_HOME, '.llamenos-fleet',
  // 'env')`, the same path the wrapper and systemd units hardcode via
  // `$HOME`/`%h` — rather than asking `paths.FLEET_ENV_FILE` where to write
  // and then asking it again whether the file is there. A regression back to
  // `FLEET_ENV_FILE = join(fleetHome(), 'env')` would write/stat a
  // DIFFERENT file (`<tempHome>/env`) than the one this test creates
  // (`<tempHome>/.llamenos-fleet/env`), so `checkFleetEnvFile` would report
  // 'absent' here even though a validly-configured file exists on disk —
  // that mismatch is exactly the bug this PR fixes.
  it('doctor finds a real GH_TOKEN file at the independently-computed .llamenos-fleet/env path', async () => {
    const dir = freshTempHome()
    const { fleetEnv } = await freshModules()
    const independentPath = join(dir, '.llamenos-fleet', 'env')
    mkdirSync(join(dir, '.llamenos-fleet'), { recursive: true })
    writeFileSync(independentPath, `GH_TOKEN=${TOKEN}\n`)
    chmodSync(independentPath, 0o600)
    const result = await fleetEnv.checkFleetEnvFile(asBot().resolve)
    expect(result.state).toBe('ok')
    expect(result.message).toContain(independentPath)
  })
})

/**
 * #2966 — the gate, audited by breaking it. A test proving the bot's token is
 * accepted shows nothing about whether the codeowner's is refused, so every
 * direction is its own case: the bot, the codeowner, some third account, and a
 * credential that cannot be resolved at all.
 */
describe('checkFleetEnvFile — whose token is it (#2966)', () => {
  const originalFleetHome = process.env['FLEET_HOME']
  let tempHome: string | undefined

  afterEach(() => {
    if (originalFleetHome === undefined) delete process.env['FLEET_HOME']
    else process.env['FLEET_HOME'] = originalFleetHome
    vi.resetModules()
    if (tempHome !== undefined) {
      try { rmSync(tempHome, { recursive: true, force: true }) } catch { /* already gone */ }
      tempHome = undefined
    }
  })

  async function withEnvFile(content: string) {
    tempHome = mkdtempSync(join(tmpdir(), 'llamenos-fleet-identity-test-'))
    process.env['FLEET_HOME'] = tempHome
    vi.resetModules()
    const paths = await import('../../orchestrator/src/paths.js')
    const fleetEnv = await import('../../orchestrator/src/fleet-env.js')
    mkdirSync(dirname(paths.FLEET_ENV_FILE), { recursive: true })
    writeFileSync(paths.FLEET_ENV_FILE, content)
    chmodSync(paths.FLEET_ENV_FILE, 0o600)
    return fleetEnv
  }

  it('REFUSES a token that resolves to the codeowner — fail, naming the login, never ok', async () => {
    const fleetEnv = await withEnvFile(`GH_TOKEN=${TOKEN}\n`)
    const r = fakeResolver({ kind: 'login', login: 'rhonda-rodododo' })
    const result = await fleetEnv.checkFleetEnvFile(r.resolve)
    expect(result.state).toBe('fail')
    expect(result.message).toContain('rhonda-rodododo')
    expect(result.message).toContain(FLEET_BOT_LOGIN)
    expect(result.message).toMatch(/codeowner/)
  })

  it('REFUSES a token that resolves to some third account — fail, naming it', async () => {
    const fleetEnv = await withEnvFile(`GH_TOKEN=${TOKEN}\n`)
    const result = await fleetEnv.checkFleetEnvFile(fakeResolver({ kind: 'login', login: 'some-contributor' }).resolve)
    expect(result.state).toBe('fail')
    expect(result.message).toContain('some-contributor')
  })

  it('a login is compared case-insensitively — GitHub logins are', async () => {
    const fleetEnv = await withEnvFile(`GH_TOKEN=${TOKEN}\n`)
    const result = await fleetEnv.checkFleetEnvFile(fakeResolver({ kind: 'login', login: FLEET_BOT_LOGIN.toUpperCase() }).resolve)
    expect(result.state).toBe('ok')
  })

  it('a token that cannot be resolved is "unverified": not ok, and not the wrong-identity fail either', async () => {
    const fleetEnv = await withEnvFile(`GH_TOKEN=${TOKEN}\n`)
    const result = await fleetEnv.checkFleetEnvFile(fakeResolver({ kind: 'unresolved', reason: 'exit 1: network unreachable' }).resolve)
    expect(result.state).toBe('unverified')
    expect(result.message).toMatch(/NOT verified/)
    expect(result.message).toContain('network unreachable')
  })

  it('hands the resolver the FILE\'s token — not the process environment\'s', async () => {
    const fleetEnv = await withEnvFile(`GH_TOKEN=${TOKEN}\n`)
    const r = asBot()
    await fleetEnv.checkFleetEnvFile(r.resolve)
    expect(r.asked).toEqual([TOKEN])
  })

  it('never puts any part of the credential in a message, on any outcome', async () => {
    const fleetEnv = await withEnvFile(`GH_TOKEN=${TOKEN}\n`)
    const answers: LoginResolution[] = [
      { kind: 'login', login: FLEET_BOT_LOGIN },
      { kind: 'login', login: 'rhonda-rodododo' },
      { kind: 'unresolved', reason: 'exit 1: boom' },
    ]
    for (const a of answers) {
      const { message } = await fleetEnv.checkFleetEnvFile(fakeResolver(a).resolve)
      expect(message).not.toContain(TOKEN)
      expect(message).not.toContain(TOKEN.slice(4, 20))
    }
  })

  it('an empty GH_TOKEN is a fail (gh treats it as unset) and the resolver is never consulted', async () => {
    const fleetEnv = await withEnvFile('GH_TOKEN=\n')
    const r = asBot()
    const result = await fleetEnv.checkFleetEnvFile(r.resolve)
    expect(result.state).toBe('fail')
    expect(result.message).toMatch(/empty/)
    expect(r.asked).toEqual([])
  })

  it('a missing GH_TOKEN never reaches the resolver either', async () => {
    const fleetEnv = await withEnvFile('OTHER=1\n')
    const r = asBot()
    expect((await fleetEnv.checkFleetEnvFile(r.resolve)).state).toBe('fail')
    expect(r.asked).toEqual([])
  })

  it.each([
    ['export prefix', `export GH_TOKEN=${TOKEN}\n`],
    ['double quotes', `GH_TOKEN="${TOKEN}"\n`],
    ['single quotes', `GH_TOKEN='${TOKEN}'\n`],
    ['CRLF line ending', `GH_TOKEN=${TOKEN}\r\n`],
    ['a later assignment wins', `GH_TOKEN=stale-placeholder\nGH_TOKEN=${TOKEN}\n`],
  ])('parses the credential from: %s', async (_name, content) => {
    const fleetEnv = await withEnvFile(content)
    const r = asBot()
    expect((await fleetEnv.checkFleetEnvFile(r.resolve)).state).toBe('ok')
    expect(r.asked).toEqual([TOKEN])
  })
})

describe('orchestrator/bin/llamenos-fleet wrapper sources the fleet env file', () => {
  // No shell test harness exists for this wrapper (it is a plain bash script,
  // not something the vitest suite executes), so per the task this asserts
  // the exact sourcing line is present — the same line the two systemd units
  // carry via `EnvironmentFile=-%h/.llamenos-fleet/env`, so a dispatched
  // worker or a hand-run `llamenos-fleet` command inherits `GH_TOKEN` too.
  it('contains the exact `[ -f ... ] && set -a && . ... && set +a` sourcing line', () => {
    const wrapperPath = join(import.meta.dirname, '..', '..', 'orchestrator', 'bin', 'llamenos-fleet')
    const content = readFileSync(wrapperPath, 'utf8')
    expect(content).toContain('[ -f "$HOME/.llamenos-fleet/env" ] && set -a && . "$HOME/.llamenos-fleet/env" && set +a')
  })
})
