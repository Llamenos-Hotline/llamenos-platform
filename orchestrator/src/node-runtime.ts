import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * The `node` the test runner runs on (#2889).
 *
 * `node_modules/.bin/vitest` is a `#!/usr/bin/env node` script, so the Node that
 * runs it is whatever `PATH` finds first. The fleet's systemd units run with
 * `PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin`, which holds no
 * version manager, so `node` there is the distro's `/usr/bin/node` (18.x) while
 * an operator's shell resolves a current one through volta. vitest 4 does not
 * start on Node 18 — rolldown imports `styleText` from `node:util` — and dies
 * at module instantiation, before it writes a result. That is what the gate
 * recorded as `tests=orchestrator:crash` on every PR that routed the
 * orchestrator suite: a property of the host's `PATH`, not of the commit.
 *
 * So the gate picks its Node deliberately, against the range the trusted
 * vitest itself declares in `engines.node`, and when none exists says so by
 * name instead of letting the runner die with a stack trace.
 */

/** One `[major, minor, patch]`. */
type Triple = readonly [number, number, number]

function parseTriple(text: string): Triple | undefined {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+].*)?$/i.exec(text.trim())
  if (m === null) return undefined
  const num = (s: string | undefined): number => (s === undefined || s === 'x' || s === '*' ? 0 : Number(s))
  return [Number(m[1]), num(m[2]), num(m[3])]
}

function cmp(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number)
    if (d !== 0) return d
  }
  return 0
}

/** One comparator (`^20.0.0`, `>=24`, `<25.1.0`, `22.3.0`) against a version.
 *  `undefined` when the comparator is a form this evaluator does not know. */
function satisfiesComparator(version: Triple, comparator: string): boolean | undefined {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(comparator.trim())
  if (m === null) return undefined
  const bound = parseTriple(m[2] as string)
  if (bound === undefined) return undefined
  switch (m[1]) {
    case '^': {
      // ^M.m.p := >=M.m.p <(M+1).0.0 ; for M=0 the caret pins the minor.
      const upper: Triple = bound[0] > 0 ? [bound[0] + 1, 0, 0] : bound[1] > 0 ? [0, bound[1] + 1, 0] : [0, 0, bound[2] + 1]
      return cmp(version, bound) >= 0 && cmp(version, upper) < 0
    }
    case '~': return cmp(version, bound) >= 0 && cmp(version, [bound[0], bound[1] + 1, 0]) < 0
    case '>=': return cmp(version, bound) >= 0
    case '<=': return cmp(version, bound) <= 0
    case '>': return cmp(version, bound) > 0
    case '<': return cmp(version, bound) < 0
    default: return cmp(version, bound) === 0
  }
}

/**
 * Whether `version` satisfies a package.json `engines.node` range, for the
 * forms those ranges use (`||`-joined sets of space-joined comparators with
 * `^ ~ >= > <= < =`). `undefined` — never `false` — when the range contains
 * anything this evaluator does not understand: "I cannot tell" must not be
 * reported as "this Node is too old", and the caller treats it as unknown.
 */
export function nodeSatisfies(version: string, range: string): boolean | undefined {
  const v = parseTriple(version)
  if (v === undefined) return undefined
  let unknown = false
  for (const alternative of range.split('||')) {
    const parts = alternative.trim().split(/\s+/).filter((p) => p.length > 0)
    if (parts.length === 0) { unknown = true; continue }
    // A bare operator followed by its operand (`>= 20`) is one comparator.
    const comparators: string[] = []
    for (const p of parts) {
      if (/^(\^|~|>=|<=|>|<|=)$/.test(p)) comparators.push(p)
      else if (comparators.length > 0 && /^(\^|~|>=|<=|>|<|=)$/.test(comparators[comparators.length - 1] as string)) {
        comparators[comparators.length - 1] += p
      } else comparators.push(p)
    }
    let all = true
    for (const c of comparators) {
      const r = satisfiesComparator(v, c)
      if (r === undefined) { unknown = true; all = false; break }
      if (!r) all = false
    }
    if (all) return true
  }
  return unknown ? undefined : false
}

/** The `engines.node` range the trusted vitest declares, or `undefined` when
 *  there is none to read (no install, or a package without `engines`). */
export async function vitestNodeRange(worktree: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(resolvePath(worktree), 'node_modules', 'vitest', 'package.json'), 'utf8')
    const node = (JSON.parse(text) as { engines?: { node?: unknown } }).engines?.node
    return typeof node === 'string' && node.trim().length > 0 ? node : undefined
  } catch {
    return undefined
  }
}

/** Every `node` this process could run the suite on, best first: the ones
 *  `PATH` offers, then the version managers an operator's own shell uses and
 *  a systemd unit's `PATH` leaves out. `homedir()` is the process's real home
 *  — never `env.HOME`, which the scrubbed test environment points at a
 *  throwaway directory. */
