import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctor } from '../../orchestrator/src/cli.js'
import { launchWorker } from '../../orchestrator/src/engines.js'
import { DISPATCH_SCRIPT } from '../../orchestrator/src/paths.js'
import {
  ISOLATE_SCRIPT, classifyTmuxOwner, dispatchGuard, isolatedLaunch, ownershipWarning,
  probeTmuxOwnership, readCgroup, type OwnershipFacts, type TmuxOwnership,
} from '../../orchestrator/src/tmux-isolation.js'

/**
 * Issue #2655 — a clean fleet-tick exit killed every other worker on the box.
 *
 * Every tmux call here is aimed at a SCRATCH socket with `-S` and with `$TMUX`
 * scrubbed. Inside a tmux pane `$TMUX` outranks `TMUX_TMPDIR` and `-L`, so a
 * "scratch" server without the scrub is the LIVE server — which is how an earlier
 * draft of this very test killed every worker on the box.
 */

const SERVICE = '/user.slice/user-1000.slice/user@1000.service/app.slice/llamenos-fleet-tick.service'
const TERMINAL = '/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-44f8.scope'
const ISOLATED = '/user.slice/user-1000.slice/user@1000.service/app.slice/llamenos-tmux-1731222000-4242.scope'

const facts = (over: Partial<OwnershipFacts>): OwnershipFacts => ({
  serverRunning: true, serverCgroup: ISOLATED, selfCgroup: SERVICE, ...over,
})

describe('classifyTmuxOwner (server cgroup vs the dispatcher\'s own)', () => {
  it('no server running: whoever starts one next owns it', () => {
    expect(classifyTmuxOwner(facts({ serverRunning: false, serverCgroup: undefined })).kind).toBe('no-server')
  })

  it('a server in a llamenos-tmux-*.scope is isolated from every dispatcher', () => {
    expect(classifyTmuxOwner(facts({})).kind).toBe('isolated')
  })

  it('a server in the dispatcher\'s OWN cgroup is shared-with-dispatcher — the #2655 tick instance', () => {
    expect(classifyTmuxOwner(facts({ serverCgroup: SERVICE, selfCgroup: SERVICE })).kind).toBe('shared-with-dispatcher')
  })

  it('a server in a cgroup BENEATH the dispatcher\'s is shared too — stopping a unit reaps its whole tree', () => {
    expect(classifyTmuxOwner(facts({ serverCgroup: `${SERVICE}/child.scope`, selfCgroup: SERVICE })).kind).toBe('shared-with-dispatcher')
  })

  it('a prefix of the name is not a parent: llamenos-fleet-tick.service2 is not beneath llamenos-fleet-tick.service', () => {
    expect(classifyTmuxOwner(facts({ serverCgroup: `${SERVICE}2`, selfCgroup: SERVICE })).kind).toBe('fragile-owner')
  })

  it('a server in a terminal scope is a fragile owner — the #2655 second instance, which KillMode=process would not have prevented', () => {
    const o = classifyTmuxOwner(facts({ serverCgroup: TERMINAL, selfCgroup: SERVICE }))
    expect(o.kind).toBe('fragile-owner')
    if (o.kind === 'fragile-owner') {
      expect(o.owner).toBe('vte-spawn-44f8.scope')
      expect(o.consequence).toMatch(/terminal\/login session .* closes/)
    }
  })

  it('a server in ANOTHER oneshot unit is a fragile owner that names the unit', () => {
    const o = classifyTmuxOwner(facts({ serverCgroup: SERVICE, selfCgroup: TERMINAL }))
    expect(o.kind).toBe('fragile-owner')
    if (o.kind === 'fragile-owner') expect(o.consequence).toMatch(/llamenos-fleet-tick\.service stops or its run ends/)
  })

  it('a look-alike that is not a llamenos-tmux-*.scope is NOT isolated', () => {
    for (const leaf of ['llamenos-tmux-1.service', 'llamenos-tmux.scope', 'x-llamenos-tmux-1.scope', 'llamenos-tmux-1.scope.d']) {
      expect(classifyTmuxOwner(facts({ serverCgroup: `/a/${leaf}` })).kind).not.toBe('isolated')
    }
  })

  it('an unreadable cgroup is "unreadable", never "no server" and never "fine"', () => {
    const o = classifyTmuxOwner(facts({ serverCgroup: undefined, unreadableReason: 'gone' }))
    expect(o).toEqual({ kind: 'unreadable', reason: 'gone' })
    expect(ownershipWarning(o)).toMatch(/could not be determined/)
  })
})

