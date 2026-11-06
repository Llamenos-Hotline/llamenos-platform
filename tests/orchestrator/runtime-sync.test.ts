import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveRunPids, readSyncRecord, registerRun, syncRuntime } from '../../orchestrator/src/runtime-sync.js'

/**
 * Issues #2515 / #2512 — an orchestrator change that reaches origin/main must
 * take effect on the next run with no human step, and must never be swapped
 * underneath a run in progress or over someone's uncommitted work. Every case
 * runs against REAL git repos (a bare "origin", a clone playing the runtime
 * checkout) and real processes for the liveness registry: the failure being
 * fixed was a green check over code that was not running.
 */

const dirs: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL') // our own `sleep` children only
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
const git = (dir: string, args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })

interface Fixture { bare: string; pusher: string; runtime: string; state: string }

function makeFixture(seed?: (pusher: string) => void): Fixture {
  const bare = tmp('rtsync-origin-')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  const pusher = tmp('rtsync-pusher-')
  execFileSync('git', ['clone', '-q', bare, pusher])
  git(pusher, ['config', 'user.email', 't@example.com'])
  git(pusher, ['config', 'user.name', 'T'])
  mkdirSync(join(pusher, 'orchestrator', 'src'), { recursive: true })
  writeFileSync(join(pusher, 'orchestrator', 'src', 'cli.ts'), '// v1\n')
  seed?.(pusher)
  git(pusher, ['add', '.'])
  git(pusher, ['commit', '-q', '-m', 'init'])
  git(pusher, ['push', '-q', 'origin', 'main'])
  const runtime = tmp('rtsync-runtime-')
  execFileSync('git', ['clone', '-q', bare, runtime])
  git(runtime, ['config', 'user.email', 't@example.com'])
  git(runtime, ['config', 'user.name', 'T'])
  return { bare, pusher, runtime, state: tmp('rtsync-state-') }
}

function pushCommit(f: Fixture, file: string, body: string): string {
  writeFileSync(join(f.pusher, file), body)
  git(f.pusher, ['add', '.'])
  git(f.pusher, ['commit', '-q', '-m', `edit ${file}`])
  git(f.pusher, ['push', '-q', 'origin', 'main'])
  return git(f.pusher, ['rev-parse', 'HEAD']).trim()
}
const head = (dir: string): string => git(dir, ['rev-parse', 'HEAD']).trim()

/** A real, long-lived process standing in for another in-flight fleet run. */
function startRun(stateDir: string): ChildProcess {
  const c = spawn('sleep', ['300'], { stdio: 'ignore' })
  children.push(c)
  registerRun(c.pid as number, stateDir)
  return c
}

describe('syncRuntime — adoption', () => {
  it('fast-forwards an idle, clean, behind checkout to origin/main and records it', () => {
    const f = makeFixture()
    const tip = pushCommit(f, 'orchestrator/src/fix.ts', '// fix\n')
    const out = syncRuntime(f.runtime, { stateDir: f.state, registerPid: process.pid, log: () => {} })
    expect(out.kind).toBe('updated')
    expect(head(f.runtime)).toBe(tip)
    expect(readSyncRecord(f.state)?.outcome.kind).toBe('updated')
    expect(readFileSync(join(f.state, 'fleet.log'), 'utf8')).toMatch(/runtime-sync: runtime fast-forwarded/)
  })

  it('is a quiet no-op when already current', () => {
    const f = makeFixture()
    const logs: string[] = []
    const out = syncRuntime(f.runtime, { stateDir: f.state, log: (m) => logs.push(m) })
    expect(out.kind).toBe('current')
    expect(logs).toEqual([])
  })

  it('only ever adopts origin/main — a pushed side branch never moves the checkout', () => {
    const f = makeFixture()
    const before = head(f.runtime)
    git(f.pusher, ['checkout', '-q', '-b', 'feature'])
    pushCommit(f, 'orchestrator/src/wip.ts', '// wip\n')
    git(f.pusher, ['push', '-q', 'origin', 'feature'])
    expect(syncRuntime(f.runtime, { stateDir: f.state, log: () => {} }).kind).toBe('current')
    expect(head(f.runtime)).toBe(before)
  })
})

