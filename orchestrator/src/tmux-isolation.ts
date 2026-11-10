import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Issue #2655 — who owns the tmux server decides how long every worker lives.
 *
 * There is ONE tmux server per user. It is started by whichever `tmux` call
 * finds none running and it lives in THAT caller's cgroup; every later session,
 * from any dispatcher, is just a client of it. So a worker's lifetime was the
 * lifetime of whoever dispatched first. `llamenos-fleet-tick.service` is a
 * oneshot that exits on purpose: when a pass completed cleanly systemd tore its
 * cgroup down and took the server — and six workers, four of them nothing to do
 * with the fleet — with it. A terminal's scope is an owner just as fragile.
 *
 * Two halves, both here:
 *
 *  1. The FIX is at dispatch time: `isolatedLaunch` wraps the launcher in
 *     `orchestrator/bin/llamenos-isolate`, which runs it in its own transient
 *     `llamenos-tmux-*.scope`. A server the launcher starts is born in that
 *     scope and no dispatcher can capture it.
 *  2. The CHECK is `probeTmuxOwnership` + `classifyTmuxOwner`: compare the live
 *     server's cgroup against the dispatcher's own. It needs no process-name
 *     matching — the server's process title is "tmux: server", so a bare
 *     `pgrep -x tmux` finds nothing, and the pid comes from tmux itself
 *     (`display-message -p '#{pid}'`) instead.
 *
 * A live server cannot be repaired: moving a running process between cgroups
 * needs delegation and risks killing the sessions attached to it, which are
 * doing real work. So this module only ever classifies and reports one.
 */

/** The wrapper every dispatch path launches through. Derived from this
 *  module's own location so it resolves in any checkout and any worktree. */
export const ISOLATE_SCRIPT = fileURLToPath(new URL('../bin/llamenos-isolate', import.meta.url))

/** Unit-name prefix `llamenos-isolate` gives its scope. A server whose cgroup
 *  leaf matches is isolated; this is the one place the convention is read. */
export const ISOLATED_SCOPE_RE = /^llamenos-tmux-[\w.-]+\.scope$/

/** The command line that launches `script` in its own scope. */
export function isolatedLaunch(script: string, args: readonly string[]): { file: string; args: string[] } {
  return { file: ISOLATE_SCRIPT, args: [script, ...args] }
}

export type TmuxOwnership =
  /** No server is running: whoever starts one next owns it — which is what the
   *  isolated launch is for. */
  | { kind: 'no-server' }
  /** A server exists but its owner could not be read. Never rendered as "fine". */
  | { kind: 'unreadable'; reason: string }
  /** The server is in a `llamenos-tmux-*.scope` no dispatcher owns. */
  | { kind: 'isolated'; cgroup: string }
  /** The server is in the dispatcher's own cgroup (or beneath it): the dispatcher
   *  exiting kills it, and every worker with it. */
  | { kind: 'shared-with-dispatcher'; cgroup: string }
  /** The server is in somebody else's cgroup — a terminal, another unit — that
   *  can exit from under it. */
  | { kind: 'fragile-owner'; cgroup: string; owner: string; consequence: string }

export interface OwnershipFacts {
  serverRunning: boolean
  /** `/proc/<server pid>/cgroup` path, when it could be read. */
  serverCgroup: string | undefined
  /** The dispatcher's own `/proc/self/cgroup` path. */
  selfCgroup: string | undefined
  /** Why `serverCgroup` is missing while a server is running. */
  unreadableReason?: string
}

const leaf = (cgroup: string): string => cgroup.split('/').filter(Boolean).pop() ?? cgroup

/** What ends the owner, in words an operator can act on. */
function consequenceOf(owner: string): string {
  if (owner.endsWith('.service')) {
    return `it dies when ${owner} stops or its run ends — a oneshot's cgroup is torn down the moment it exits`
  }
  if (/^(vte-spawn|session|tmux-spawn)-/.test(owner) || owner.startsWith('app-')) {
    return `it dies when that terminal/login session (${owner}) closes`
  }
  return `it dies when ${owner} ends`
}

/** Pure: the verdict for one set of facts. */
export function classifyTmuxOwner(f: OwnershipFacts): TmuxOwnership {
  if (!f.serverRunning) return { kind: 'no-server' }
  if (f.serverCgroup === undefined || f.selfCgroup === undefined) {
    return { kind: 'unreadable', reason: f.unreadableReason ?? 'a cgroup could not be read from /proc' }
  }
  const owner = leaf(f.serverCgroup)
  if (ISOLATED_SCOPE_RE.test(owner)) return { kind: 'isolated', cgroup: f.serverCgroup }
  if (f.serverCgroup === f.selfCgroup || f.serverCgroup.startsWith(`${f.selfCgroup}/`)) {
    return { kind: 'shared-with-dispatcher', cgroup: f.serverCgroup }
  }
  return { kind: 'fragile-owner', cgroup: f.serverCgroup, owner, consequence: consequenceOf(owner) }
}

