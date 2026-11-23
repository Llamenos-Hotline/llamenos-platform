import { describe, it, expect, afterEach, vi } from 'vitest'
import { FLEET_BOT_LOGIN } from '../../orchestrator/src/config.js'
import { buildBrief, renderBrief } from '../../orchestrator/src/brief.js'
import type { Lane } from '../../orchestrator/src/config.js'
import { runAssertIdentity } from '../../orchestrator/src/cli.js'
import { dispatch, type DispatchRequest } from '../../orchestrator/src/engines.js'
import {
  ghLoginResolver, judgeLogin, verifyBotIdentity, workerIdentityRefusal,
  type GhRunner, type LoginResolution, type LoginResolver, type WorkerIdentityFacts,
} from '../../orchestrator/src/identity.js'
import { parseGlobalEnv, type TmuxGlobalEnv } from '../../orchestrator/src/tmux-isolation.js'
import { fakeInstallationToken, fakeOperatorPat } from './fake-credentials.js'

/**
 * #2966: whose credential is it, and does the answer reach the worker?
 *
 * No test here needs a real credential or the network: every resolution goes
 * through an injected `LoginResolver`, and the production resolver is driven
 * through a fake `gh` runner. The credentials are credential-SHAPED fixtures
 * assembled at runtime (see fake-credentials.ts).
 */

const BOT_TOKEN = fakeInstallationToken('BotCredentialFixtureOnly')
const CODEOWNER_TOKEN = fakeOperatorPat('CodeownerCredentialFixtureOnly')
const OTHER_TOKEN = fakeOperatorPat('SomeoneElsesCredentialFixture')

const CODEOWNER = 'rhonda-rodododo'

/** A resolver that maps each known fixture token to a login; anything else is unresolvable. */
function byToken(table: Record<string, string>): { resolve: LoginResolver; asked: (string | undefined)[] } {
  const asked: (string | undefined)[] = []
  return {
    asked,
    resolve: async (token) => {
      asked.push(token)
      const login = token === undefined ? undefined : table[token]
      return login === undefined
        ? { kind: 'unresolved', reason: 'exit 1: HTTP 401: Bad credentials' }
        : { kind: 'login', login }
    },
  }
}

describe('judgeLogin — the decision table', () => {
  it('the bot is accepted', () => {
    expect(judgeLogin({ kind: 'login', login: FLEET_BOT_LOGIN })).toEqual({ state: 'bot', login: FLEET_BOT_LOGIN })
  })

  it('the codeowner is refused, by name, with the reason that matters', () => {
    const v = judgeLogin({ kind: 'login', login: CODEOWNER })
    expect(v.state).toBe('wrong')
    if (v.state !== 'wrong') throw new Error('unreachable')
    expect(v.login).toBe(CODEOWNER)
    expect(v.message).toContain(`"${CODEOWNER}"`)
    expect(v.message).toContain(`"${FLEET_BOT_LOGIN}"`)
    expect(v.message).toMatch(/cannot be reviewed/)
  })

  it('any other account is refused, by name', () => {
    const v = judgeLogin({ kind: 'login', login: 'a-third-account' })
    expect(v.state).toBe('wrong')
    expect(v.state === 'wrong' && v.message).toContain('a-third-account')
  })

  it('an unresolvable credential is "unverified" — neither the bot nor the wrong account', () => {
    const v = judgeLogin({ kind: 'unresolved', reason: 'exit 1: dial tcp: network is unreachable' })
    expect(v.state).toBe('unverified')
    expect(v.state === 'unverified' && v.message).toMatch(/NOT verified/)
  })

  it('the expected login is a parameter, so the bot is configuration and not a branch', () => {
    expect(judgeLogin({ kind: 'login', login: 'someone' }, 'someone').state).toBe('bot')
    expect(judgeLogin({ kind: 'login', login: FLEET_BOT_LOGIN }, 'someone').state).toBe('wrong')
  })
})