describe('syncRuntime — never swaps code under a run in progress', () => {
  it('DEFERS while another run is live, names it, leaves HEAD alone; adopts once it exits', async () => {
    const f = makeFixture()
    const tip = pushCommit(f, 'orchestrator/src/fix.ts', '// fix\n')
    const before = head(f.runtime)
    const other = startRun(f.state)

    const deferred = syncRuntime(f.runtime, { stateDir: f.state, registerPid: process.pid, log: () => {} })
    expect(deferred).toMatchObject({ kind: 'deferred-busy', behindBy: 1, livePids: [other.pid] })
    expect(head(f.runtime)).toBe(before)

    other.kill('SIGKILL')
    await new Promise((r) => other.once('exit', r))
    // Our own registration (this process) must not block our own next update.
    const adopted = syncRuntime(f.runtime, { stateDir: f.state, registerPid: process.pid, log: () => {} })
    expect(adopted.kind).toBe('updated')
    expect(head(f.runtime)).toBe(tip)
  })

  it('a registration whose pid was recycled by an unrelated process is not a live run', () => {
    const f = makeFixture()
    pushCommit(f, 'orchestrator/src/fix.ts', '// fix\n')
    const stranger = spawn('sleep', ['300'], { stdio: 'ignore' })
    children.push(stranger)
    // A start time that is not the stranger's: the file is from a dead run whose pid got reused.
    mkdirSync(join(f.state, 'runs'), { recursive: true })
    writeFileSync(join(f.state, 'runs', String(stranger.pid)), '1')
    expect(liveRunPids(f.state)).toEqual([])
    expect(syncRuntime(f.runtime, { stateDir: f.state, log: () => {} }).kind).toBe('updated')
  })

  it('registers the caller so a LATER updater defers behind it', () => {
    const f = makeFixture()
    const a = spawn('sleep', ['300'], { stdio: 'ignore' })
    children.push(a)
    syncRuntime(f.runtime, { stateDir: f.state, registerPid: a.pid as number, log: () => {} })
    pushCommit(f, 'orchestrator/src/fix.ts', '// fix\n')
    expect(syncRuntime(f.runtime, { stateDir: f.state, log: () => {} }).kind).toBe('deferred-busy')
  })

  it('refuses to start (lock-timeout) rather than race a live holder of the update lock', () => {
    const f = makeFixture()
    pushCommit(f, 'orchestrator/src/fix.ts', '// fix\n')
    const before = head(f.runtime)
    const holder = spawn('sleep', ['300'], { stdio: 'ignore' })
    children.push(holder)
    writeFileSync(join(f.state, 'runtime-sync.lock'), String(holder.pid))
    const out = syncRuntime(f.runtime, { stateDir: f.state, lockWaitMs: 300, log: () => {} })
    expect(out).toEqual({ kind: 'lock-timeout', heldByPid: holder.pid })
    expect(head(f.runtime)).toBe(before)
  })

  it('reaps an update lock whose holder is dead', () => {
    const f = makeFixture()
    const dead = spawnSync('true')
    writeFileSync(join(f.state, 'runtime-sync.lock'), String(dead.pid))
    expect(syncRuntime(f.runtime, { stateDir: f.state, log: () => {} }).kind).toBe('current')
  })
})