describe('dispatchGuard (refuse vs warn, and why)', () => {
  const owner = (f: Partial<OwnershipFacts>): TmuxOwnership => classifyTmuxOwner(facts(f))

  it('REFUSES a launch into a server that shares the dispatcher\'s cgroup: the worker dies with the dispatcher, certainly', () => {
    const g = dispatchGuard(owner({ serverCgroup: SERVICE, selfCgroup: SERVICE }))
    expect(g.refuse).toMatch(/would die with the dispatcher/)
    expect(g.refuse).toMatch(/llamenos-isolate/)
  })

  it('only WARNS for a foreign fragile owner: refusing would halt the whole fleet over a hazard only a human can clear', () => {
    const g = dispatchGuard(owner({ serverCgroup: TERMINAL }))
    expect(g.refuse).toBeUndefined()
    expect(g.warn).toMatch(/owned by vte-spawn-44f8\.scope/)
    expect(g.warn).toMatch(/cannot be moved/)
  })

  it.each([
    ['isolated', {}],
    ['no server', { serverRunning: false, serverCgroup: undefined }],
  ])('says nothing for %s', (_n, over) => {
    expect(dispatchGuard(owner(over))).toEqual({})
  })
})

describe('every dispatch path launches through llamenos-isolate (#2655)', () => {
  it('launchWorker hands dispatch-one.sh to the wrapper — never runs it directly in the dispatcher\'s cgroup', async () => {
    const seen: { file: string; args: string[] }[] = []
    await launchWorker(['--model', 'x', 'name', 'brief'], async (file, args) => { seen.push({ file, args }) })
    expect(seen).toEqual([{ file: ISOLATE_SCRIPT, args: [DISPATCH_SCRIPT, '--model', 'x', 'name', 'brief'] }])
  })

  it('isolatedLaunch keeps the launcher\'s argv intact — the session name (tmux attach -t <name>) and status protocol ride on it', () => {
    expect(isolatedLaunch('/s/dispatch-one.sh', ['a b', '--branch', 'fleet/x/1'])).toEqual({
      file: ISOLATE_SCRIPT, args: ['/s/dispatch-one.sh', 'a b', '--branch', 'fleet/x/1'],
    })
  })

  it('engines.ts has no direct execFile of DISPATCH_SCRIPT left (a source guard for the path a unit test cannot run: a 90-minute poll loop)', () => {
    const src = readFileSync(join(process.cwd(), 'orchestrator/src/engines.ts'), 'utf8')
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    const direct = code.filter((l) => /execFile(Async|Sync)?\(\s*DISPATCH_SCRIPT/.test(l))
    expect(direct).toEqual([])
  })

  it('the watchdog\'s repair dispatch goes through the wrapper too', () => {
    const src = readFileSync(join(process.cwd(), 'orchestrator/bin/llamenos-fleet-watchdog'), 'utf8')
    expect(src).toMatch(/"\$ISOLATE" "\$DISPATCH"/)
    expect(src.split('\n').filter((l) => /^\s*if "\$DISPATCH"/.test(l))).toEqual([])
  })
})

// ── the wrapper itself ──────────────────────────────────────────────────────

const scratch: string[] = []
afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d }
const stub = (dir: string, name: string, body: string): void => { writeFileSync(join(dir, name), body); chmodSync(join(dir, name), 0o755) }

describe('bin/llamenos-isolate', () => {
  it('runs the command in a transient --user --scope named llamenos-tmux-*, with argv untouched', () => {
    const bin = tmp('iso-bin-')
    const log = join(bin, 'log')
    stub(bin, 'systemd-run', `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`)
    const r = spawnSync('/usr/bin/bash', [ISOLATE_SCRIPT, '/x/dispatch-one.sh', 'my worker', '--flag'], {
      env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    const argv = readFileSync(log, 'utf8').trimEnd().split('\n')
    expect(argv.slice(0, 2)).toEqual(['--user', '--scope'])
    expect(argv.find((a) => a.startsWith('--unit='))).toMatch(/^--unit=llamenos-tmux-\d+-\d+$/)
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['/x/dispatch-one.sh', 'my worker', '--flag'])
  })

  it('runs the command as-is where there is no systemd-run at all (CI container, macOS)', () => {
    const empty = tmp('iso-empty-')
    const r = spawnSync('/usr/bin/bash', [ISOLATE_SCRIPT, '/usr/bin/printf', 'ran:%s', 'direct'], { env: { PATH: empty }, encoding: 'utf8' })
    expect(r.stdout).toBe('ran:direct')
  })

  it('FAILS LOUDLY when systemd-run exists but cannot make the scope — never an un-isolated launch', () => {
    const bin = tmp('iso-bin-')
    stub(bin, 'systemd-run', '#!/bin/sh\necho "Failed to connect to bus" >&2\nexit 1\n')
    const marker = join(bin, 'ran')
    const r = spawnSync('/usr/bin/bash', [ISOLATE_SCRIPT, '/usr/bin/touch', marker], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/Failed to connect to bus/)
    expect(() => readFileSync(marker)).toThrow()
  })

  it('requires a command', () => {
    expect(spawnSync('/usr/bin/bash', [ISOLATE_SCRIPT], { encoding: 'utf8' }).status).toBe(2)
  })
})

// ── the real thing: which cgroup does the tmux server land in? ──────────────

const systemdUserAvailable = ((): boolean => {
  try {
    execFileSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], { stdio: 'ignore', timeout: 10_000 })
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return readCgroup('self') !== undefined
  } catch { return false }
})()

