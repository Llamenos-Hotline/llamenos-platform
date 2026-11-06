import { execFileSync } from 'node:child_process'
import {
  appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  writeFileSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { FLEET_DIR } from './paths.js'
import { checkoutProvenance, type CheckoutProvenance } from './provenance.js'

/**
 * Issues #2515 / #2512 — the fleet's own code has to reach the host without a
 * human, and it has to do so without ever swapping code underneath a run.
 *
 * `llamenos-fleet-runtime` is a plain checkout; `bin/llamenos-fleet` runs the
 * orchestrator out of it. Nothing used to move it, so a merged orchestrator
 * change was dormant until someone remembered to pull (#2502, #2511, #2488).
 * The only mover was `tick`'s own fast-forward, which ran INSIDE a pass: the
 * pass that fast-forwarded kept executing the old code, every other entry
 * point (queue-feed, digest, watchdog, doctor) never moved it at all, and it
 * could swap files under another run that was still in flight.
 *
 * The mover now lives in the wrapper, BEFORE it execs the orchestrator, as
 * this one standalone step — which is why it imports nothing from the rest of
 * the orchestrator but `paths` and `provenance`: a revision whose `cli.ts`
 * cannot even load must still be able to adopt the commit that fixes it.
 *
 * ## Ordering — why no run ever sees a half-swapped tree
 *
 * Every wrapper invocation calls `syncRuntime(root, { registerPid: $$ })`.
 * The wrapper then `exec`s, so `$$` IS the orchestrator's pid, and the
 * registration is a live-run marker for exactly as long as that process
 * lives. Under ONE short lock (`runtime-sync.lock`) the step does:
 *
 *   1. read the registry of live runs (dead pids and recycled pids dropped),
 *   2. fast-forward to `origin/main` ONLY if that registry is empty,
 *   3. register itself.
 *
 * A concurrent starter either registered before step 1 (the updater sees it
 * and defers) or takes the lock after step 3 (and runs the new tree, which is
 * complete because the swap happened while it waited). There is no window in
 * between, and nothing here relies on a run being short. A deferred update is
 * not lost: the next invocation that finds the registry empty performs it, and
 * `doctor` says so loudly in the meantime.
 *
 * ## What it refuses to do
 *
 * - Only `git merge --ff-only origin/main` — the gated tip, never another ref,
 *   never a reset. A diverged checkout therefore cannot be "fixed" into
 *   losing commits.
 * - A DIRTY checkout is never touched: someone may be mid-debug in it, and
 *   losing their work to an automatic update is worse than the dormancy being
 *   fixed. It is reported (fleet log, stderr, the sync record `doctor` reads)
 *   and the run proceeds on the code it has.
 */

/** Why the lock is waited for this long: it is only ever held across a git
 *  fetch + ff, so a holder alive past this is wedged, and the step refuses
 *  (exit 3) rather than racing it. */
const LOCK_WAIT_MS = 120_000
const LOCK_POLL_MS = 100

export type SyncBlockReason =
  | 'dirty' | 'detached' | 'not-on-main' | 'diverged' | 'fetch-failed' | 'unverifiable' | 'not-a-repo'

export type SyncOutcome =
  | { kind: 'current'; commit: string | undefined }
  | { kind: 'updated'; from: string; to: string; behindBy: number }
  /** Clean, on main, behind — and exactly one thing in the way: a run in flight. */
  | { kind: 'deferred-busy'; behindBy: number; livePids: number[] }
  /** A condition no automatic move may resolve; `detail` names it. */
  | { kind: 'blocked'; reason: SyncBlockReason; detail: string; behindBy: number | undefined }
  | { kind: 'lock-timeout'; heldByPid: number }

export interface SyncRecord {
  at: string
  root: string
  outcome: SyncOutcome
}

export interface SyncOptions {
  /** The pid to register as a live run once the update decision is made. */
  registerPid?: number
  /** State dir override (tests); defaults to the real fleet dir. */
  stateDir?: string
  now?: () => Date
  lockWaitMs?: number
  log?: (msg: string) => void
}

// ── liveness ────────────────────────────────────────────────────────────────

/** Field 22 of /proc/<pid>/stat (process start time in clock ticks), parsed
 *  after the last ')' because the command name may itself contain spaces or
 *  parens. `undefined` when the pid does not exist or /proc is unreadable. */
function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) {
    // EPERM = the process exists and is someone else's: alive.
    return e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A live run is a registered pid whose recorded start time still matches — a
 *  bare `kill -0` would treat any recycled pid as a run and defer forever. */
function isLive(pid: number, recordedStart: string): boolean {
  if (!pidAlive(pid)) return false
  const now = processStartTime(pid)
  // No /proc (or unreadable): fall back to bare liveness rather than call a
  // running process dead — a false "dead" is the unsafe direction here.
  return now === undefined || recordedStart === '' || now === recordedStart
}

function runsDir(stateDir: string): string {
  return join(stateDir, 'runs')
}

/** Registers `pid` as a live fleet run. Idempotent; overwrites a stale file
 *  left by a previous holder of the same pid. */
export function registerRun(pid: number, stateDir: string = FLEET_DIR): void {
  mkdirSync(runsDir(stateDir), { recursive: true })
  writeFileSync(join(runsDir(stateDir), String(pid)), processStartTime(pid) ?? '')
}

/** The pids of live registered runs, pruning the files of dead ones. */
export function liveRunPids(stateDir: string = FLEET_DIR, exclude?: number): number[] {
  let names: string[]
  try { names = readdirSync(runsDir(stateDir)) } catch { return [] }
  const live: number[] = []
  for (const name of names) {
    const pid = Number(name)
    if (!Number.isInteger(pid) || pid <= 0) continue
    const file = join(runsDir(stateDir), name)
    let start = ''
    try { start = readFileSync(file, 'utf8').trim() } catch { continue }
    if (pid === exclude) continue
    if (isLive(pid, start)) live.push(pid)
    else rmSync(file, { force: true })
  }
  return live.sort((a, b) => a - b)
}

// ── the update lock ─────────────────────────────────────────────────────────

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readPid(file: string): number {
  try { return Number.parseInt(readFileSync(file, 'utf8').trim(), 10) } catch { return Number.NaN }
}

/** O_EXCL pidfile with a liveness probe — the same discipline as lock.ts, but
 *  WAITING, because contention here is two wrappers starting together, not a
 *  second pass that should simply decline to run. Returns a release function,
 *  or the pid of the live holder it gave up on. */
function acquireSyncLock(stateDir: string, waitMs: number): (() => void) | { heldByPid: number } {
  mkdirSync(stateDir, { recursive: true })
  const file = join(stateDir, 'runtime-sync.lock')
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const fd = openSync(file, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => { if (readPid(file) === process.pid) rmSync(file, { force: true }) }
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'EEXIST')) throw e
    }
    const holder = readPid(file)
    if (!Number.isFinite(holder) || !pidAlive(holder)) {
      // Reap via rename so two reapers cannot each delete the OTHER's fresh lock.
      try { renameSync(file, `${file}.stale.${process.pid}`); rmSync(`${file}.stale.${process.pid}`, { force: true }) } catch { /* lost the race — retry */ }
      continue
    }
    if (Date.now() >= deadline) return { heldByPid: holder }
    sleepSync(LOCK_POLL_MS)
  }
}