export async function candidateNodeBinaries(env: NodeJS.ProcessEnv, home = homedir()): Promise<string[]> {
  const out: string[] = []
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir.length > 0) out.push(join(dir, 'node'))
  }
  out.push(join(env['VOLTA_HOME'] ?? join(home, '.volta'), 'bin', 'node'))
  out.push(join(home, '.local', 'share', 'mise', 'shims', 'node'))
  const nvmRoot = join(home, '.nvm', 'versions', 'node')
  const installed = await readdir(nvmRoot).catch(() => [] as string[])
  const byVersion = installed
    .map((name) => ({ name, v: parseTriple(name) }))
    .filter((e): e is { name: string; v: Triple } => e.v !== undefined)
    .sort((a, b) => cmp(b.v, a.v))
  for (const e of byVersion) out.push(join(nvmRoot, e.name, 'bin', 'node'))
  return [...new Set(out)]
}

/** What one `node` binary reports about itself. `execPath` is the REAL
 *  executable: a version manager's `node` is a shim, and its directory also
 *  holds shims for every other tool it manages (`~/.volta/bin/bun` hangs
 *  rather than running the real bun), so only the real binary's own directory
 *  is ever put on the runner's `PATH`. */
export interface NodeIdentity { version: string; execPath: string }

async function probeNode(bin: string): Promise<NodeIdentity | undefined> {
  try {
    // HOME/VOLTA_HOME: a version manager's shim finds its toolchain through
    // them. Nothing else of the caller's environment is handed to a probe.
    const probeEnv: NodeJS.ProcessEnv = { PATH: dirname(bin), HOME: homedir() }
    if (process.env['VOLTA_HOME'] !== undefined) probeEnv['VOLTA_HOME'] = process.env['VOLTA_HOME']
    const { stdout } = await execFileAsync(bin, ['-p', 'process.version + "\\n" + process.execPath'], { timeout: 15_000, env: probeEnv })
    const [version, execPath] = stdout.trim().split('\n')
    if (version === undefined || execPath === undefined || parseTriple(version) === undefined || execPath.length === 0) return undefined
    return { version, execPath }
  } catch {
    return undefined
  }
}

export type NodeResolution =
  | { ok: true; /** The real node's own directory, to put FIRST on the runner's `PATH`; `undefined` when no range could be checked. */ binDir: string | undefined; version?: string }
  | { ok: false; reason: string }

export interface NodeResolutionDeps {
  candidates?: (env: NodeJS.ProcessEnv) => Promise<string[]>
  probe?: (bin: string) => Promise<NodeIdentity | undefined>
}

/**
 * Picks the Node the test runner will run on, or says why there is none.
 *
 * - No readable `engines.node` (no install, no field, a range this module does
 *   not understand): nothing to check against, so `ok` with `binDir:
 *   undefined` and the runner behaves exactly as before. The check exists to
 *   name a known-bad Node, not to invent a new way to refuse.
 * - A candidate that satisfies the range: `ok`, and its directory goes first
 *   on the runner's `PATH` so both the `env node` shebang and any test that
 *   spawns `node` get it.
 * - Candidates were found, none satisfies: `ok: false`, naming the range and
 *   what was found. A refusal the job log can read, not a crash dump.
 */
export async function resolveVitestNode(
  worktree: string, env: NodeJS.ProcessEnv, deps: NodeResolutionDeps = {},
): Promise<NodeResolution> {
  const range = await vitestNodeRange(worktree)
  if (range === undefined) return { ok: true, binDir: undefined }

  const probe = deps.probe ?? probeNode
  const found: string[] = []
  for (const bin of await (deps.candidates ?? candidateNodeBinaries)(env)) {
    const identity = await probe(bin)
    if (identity === undefined) continue
    const fits = nodeSatisfies(identity.version, range)
    if (fits === undefined) return { ok: true, binDir: undefined }
    if (fits) return { ok: true, binDir: dirname(identity.execPath), version: identity.version }
    found.push(`${identity.version} (${bin})`)
  }
  return {
    ok: false,
    reason: `no Node satisfying vitest's engines.node "${range}" is available to the fleet — ` +
      `${found.length === 0 ? 'no node binary was found' : `found only ${found.join(', ')}`}. ` +
      'This is the host\'s PATH, not a verdict on the commit: install a current Node where the fleet ' +
      'units can find it (volta/mise/nvm under the fleet user\'s home, or on the unit\'s PATH).',
  }
}

/** `env` with `binDir` first on `PATH`. */
export function withNodeOnPath(env: NodeJS.ProcessEnv, binDir: string | undefined): NodeJS.ProcessEnv {
  if (binDir === undefined) return env
  const current = env['PATH']
  return { ...env, PATH: current === undefined || current === '' ? binDir : `${binDir}${delimiter}${current}` }
}