/** cgroup v2 unified path (`0::/…`) of `pid`, or undefined. */
export function readCgroup(pid: number | 'self'): string | undefined {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find((l) => l.startsWith('0::'))
    return line === undefined ? undefined : line.slice(3)
  } catch {
    return undefined
  }
}

export interface ProbeOptions {
  /** An explicit tmux socket (`-S`). Tests use a scratch one. When set, `$TMUX`
   *  is scrubbed: inside a tmux pane `$TMUX` outranks `TMUX_TMPDIR` and `-L`, and
   *  silently points every command at the LIVE server. */
  socket?: string
}

/** Run a tmux command the way a dispatcher would. */
function tmuxEnv(opts: ProbeOptions): NodeJS.ProcessEnv {
  if (opts.socket === undefined) return process.env
  const env = { ...process.env }
  delete env['TMUX']
  return env
}

/**
 * Read the facts from the host. The server's pid is asked of tmux itself — the
 * process title is "tmux: server", so name matching is the wrong tool. A failed
 * `display-message` with the stock "no server running" text is `serverRunning:
 * false`; any other failure is reported as unreadable, never as "no server".
 */
export function probeTmuxOwnership(opts: ProbeOptions = {}): OwnershipFacts {
  const selfCgroup = readCgroup('self')
  const args = [...(opts.socket !== undefined ? ['-S', opts.socket] : []), 'display-message', '-p', '#{pid}']
  let out: string
  try {
    out = execFileSync('tmux', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, env: tmuxEnv(opts),
    })
  } catch (e) {
    const stderr = (e as { stderr?: Buffer | string }).stderr?.toString() ?? ''
    if (/no server running|error connecting to|No such file or directory/i.test(stderr)) {
      return { serverRunning: false, serverCgroup: undefined, selfCgroup }
    }
    return {
      serverRunning: true, serverCgroup: undefined, selfCgroup,
      unreadableReason: `tmux display-message failed: ${stderr.trim() || (e as Error).message}`,
    }
  }
  const pid = Number.parseInt(out.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) {
    return { serverRunning: true, serverCgroup: undefined, selfCgroup, unreadableReason: `tmux reported pid "${out.trim()}"` }
  }
  const serverCgroup = readCgroup(pid)
  return {
    serverRunning: true, serverCgroup, selfCgroup,
    ...(serverCgroup === undefined ? { unreadableReason: `/proc/${pid}/cgroup is unreadable` } : {}),
  }
}

/** The WARN text `doctor` prints, or undefined when there is nothing to say. */
export function ownershipWarning(o: TmuxOwnership): string | undefined {
  switch (o.kind) {
    case 'no-server':
    case 'isolated':
      return undefined
    case 'unreadable':
      return `the tmux server's owner could not be determined (${o.reason}) — every worker is a client of it; compare /proc/<tmux pid>/cgroup by hand`
    case 'shared-with-dispatcher':
      return `the tmux server shares this process's cgroup (${o.cgroup}) — every worker dies when it ends (#2655)`
    case 'fragile-owner':
      return `the tmux server is owned by ${o.owner} (${o.cgroup}), not an isolated llamenos-tmux-*.scope — ${o.consequence}, and every worker with it (#2655). ` +
        'A live server cannot be moved: let the workers finish (or save their work), then end the server so the next dispatch starts one in its own scope'
  }
}

export interface DispatchGuard {
  /** Set ⇒ do NOT launch: the worker would be placed in the dispatcher's own cgroup. */
  refuse?: string
  /** Set ⇒ launch, but this is recorded: the worker is attached to a fragile owner. */
  warn?: string
}

/**
 * The pre-dispatch decision. REFUSE only when the server is in the dispatcher's
 * own cgroup: that is a certainty, not a risk — the isolated launch makes it
 * unreachable, so seeing it means the isolation was removed, and launching would
 * hand a worker to a server that dies with this very process. WARN (launch, but
 * say so, and record it) for a server in a foreign fragile cgroup: refusing there
 * would halt the whole fleet over a hazard only a human can clear, and a halted
 * fleet is itself an outage; the worker is no worse off than it was before.
 */
export function dispatchGuard(o: TmuxOwnership): DispatchGuard {
  if (o.kind === 'shared-with-dispatcher') {
    return {
      refuse: `refusing to dispatch: the tmux server is in this dispatcher's own cgroup (${o.cgroup}), so the ` +
        'worker would die with the dispatcher (#2655). The launcher must run through orchestrator/bin/llamenos-isolate.',
    }
  }
  const warn = ownershipWarning(o)
  return warn === undefined ? {} : { warn }
}