// ── the step itself ─────────────────────────────────────────────────────────

function blockReason(p: CheckoutProvenance): { reason: SyncBlockReason; detail: string } | undefined {
  if (!p.isGitRepo) return { reason: 'not-a-repo', detail: 'not a git repository' }
  if (p.unreadable) return { reason: 'unverifiable', detail: 'git state could not be fully read' }
  if (p.dirty) {
    const names = p.dirtyDetail.slice(0, 5).join(', ')
    return { reason: 'dirty', detail: `uncommitted changes left untouched${names ? `: ${names}` : ''}` }
  }
  if (p.branch === undefined) return { reason: 'detached', detail: 'detached HEAD — check out main' }
  if (p.branch !== 'main') return { reason: 'not-on-main', detail: `on branch ${p.branch}, not main` }
  if (!p.fetchOk) return { reason: 'fetch-failed', detail: `could not fetch ${p.upstream}` }
  if (!p.upstreamKnown) return { reason: 'unverifiable', detail: `${p.upstream} ref is absent` }
  return undefined
}

/** One line, stable, greppable — what the fleet log and stderr carry. */
export function describeSyncOutcome(o: SyncOutcome): string {
  switch (o.kind) {
    case 'current': return `runtime current with origin/main (${o.commit?.slice(0, 12) ?? 'unknown'})`
    case 'updated': return `runtime fast-forwarded ${o.from.slice(0, 12)} -> ${o.to.slice(0, 12)} (${o.behindBy} commit(s)); this run executes the new code`
    case 'deferred-busy': return `runtime is ${o.behindBy} commit(s) behind origin/main; update DEFERRED — fleet run(s) in flight (pid ${o.livePids.join(', ')}); the next run that starts idle adopts it`
    case 'blocked': return `runtime update BLOCKED (${o.reason}): ${o.detail}${o.behindBy ? `; ${o.behindBy} commit(s) behind origin/main, merged fixes are NOT running` : ''}`
    case 'lock-timeout': return `runtime update lock held by live pid ${o.heldByPid} past ${LOCK_WAIT_MS / 1000}s — refusing to start rather than race it`
  }
}