describe('ghLoginResolver — the production resolver, through a fake gh', () => {
  function runner(result: { stdout: string } | Error): { run: GhRunner; calls: { args: string[]; env: NodeJS.ProcessEnv }[] } {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    return {
      calls,
      run: async (args, opts) => {
        calls.push({ args, env: opts.env })
        if (result instanceof Error) throw result
        return result
      },
    }
  }

  const savedToken = process.env['GH_TOKEN']
  afterEach(() => {
    if (savedToken === undefined) delete process.env['GH_TOKEN']
    else process.env['GH_TOKEN'] = savedToken
  })

  it('passes the credential through the child ENVIRONMENT, never argv', async () => {
    const r = runner({ stdout: `${FLEET_BOT_LOGIN}\n` })
    const out = await ghLoginResolver(r.run)(BOT_TOKEN)
    expect(out).toEqual({ kind: 'login', login: FLEET_BOT_LOGIN })
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]?.env['GH_TOKEN']).toBe(BOT_TOKEN)
    expect(r.calls[0]?.args.join(' ')).not.toContain(BOT_TOKEN)
  })

  it('with no credential given it strips an inherited GH_TOKEN, so the ambient answer is never the dispatcher\'s token by accident', async () => {
    process.env['GH_TOKEN'] = CODEOWNER_TOKEN
    const r = runner({ stdout: `${FLEET_BOT_LOGIN}\n` })
    await ghLoginResolver(r.run)(undefined)
    expect('GH_TOKEN' in (r.calls[0]?.env ?? {})).toBe(false)
  })

  it('output that is not a login is unresolved, not a login', async () => {
    for (const stdout of ['', 'null\n', '<html>rate limited</html>', 'two words', `${'x'.repeat(60)}`]) {
      const out = await ghLoginResolver(runner({ stdout }).run)(BOT_TOKEN)
      expect(out.kind, JSON.stringify(stdout)).toBe('unresolved')
    }
  })

  it('a gh failure is unresolved (never a login), and the credential is scrubbed from its reason', async () => {
    const boom = Object.assign(new Error('Command failed'), {
      code: 1, stderr: `gh: HTTP 401 for token ${BOT_TOKEN}: Bad credentials`,
    })
    const out = await ghLoginResolver(runner(boom).run)(BOT_TOKEN)
    expect(out.kind).toBe('unresolved')
    const reason = out.kind === 'unresolved' ? out.reason : ''
    expect(reason).toContain('401')
    expect(reason).not.toContain(BOT_TOKEN)
    expect(reason).not.toContain(BOT_TOKEN.slice(4, 24))
  })

  it('a network failure surfaces as "unverified" through verifyBotIdentity — not wrong, not ok', async () => {
    const down = Object.assign(new Error('Command failed'), { code: 1, stderr: 'dial tcp: lookup api.github.com: network is unreachable' })
    const v = await verifyBotIdentity(BOT_TOKEN, ghLoginResolver(runner(down).run))
    expect(v.state).toBe('unverified')
  })
})