/** Scrubbed of $TMUX — see the file header. */
const scrubbedEnv = (): NodeJS.ProcessEnv => { const e = { ...process.env }; delete e['TMUX']; return e }

/** A fake dispatch-one.sh: starts a detached tmux session on the scratch socket and returns. */
function fakeDispatchScript(dir: string, socket: string): string {
  const path = join(dir, 'dispatch-one.sh')
  writeFileSync(path, `#!/usr/bin/env bash\nexec tmux -S "${socket}" new-session -d -s w1 'sleep 120'\n`)
  chmodSync(path, 0o755)
  return path
}

describe.skipIf(!systemdUserAvailable)('a dispatch cannot place the tmux server in the dispatcher\'s cgroup (real systemd, scratch tmux socket)', () => {
  const stopServer = (socket: string): void => {
    spawnSync('tmux', ['-S', socket, 'kill-server'], { env: scrubbedEnv(), stdio: 'ignore' })
  }

  it('CONTROL: launching the script directly puts the server in OUR cgroup — the bug this suite exists to catch', () => {
    const dir = tmp('iso-ctl-')
    const socket = join(dir, 'sock')
    try {
      execFileSync(fakeDispatchScript(dir, socket), [], { env: scrubbedEnv(), timeout: 30_000 })
      const o = classifyTmuxOwner(probeTmuxOwnership({ socket }))
      expect(o.kind).toBe('shared-with-dispatcher')
      expect(dispatchGuard(o).refuse).toBeDefined()
    } finally { stopServer(socket) }
  })

  it('launching through isolatedLaunch (what dispatch() runs) puts the server in its own llamenos-tmux-*.scope', () => {
    const dir = tmp('iso-fix-')
    const socket = join(dir, 'sock')
    try {
      const cmd = isolatedLaunch(fakeDispatchScript(dir, socket), [])
      execFileSync(cmd.file, cmd.args, { env: scrubbedEnv(), timeout: 30_000 })
      const f = probeTmuxOwnership({ socket })
      const o = classifyTmuxOwner(f)
      expect(o.kind).toBe('isolated')
      expect(f.serverCgroup).not.toBe(f.selfCgroup)
      expect(f.serverCgroup).toMatch(/\/llamenos-tmux-\d+-\d+\.scope$/)
      // The session is addressed exactly as before.
      const sessions = execFileSync('tmux', ['-S', socket, 'list-sessions', '-F', '#{session_name}'], { env: scrubbedEnv(), encoding: 'utf8' })
      expect(sessions.trim()).toBe('w1')
      expect(dispatchGuard(o)).toEqual({})
    } finally { stopServer(socket) }
  })

  it('the scope outlives the dispatcher: the server is still up after the launching process has exited', () => {
    const dir = tmp('iso-live-')
    const socket = join(dir, 'sock')
    try {
      const cmd = isolatedLaunch(fakeDispatchScript(dir, socket), [])
      execFileSync(cmd.file, cmd.args, { env: scrubbedEnv(), timeout: 30_000 })
      // The wrapper exec'd into systemd-run and then the script: all gone by now.
      expect(probeTmuxOwnership({ socket }).serverRunning).toBe(true)
    } finally { stopServer(socket) }
  })

  it('no server on a socket nobody started is "no-server", not an error', () => {
    const dir = tmp('iso-none-')
    expect(probeTmuxOwnership({ socket: join(dir, 'sock') }).serverRunning).toBe(false)
  })
})

// ── doctor ──────────────────────────────────────────────────────────────────

async function runDoctor(tmuxOwnership: () => TmuxOwnership): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { lines.push(String(c)); return true })
  try {
    await doctor({ tmuxOwnership, probe: () => undefined })
    return lines.join('')
  } finally { spy.mockRestore() }
}

describe('doctor — tmux ownership is visible', () => {
  it('WARNs (never FAILs) when the server is owned by a fragile cgroup, naming the owner and the consequence', async () => {
    const out = await runDoctor(() => classifyTmuxOwner(facts({ serverCgroup: SERVICE, selfCgroup: TERMINAL })))
    expect(out).toMatch(/WARN\s+the tmux server is owned by llamenos-fleet-tick\.service/)
    expect(out).toMatch(/oneshot's cgroup is torn down the moment it exits/)
    expect(out).not.toMatch(/FAIL\s+.*tmux/i)
  }, 60_000)

  it('is silent for an isolated server (negative control)', async () => {
    const out = await runDoctor(() => classifyTmuxOwner(facts({})))
    expect(out).not.toMatch(/tmux server/)
  }, 60_000)

  it('is silent when no server is running (negative control)', async () => {
    const out = await runDoctor(() => ({ kind: 'no-server' }))
    expect(out).not.toMatch(/tmux server/)
  }, 60_000)
})