/**
 * Brings the runtime checkout to `origin/main` if — and only if — that is
 * safe right now, then registers the caller as a live run. See the module
 * header for the ordering argument; every outcome is returned as data and
 * recorded for `doctor`, nothing is silent.
 */
export function syncRuntime(root: string, opts: SyncOptions = {}): SyncOutcome {
  const stateDir = opts.stateDir ?? FLEET_DIR
  const now = opts.now ?? (() => new Date())
  const lock = acquireSyncLock(stateDir, opts.lockWaitMs ?? LOCK_WAIT_MS)
  if (typeof lock !== 'function') {
    const outcome: SyncOutcome = { kind: 'lock-timeout', heldByPid: lock.heldByPid }
    record(stateDir, root, outcome, now, opts.log)
    return outcome
  }
  try {
    if (opts.registerPid !== undefined) rmSync(join(runsDir(stateDir), String(opts.registerPid)), { force: true })
    const outcome = decide(root, stateDir)
    if (opts.registerPid !== undefined) registerRun(opts.registerPid, stateDir)
    record(stateDir, root, outcome, now, opts.log)
    return outcome
  } finally {
    lock()
  }
}

function decide(root: string, stateDir: string): SyncOutcome {
  const p = checkoutProvenance(root)
  const blocked = blockReason(p)
  if (blocked !== undefined) return { kind: 'blocked', ...blocked, behindBy: p.behindBy }
  const behindBy = p.behindBy ?? 0
  if (behindBy === 0) return { kind: 'current', commit: p.commit }
  // Only reachable for a clean, on-main, verified-behind checkout.
  const live = liveRunPids(stateDir)
  if (live.length > 0) return { kind: 'deferred-busy', behindBy, livePids: live }
  try {
    execFileSync('git', ['-C', root, 'merge', '--ff-only', p.upstream], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    // A failed --ff-only on a clean main means local commits that origin/main
    // lacks. Never reset them away — name it and leave the tree alone.
    const msg = e instanceof Error ? e.message.split('\n')[0] ?? 'merge failed' : 'merge failed'
    return { kind: 'blocked', reason: 'diverged', detail: `git merge --ff-only ${p.upstream} failed: ${msg}`, behindBy }
  }
  const to = checkoutProvenance(root, { fetch: false }).commit ?? '?'
  return { kind: 'updated', from: p.commit ?? '?', to, behindBy }
}

function record(stateDir: string, root: string, outcome: SyncOutcome, now: () => Date, log?: (m: string) => void): void {
  const at = now().toISOString()
  const line = `runtime-sync: ${describeSyncOutcome(outcome)}`
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'runtime-sync.json'), JSON.stringify({ at, root, outcome } satisfies SyncRecord) + '\n')
    appendFileSync(join(stateDir, 'fleet.log'), `${at} ${line}\n`)
  } catch { /* the record is a read aid; stderr below is the primary signal */ }
  // Quiet when nothing happened; loud for everything an operator should see.
  if (outcome.kind !== 'current') (log ?? ((m) => process.stderr.write(`${m}\n`)))(`llamenos-fleet: ${line}`)
}

/** What `doctor` reads. `undefined` = no sync has ever run on this host,
 *  which is itself the finding (the wrapper predates this mechanism). */
export function readSyncRecord(stateDir: string = FLEET_DIR): SyncRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDir, 'runtime-sync.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && 'outcome' in parsed && 'at' in parsed) return parsed as SyncRecord
  } catch { /* absent or unparseable */ }
  return undefined
}

// ── CLI entry (the wrapper runs this before exec'ing the orchestrator) ─────

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (import.meta.main) {
  const root = argValue('--root')
  const pid = Number(argValue('--register'))
  if (root === undefined) {
    process.stderr.write('usage: runtime-sync.ts --root <checkout> [--register <pid>]\n')
    process.exit(2)
  }
  const outcome = syncRuntime(root, Number.isInteger(pid) && pid > 0 ? { registerPid: pid } : {})
  // Exit 3 = the one outcome the wrapper must not run past: a wedged update
  // lock means another process may be mid-swap right now.
  process.exit(outcome.kind === 'lock-timeout' ? 3 : 0)
}