describe('workerIdentityRefusal — the gate on the path the worker takes', () => {
  const table = { [BOT_TOKEN]: FLEET_BOT_LOGIN, [CODEOWNER_TOKEN]: CODEOWNER, [OTHER_TOKEN]: 'a-third-account' }

  function facts(over: Partial<WorkerIdentityFacts> & { tmuxToken?: TmuxGlobalEnv }): WorkerIdentityFacts {
    return {
      dispatcherToken: BOT_TOKEN,
      tmuxToken: { kind: 'no-server' },
      resolve: byToken(table).resolve,
      ...over,
    }
  }

  it('ACCEPTS the bot, with no server running yet', async () => {
    expect(await workerIdentityRefusal(facts({}))).toBeUndefined()
  })

  it('ACCEPTS the bot, with a server that carries the same token — resolving it once', async () => {
    const r = byToken(table)
    expect(await workerIdentityRefusal(facts({ tmuxToken: { kind: 'value', value: BOT_TOKEN }, resolve: r.resolve }))).toBeUndefined()
    expect(r.asked).toEqual([BOT_TOKEN])
  })

  it('REFUSES a dispatcher credential that resolves to the codeowner, naming the login', async () => {
    const msg = await workerIdentityRefusal(facts({ dispatcherToken: CODEOWNER_TOKEN }))
    expect(msg).toBeDefined()
    expect(msg).toContain(CODEOWNER)
    expect(msg).toMatch(/refusing to dispatch/)
  })

  it('REFUSES a dispatcher credential that resolves to some other account', async () => {
    expect(await workerIdentityRefusal(facts({ dispatcherToken: OTHER_TOKEN }))).toContain('a-third-account')
  })

  it('REFUSES a credential that cannot be resolved — and says it is unverified, not wrong', async () => {
    const msg = await workerIdentityRefusal(facts({ dispatcherToken: fakeOperatorPat('NotInTheTableAtAll') }))
    expect(msg).toMatch(/NOT verified/)
    expect(msg).not.toMatch(/not the fleet bot/)
  })

  it.each([undefined, ''])('REFUSES when the dispatcher has no explicit GH_TOKEN (%j) — the gh wrapper\'s per-owner map would decide', async (dispatcherToken) => {
    const r = byToken(table)
    const msg = await workerIdentityRefusal(facts({ dispatcherToken, resolve: r.resolve }))
    expect(msg).toMatch(/GH_TOKEN is not set/)
    expect(r.asked).toEqual([])
  })

  it('REFUSES a running tmux server that has no GH_TOKEN even though the dispatcher holds the bot\'s — the worker is built from the SERVER\'s environment', async () => {
    const msg = await workerIdentityRefusal(facts({ tmuxToken: { kind: 'unset' } }))
    expect(msg).toMatch(/tmux server has no GH_TOKEN/)
    expect(msg).toMatch(/tmux set-environment -g GH_TOKEN/)
  })

  it('REFUSES a running tmux server whose GH_TOKEN is the codeowner\'s even though the dispatcher holds the bot\'s', async () => {
    const msg = await workerIdentityRefusal(facts({ tmuxToken: { kind: 'value', value: CODEOWNER_TOKEN } }))
    expect(msg).toContain(CODEOWNER)
    expect(msg).toMatch(/the tmux server/)
  })

  it('ACCEPTS a server holding a DIFFERENT token that is also the bot\'s — identity is what is judged, not string equality', async () => {
    const t = { ...table, [OTHER_TOKEN]: FLEET_BOT_LOGIN }
    expect(await workerIdentityRefusal(facts({
      tmuxToken: { kind: 'value', value: OTHER_TOKEN }, resolve: byToken(t).resolve,
    }))).toBeUndefined()
  })

  it('REFUSES a tmux server whose environment could not be read', async () => {
    const msg = await workerIdentityRefusal(facts({ tmuxToken: { kind: 'unreadable', reason: 'tmux show-environment failed: boom' } }))
    expect(msg).toMatch(/could not be read/)
  })

  it('never prints any part of any credential, on any refusal', async () => {
    const cases: Partial<WorkerIdentityFacts>[] = [
      { dispatcherToken: CODEOWNER_TOKEN },
      { dispatcherToken: OTHER_TOKEN },
      { dispatcherToken: fakeOperatorPat('NotInTheTableAtAll') },
      { tmuxToken: { kind: 'value', value: CODEOWNER_TOKEN } },
      { tmuxToken: { kind: 'unset' } },
    ]
    for (const c of cases) {
      const msg = (await workerIdentityRefusal(facts(c))) ?? ''
      expect(msg).not.toBe('')
      for (const t of [BOT_TOKEN, CODEOWNER_TOKEN, OTHER_TOKEN]) {
        expect(msg).not.toContain(t.slice(4, 24))
      }
    }
  })
})

describe('parseGlobalEnv — tmux show-environment -g', () => {
  const ok = (stdout: string) => parseGlobalEnv('GH_TOKEN', { stdout, stderr: '', failed: false })
  const failed = (stderr: string) => parseGlobalEnv('GH_TOKEN', { stdout: '', stderr, failed: true })

  it('reads a value, including one that contains "="', () => {
    expect(ok('GH_TOKEN=abc=def\n')).toEqual({ kind: 'value', value: 'abc=def' })
  })
  it('a removed variable (-NAME) and a missing line are unset', () => {
    expect(ok('-GH_TOKEN\n')).toEqual({ kind: 'unset' })
    expect(ok('OTHER=1\n')).toEqual({ kind: 'unset' })
  })
  it('does not mistake a longer variable name for the one asked about', () => {
    expect(ok('GH_TOKEN_EXTRA=nope\n')).toEqual({ kind: 'unset' })
  })
  it('"unknown variable" is unset; "no server running" is no-server; anything else is unreadable', () => {
    expect(failed('unknown variable: GH_TOKEN')).toEqual({ kind: 'unset' })
    expect(failed('no server running on /tmp/tmux-1000/default')).toEqual({ kind: 'no-server' })
    expect(failed('error connecting to /tmp/tmux-1000/default (No such file or directory)')).toEqual({ kind: 'no-server' })
    expect(failed('protocol version mismatch').kind).toBe('unreadable')
  })
})