describe('syncRuntime — never destroys local state', () => {
  it('a DIRTY checkout is left exactly as it was, and the block is recorded and loud', () => {
    const f = makeFixture()
    pushCommit(f, 'orchestrator/src/fix.ts', '// fix\n')
    const before = head(f.runtime)
    const mine = join(f.runtime, 'orchestrator', 'src', 'cli.ts')
    writeFileSync(mine, '// my debugging edit\n')
    writeFileSync(join(f.runtime, 'notes.txt'), 'untracked\n')
    const logs: string[] = []

    const out = syncRuntime(f.runtime, { stateDir: f.state, log: (m) => logs.push(m) })
    expect(out).toMatchObject({ kind: 'blocked', reason: 'dirty', behindBy: 1 })
    expect(head(f.runtime)).toBe(before)
    expect(readFileSync(mine, 'utf8')).toBe('// my debugging edit\n')
    expect(readFileSync(join(f.runtime, 'notes.txt'), 'utf8')).toBe('untracked\n')
    expect(logs.join('\n')).toMatch(/BLOCKED \(dirty\).*cli\.ts.*1 commit\(s\) behind/)
    expect(readSyncRecord(f.state)?.outcome).toMatchObject({ kind: 'blocked', reason: 'dirty' })
  })

  it('a diverged main (local commits origin lacks) is never reset away', () => {
    const f = makeFixture()
    writeFileSync(join(f.runtime, 'local.txt'), 'only here\n')
    git(f.runtime, ['add', '.'])
    git(f.runtime, ['commit', '-q', '-m', 'local only'])
    const mine = head(f.runtime)
    pushCommit(f, 'orchestrator/src/fix.ts', '// fix\n')
    const out = syncRuntime(f.runtime, { stateDir: f.state, log: () => {} })
    expect(out).toMatchObject({ kind: 'blocked', reason: 'diverged' })
    expect(head(f.runtime)).toBe(mine)
  })

  it.each([
    ['a detached HEAD', (f: Fixture) => git(f.runtime, ['checkout', '-q', '--detach']), 'detached'],
    ['a branch other than main', (f: Fixture) => git(f.runtime, ['checkout', '-q', '-b', 'debug']), 'not-on-main'],
  ] as const)('%s is blocked, not moved', (_n, setup, reason) => {
    const f = makeFixture()
    pushCommit(f, 'orchestrator/src/fix.ts', '// fix\n')
    setup(f)
    const before = head(f.runtime)
    expect(syncRuntime(f.runtime, { stateDir: f.state, log: () => {} })).toMatchObject({ kind: 'blocked', reason })
    expect(head(f.runtime)).toBe(before)
  })

  it('an unreachable origin is reported as fetch-failed, never as current', () => {
    const f = makeFixture()
    git(f.runtime, ['remote', 'set-url', 'origin', join(f.bare, 'does-not-exist')])
    expect(syncRuntime(f.runtime, { stateDir: f.state, log: () => {} })).toMatchObject({ kind: 'blocked', reason: 'fetch-failed' })
  })
})

describe('bin/llamenos-fleet — the end-to-end invariant', () => {
  const REPO = process.cwd()

  /** A checkout whose "orchestrator" is the REAL wrapper + the REAL sync step
   *  around a stub cli.ts that prints which revision of itself is running. */
  function wrapperFixture(): Fixture {
    return makeFixture((pusher) => {
      mkdirSync(join(pusher, 'orchestrator', 'bin'), { recursive: true })
      cpSync(join(REPO, 'orchestrator/bin/llamenos-fleet'), join(pusher, 'orchestrator/bin/llamenos-fleet'))
      chmodSync(join(pusher, 'orchestrator/bin/llamenos-fleet'), 0o755)
      for (const f of ['runtime-sync.ts', 'provenance.ts', 'dependency.ts', 'paths.ts']) {
        cpSync(join(REPO, 'orchestrator/src', f), join(pusher, 'orchestrator/src', f))
      }
      writeFileSync(join(pusher, 'orchestrator/src/cli.ts'), 'console.log("running v1")\n')
    })
  }

  const run = (f: Fixture, env: Record<string, string> = {}) => spawnSync(
    join(f.runtime, 'orchestrator/bin/llamenos-fleet'), ['anything'],
    { encoding: 'utf8', env: { ...process.env, HOME: f.state, FLEET_HOME: f.state, ...env } },
  )

  it('a change merged to origin/main is what the NEXT run executes — in that same run', () => {
    const f = wrapperFixture()
    expect(run(f).stdout).toContain('running v1')

    pushCommit(f, 'orchestrator/src/cli.ts', 'console.log("running v2")\n')
    const r = run(f)
    expect(r.stdout).toContain('running v2')
    expect(r.stderr).toMatch(/runtime fast-forwarded/)
  })

  it('a dirty runtime still runs (on what it has) and says it was not updated', () => {
    const f = wrapperFixture()
    pushCommit(f, 'orchestrator/src/cli.ts', 'console.log("running v2")\n')
    writeFileSync(join(f.runtime, 'orchestrator/src/cli.ts'), 'console.log("running local edit")\n')
    const r = run(f)
    expect(r.stdout).toContain('running local edit')
    expect(r.stderr).toMatch(/BLOCKED \(dirty\)/)
  })

  it('does not swap the tree under a run that is still in flight', () => {
    const f = wrapperFixture()
    // paths.ts keeps fleet state in <FLEET_HOME>/.llamenos-fleet.
    const other = startRun(join(f.state, '.llamenos-fleet'))
    pushCommit(f, 'orchestrator/src/cli.ts', 'console.log("running v2")\n')
    const r = run(f)
    expect(r.stdout).toContain('running v1')
    expect(r.stderr).toMatch(new RegExp(`DEFERRED.*pid ${other.pid}`))
  })
})