describe('dispatch — the gate runs before anything is launched', () => {
  const lane: Lane = {
    id: 'infra', mode: 'live', cap: 1, engine: 'claude', requireLabel: 'agent-dispatchable', vetoLabels: [],
    scope: { owned: ['orchestrator/'], notOwned: [] },
  }
  const req: DispatchRequest = {
    name: 'identity-gate-test-never-launched',
    item: { id: '2966', title: 't', body: 'b', url: 'u', labels: [] },
    lane, briefPath: '/nonexistent/brief.md', timeoutSec: 1, model: 'sonnet', effort: 'low',
  }

  it('a refusal is a FAILED outcome carrying the message, and nothing is launched', async () => {
    const identityRefusal = vi.fn(async () => `refusing to dispatch: credential resolves to "${CODEOWNER}"`)
    const result = await dispatch(req, { identityRefusal })
    expect(identityRefusal).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('FAILED')
    expect(result.note).toContain(CODEOWNER)
    // No launch means no worktree and no seeded status: nothing identifies a worker.
    expect(result.worktree).toBeUndefined()
    expect(result.branch).toBeUndefined()
  })
})

describe('assert-identity — the worker-side check, run before gh pr create', () => {
  const saved = process.env['GH_TOKEN']
  afterEach(() => {
    if (saved === undefined) delete process.env['GH_TOKEN']
    else process.env['GH_TOKEN'] = saved
    vi.restoreAllMocks()
  })

  function capture() {
    let out = ''
    let err = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out += String(c); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => { err += String(c); return true })
    return { out: () => out, err: () => err }
  }
  const answering = (a: LoginResolution): LoginResolver => async () => a

  it('exit 0 only for the bot', async () => {
    process.env['GH_TOKEN'] = BOT_TOKEN
    const io = capture()
    expect(await runAssertIdentity(answering({ kind: 'login', login: FLEET_BOT_LOGIN }))).toBe(0)
    expect(io.out()).toContain(FLEET_BOT_LOGIN)
  })

  it('exit 1 for the codeowner, naming the login and telling the worker not to open the PR', async () => {
    process.env['GH_TOKEN'] = CODEOWNER_TOKEN
    const io = capture()
    expect(await runAssertIdentity(answering({ kind: 'login', login: CODEOWNER }))).toBe(1)
    expect(io.err()).toContain(CODEOWNER)
    expect(io.err()).toMatch(/do not run `gh pr create`/)
  })

  it('exit 2 when the identity cannot be established — distinct from both 0 and 1', async () => {
    delete process.env['GH_TOKEN']
    const io = capture()
    expect(await runAssertIdentity(answering({ kind: 'unresolved', reason: 'exit 4: not logged in' }))).toBe(2)
    expect(io.err()).toMatch(/NOT verified/)
  })

  it('judges the credential the worker actually has: GH_TOKEN as given, and the ambient account when it is empty', async () => {
    const asked: (string | undefined)[] = []
    const resolve: LoginResolver = async (t) => { asked.push(t); return { kind: 'login', login: FLEET_BOT_LOGIN } }
    capture()
    process.env['GH_TOKEN'] = BOT_TOKEN
    await runAssertIdentity(resolve)
    process.env['GH_TOKEN'] = ''
    await runAssertIdentity(resolve)
    delete process.env['GH_TOKEN']
    await runAssertIdentity(resolve)
    expect(asked).toEqual([BOT_TOKEN, undefined, undefined])
  })

  it('the worker brief tells the worker to run it before gh pr create', () => {
    const lane: Lane = {
      id: 'infra', mode: 'live', cap: 1, engine: 'claude', requireLabel: 'x', vetoLabels: [],
      scope: { owned: ['orchestrator/'], notOwned: [] },
    }
    const text = renderBrief(buildBrief({ id: '1', title: 't', body: 'x'.repeat(300), url: 'u', labels: [] }, lane, 'b'))
    expect(text).toContain('assert-identity')
    expect(text.indexOf('assert-identity')).toBeLessThan(text.indexOf('Output contract'))
  })
})
