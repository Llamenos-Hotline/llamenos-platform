import { execFile } from 'node:child_process'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'
import { gh } from './gh.js'
import type { Outcome } from './ledger.js'
import { NEEDS_HUMAN_LABEL } from './roles/planner.js'

const execFileAsync = promisify(execFile)

async function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: opts.timeout ?? 30_000,
      cwd: opts.cwd,
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    throw new Error(`${cmd} ${args.join(' ')} failed: ${err.stderr ?? err.stdout ?? String(e)}`)
  }
}

/**
 * Stops the tmux session `dispatch-one.sh` started for this worker, by name.
 * A session that has already ended — the common case, since the worker's own
 * launcher footer already tore it down on a terminal status — makes
 * `tmux kill-session` exit non-zero; that is "nothing to stop", not a
 * failure, so it is swallowed rather than propagated.
 */
export async function stopSession(name: string): Promise<void> {
  try {
    await execFileAsync('tmux', ['kill-session', '-t', name], { timeout: 10_000 })
  } catch {
    // No such session — already stopped.
  }
}

/**
 * Kills any process whose invocation still mentions the worktree path.
 * Argv-only via `execFile`, matching every other subprocess call in this
 * fleet — never a shell — so a worktree path is never interpreted as
 * anything but a literal argument. `pkill` exiting 1 (no match) is the
 * common case and is not an error.
 */
export async function killWorktreeProcesses(worktree: string): Promise<void> {
  try {
    await execFileAsync('pkill', ['-f', worktree], { timeout: 10_000 })
  } catch {
    // No matching process — nothing to kill.
  }
}

export interface SalvageResult {
  salvaged: boolean
  branch?: string
  /**
   * Issue #1755: set (and > 0) when the tree's ONLY changes were
   * ignored-but-staged artifacts (e.g. a `.test-encrypted-seed.sqlite` that
   * dispatch-one.sh's seed cache copied in and something force-added).
   * Those are unstaged in place — never salvaged, never committed — and the
   * tree is then reported as having had no work, exactly like a clean tree.
   * Absent entirely when the tree was clean, so `salvaged: false` keeps
   * meaning "nothing happened" bit-for-bit.
   */
  clearedArtifacts?: number
}

export interface WorktreeChanges {
  /** Porcelain entries whose path is NOT matched by any ignore rule — real
   *  work that must be preserved. */
  real: string[]
  /** Porcelain entries whose path IS matched by an ignore rule, even though
   *  it sits in the index (`.gitignore` does not apply to a path already
   *  staged — issue #1755's wedge). Worthless by definition: the repo has
   *  already declared the path disposable. */
  artifacts: string[]
}

/**
 * Parses `git status --porcelain -z --no-renames` output into raw paths.
 * `-z` terminates each entry with NUL and disables the `old -> new` rename
 * quoting; `--no-renames` additionally splits a rename into its delete and
 * add halves, so each entry is exactly `XY <path>\0` and no second path ever
 * follows. Entries shorter than the 2-char status + space prefix (a
 * truncated write) are skipped rather than misparsed.
 */
export function parsePorcelainPaths(z: string): string[] {
  const out: string[] = []
  for (const entry of z.split('\0')) {
    if (entry.length < 4) continue
    out.push(entry.slice(3))
  }
  return out
}

/**
 * The set of `paths` that match the repo's own ignore rules, asked of
 * `git check-ignore --no-index`. `--no-index` is the whole point: plain
 * `check-ignore` consults the index and reports NOTHING for a path that is
 * already staged — exactly the state issue #1755 wedges on — while
 * `--no-index` evaluates the ignore rules alone, so a staged
 * `.test-encrypted-seed.sqlite` still classifies as the artifact the
 * gitignore says it is.
 */
export async function ignoredPathsAmong(worktree: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  // `check-ignore` exits 1 when NO path matched — a rejection the promisified
  // execFile surfaces with the (empty) stdout still attached — and 0 when any
  // matched. Any other failure (128: not a repo) is treated as "unclassifiable"
  // → nothing is ignored: fail-safe toward preserving, never toward discarding.
  const proc = execFileAsync('git', ['-C', worktree, 'check-ignore', '--no-index', '-z', '--stdin'], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  ;(proc as unknown as { child?: { stdin?: { end(s: string): void } } }).child?.stdin?.end(paths.join('\0') + '\0')
  let out: string
  try {
    out = (await proc).stdout
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? ''
  }
  return new Set(out.split('\0').filter((p) => p.length > 0))
}

/**
 * Splits a worktree's uncommitted changes into real work vs known-worthless
 * artifacts. The rule — not a hardcoded list that would rot — is "ignored by
 * the repo's own .gitignore, even if staged": a path the repository declares
 * disposable cannot be work worth salvaging, and everything else is.
 */
export async function classifyWorktreeChanges(worktree: string): Promise<WorktreeChanges> {
  const status = await run('git', ['-C', worktree, 'status', '--porcelain', '-z', '--no-renames'])
  const paths = parsePorcelainPaths(status)
  if (paths.length === 0) return { real: [], artifacts: [] }
  const ignored = await ignoredPathsAmong(worktree, paths)
  const real: string[] = []
  const artifacts: string[] = []
  for (const p of paths) {
    if (ignored.has(p)) artifacts.push(p)
    else real.push(p)
  }
  return { real, artifacts }
}

/**
 * Unstages the given paths (`git restore --staged`), leaving the files
 * themselves on disk. For a staged-and-ignored artifact this returns the
 * tree to genuinely clean — the file goes back to untracked-and-ignored,
 * which no porcelain-based check reports at all. Best-effort by contract of
 * its only callers: a failed unstage must never masquerade as "no work".
 */
async function unstageArtifacts(worktree: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await run('git', ['-C', worktree, 'restore', '--staged', '--', ...paths])
}

/**
 * Commits and pushes any uncommitted work in `worktree` to a fresh, clearly
 * named branch — BEFORE the worktree is destroyed. This is the fix for the
 * loss the spec calls out by name: a worker killed mid-flight (a timeout, a
 * crash, an operator's `halt`) can leave correct, uncommitted work sitting in
 * its worktree, and destroying that worktree without salvaging it first
 * throws the work away even though it was right. A worktree with nothing
 * uncommitted salvages nothing and reports `salvaged: false` — there was
 * nothing to preserve, not a failure to preserve it.
 *
 * Issue #1755: "nothing uncommitted" is judged by `classifyWorktreeChanges`,
 * not by a bare dirty-tree check. A worktree whose ONLY changes are
 * gitignored-but-staged artifacts (32 of 39 salvage branches on the dispatch
 * host held exactly one `.test-encrypted-seed.sqlite` and nothing else) has
 * no work: the artifacts are unstaged in place, nothing is committed, no
 * `salvage/*` branch is created, and the worktree is left on its original
 * branch so the next dispatch is not wedged on a branch mismatch. When real
 * work DOES exist, the artifacts are still unstaged first, so the salvage
 * commit carries the work and not a 1.3 GB test seed. The guard against
 * losing work is unchanged: one genuinely modified source file still
 * triggers a full commit+push salvage.
 */
export async function salvageUncommittedWork(worktree: string, branchHint: string): Promise<SalvageResult> {
  const { real, artifacts } = await classifyWorktreeChanges(worktree)
  if (real.length === 0 && artifacts.length === 0) return { salvaged: false }

  if (real.length === 0) {
    await unstageArtifacts(worktree, artifacts)
    return { salvaged: false, clearedArtifacts: artifacts.length }
  }

  if (artifacts.length > 0) {
    await unstageArtifacts(worktree, artifacts)
  }

  const salvageBranch = `salvage/${branchHint}-${Date.now()}`
  await run('git', ['-C', worktree, 'checkout', '-b', salvageBranch])
  await run('git', ['-C', worktree, 'add', '-A'])
  await run('git', ['-C', worktree, 'commit', '-m', `salvage: uncommitted work from ${branchHint}`])
  await run('git', ['-C', worktree, 'push', '-u', 'origin', salvageBranch])
  return { salvaged: true, branch: salvageBranch }
}

/**
 * `--force` because a worktree that just had work salvaged onto a new branch
 * checked out inside it is, from the main repo's point of view, exactly as
 * "dirty" as `--force` exists to push through — the salvage step above is
 * what makes discarding that state safe.
 *
 * Resolves the repository's shared `.git` directory first (`rev-parse
 * --git-common-dir`, run from inside the worktree itself) and passes it via
 * `--git-dir`, rather than relying on the caller's own working directory
 * being somewhere inside the repo. `tick`'s `SettleInput` carries only the
 * worktree path, not a separate handle on the main checkout — this makes
 * that unnecessary.
 */
export async function destroyWorktree(worktree: string): Promise<void> {
  const commonDirRaw = (await run('git', ['-C', worktree, 'rev-parse', '--git-common-dir'])).trim()
  const gitDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolvePath(worktree, commonDirRaw)
  await run('git', ['--git-dir', gitDir, 'worktree', 'remove', '--force', worktree])
}

export async function labelIssue(itemId: string, label: string): Promise<void> {
  await gh(['issue', 'edit', itemId, '--add-label', label])
}

/**
 * Finds the worktree checked out on `branch`, if one still exists, by asking
 * `repoRoot`'s own git — not by reconstructing dispatch-one.sh's worktree
 * naming convention (`~/projects/<repo>-<name>`). That convention lives in a
 * dependency this repo does not own (see paths.ts's `DISPATCH_SCRIPT`
 * comment) and can change there with no llamenos commit at all; asking git
 * directly is the only source of truth that cannot drift out from under
 * `revert`.
 *
 * `git worktree list --porcelain` emits one blank-line-separated block per
 * worktree, each a `worktree <path>` line followed by either `branch
 * refs/heads/<name>` or `detached` (or `bare` for the main worktree with no
 * checkout). Only a `branch` line is ever matched against.
 */
export async function findWorktreeForBranch(repoRoot: string, branch: string): Promise<string | undefined> {
  const out = await run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'])
  let current: string | undefined
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ') && current !== undefined) {
      if (line.slice('branch '.length).trim() === `refs/heads/${branch}`) return current
    } else if (line.trim().length === 0) {
      current = undefined
    }
  }
  return undefined
}

/**
 * The branch `worktree` actually has checked out, asked of that worktree's
 * own git — `undefined` when it cannot be read (the path is gone, or is not
 * a worktree). A detached HEAD reads as the literal `HEAD`, which is never a
 * fleet branch and so is reported as a mismatch by the caller, not hidden.
 */
export async function currentBranch(worktree: string): Promise<string | undefined> {
  try {
    const out = (await run('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return out.length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * Deletes a local branch by name, swallowing "no such branch" the same way
 * `stopSession` swallows "no such session" — the common caller (`revert`)
 * may run this after `gh pr close --delete-branch` already removed it, or
 * against a run that never got far enough to push a branch at all.
 */
export async function deleteLocalBranch(repoRoot: string, branch: string): Promise<void> {
  try {
    await run('git', ['-C', repoRoot, 'branch', '-D', branch])
  } catch {
    // Already gone, or never existed.
  }
}

export interface SettleTarget {
  name: string
  itemId: string
  outcome: Outcome
  worktree?: string
  branch?: string
  /**
   * The one control-label write settle() still performs: adds `needs-human`
   * when the fleet is leaving an open PR for a person rather than something
   * it will retry itself — see `SettleInput`'s own doc comment in tick.ts for
   * exactly which two cases set this. `judge()` (select.ts) already vetoes
   * any item carrying `needs-human`, so this is what keeps a handed-off item
   * from being re-claimed on the next pass — not a record of what happened
   * (that is derived on read; see ledger.ts's module comment), but an
   * instruction to the fleet's own future self.
   */
  needsHuman?: boolean
}

/**
 * The single teardown path for a dispatched item, whatever happened to it.
 * Order is the safety property:
 *
 * 1. Stop the session and kill any surviving process FIRST — nothing should
 *    still be writing into the worktree while it is being salvaged.
 * 2. Salvage. If salvage itself fails, the worktree is deliberately left
 *    standing rather than destroyed: "salvage before teardown" only holds if
 *    a failed salvage also cancels the teardown, not just runs before it and
 *    gets ignored.
 * 3. Destroy — reached only when salvage succeeded or had nothing to do.
 * 4. Add `needs-human`, if the caller says this outcome is one (see
 *    `SettleTarget.needsHuman`'s own comment). This is the ONLY label
 *    `settle()` writes — see ledger.ts's module comment on why an outcome
 *    label (`fleet:merged`, `fleet:rejected`, ...) is never written here at
 *    all: whether a PR merged is a fact about GitHub's state, derived on
 *    read (`llamenos-fleet status <issue>`), never cached as a label that
 *    can drift from what actually happened to the PR.
 *
 * Each step's own failure is logged and does not stop the ones after it
 * (except salvage -> destroy, per above): a labelling failure must not skip
 * destroying an already-salvaged worktree, since skipping that is exactly
 * how a worktree leaks.
 */
export async function settle(target: SettleTarget, log: (msg: string) => void): Promise<void> {
  await stopSession(target.name)

  if (target.worktree !== undefined) {
    await killWorktreeProcesses(target.worktree)

    let safeToDestroy = true
    try {
      const result = await salvageUncommittedWork(target.worktree, target.branch ?? target.name)
      if (result.salvaged) log(`salvaged uncommitted work for issue ${target.itemId} to ${result.branch}`)
    } catch (e) {
      safeToDestroy = false
      log(`salvage failed for issue ${target.itemId} — refusing to destroy the worktree: ${errMsg(e)}`)
    }

    if (safeToDestroy) {
      try {
        await destroyWorktree(target.worktree)
      } catch (e) {
        log(`worktree removal failed for issue ${target.itemId}: ${errMsg(e)}`)
      }
    }
  }

  if (target.needsHuman === true) {
    try {
      await labelIssue(target.itemId, NEEDS_HUMAN_LABEL)
    } catch (e) {
      log(`labelling issue ${target.itemId} with ${NEEDS_HUMAN_LABEL} failed: ${errMsg(e)}`)
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------
// Issue #1755: salvage-wedge detection, clearing, and inventory
// ---------------------------------------------------------------------------

export interface WedgedWorktree {
  worktree: string
  salvageBranch: string
}

/**
 * The fleet branch a salvage branch was created FROM, recovered by parsing
 * the name structurally — or `undefined` when `branch` is not a salvage
 * branch in either known form. Salvage names are
 * `salvage/<fleet branch>-<epoch>` (slash form, current) and
 * `salvage/<fleet branch with / → ->-<epoch>` (dash form, the older
 * worker-name flow); in both, `<epoch>` is the `Date.now()` that
 * `salvageUncommittedWork` appends — a trailing run of digits. The parse is
 * therefore: strip `salvage/`, strip the ONE trailing `-<digits>` segment.
 *
 * Matching is EQUALITY on the recovered fleet branch, never a prefix test:
 * item ids are issue numbers, and issue numbers prefix each other —
 * `salvage/fleet/ios/1` is a prefix of `salvage/fleet/ios/12-…` and of
 * `salvage/fleet/ios/1755-…`. A `startsWith` match (what this replaced)
 * wedges item 1 behind item 1755's leftover worktree and posts the
 * reconcile-comment/`needs-human` label on the WRONG issue — the review
 * rejection on PR #1772. An epoch-less `salvage/<name>` matches NOTHING: it
 * is not a name this fleet writes, and failing to recognise one fails toward
 * a human looking at it (the worktree's branch-mismatch guard still refuses
 * the dispatch), never toward touching another item's state.
 */
export function salvagedFleetBranch(branch: string): string | undefined {
  if (!branch.startsWith('salvage/')) return undefined
  const body = branch.slice('salvage/'.length)
  // Leftmost-successful `-\d+$`: `.*`-less anchoring means the match is the
  // LAST `-<digits>` run, so `fleet-ios-7-1790000000000` strips only the
  // epoch and yields `fleet-ios-7`.
  const epoch = /-\d+$/.exec(body)
  if (epoch === null) return undefined
  const fleetBranch = body.slice(0, epoch.index)
  return fleetBranch.length > 0 ? fleetBranch : undefined
}

/**
 * Whether `branch` is a salvage branch OF `fleetBranch` — slash form or dash
 * form, compared by equality on the parsed item, so one item's wedge can
 * never match a sibling item whose id merely extends it (`1` vs `1755`).
 */
function isSalvageBranchFor(branch: string, fleetBranch: string): boolean {
  const salvaged = salvagedFleetBranch(branch)
  return salvaged === fleetBranch || salvaged === fleetBranch.replaceAll('/', '-')
}

/**
 * Finds worktrees checked out on a salvage branch belonging to
 * `fleetBranch` — the physical shape of an issue #1755 wedge: settle()'s
 * salvage checked the worktree out onto `salvage/<branch>-<epoch>` and the
 * worktree was never destroyed, so dispatch-one.sh's unsaved-work check
 * keeps it and its branch-mismatch guard refuses every later dispatch for
 * the item.
 */
export async function findWedgedWorktrees(repoRoot: string, fleetBranch: string): Promise<WedgedWorktree[]> {
  const out = await run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'])
  const found: WedgedWorktree[] = []
  let current: string | undefined
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ') && current !== undefined) {
      const branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      if (isSalvageBranchFor(branch, fleetBranch)) {
        found.push({ worktree: current, salvageBranch: branch })
      }
    } else if (line.trim().length === 0) {
      current = undefined
    }
  }
  return found
}

/**
 * Files `branch` carries beyond its merge-base with `origin/main`, split
 * into real vs artifact by the same ignore-rule classification as
 * `classifyWorktreeChanges` — a salvage branch whose ONLY content is a
 * committed `.test-encrypted-seed.sqlite` holds no work, and one whose diff
 * contains a single real source file must still refuse loudly. Returns
 * `undefined` when the comparison cannot be made (no `origin/main` ref, an
 * unreadable branch): the caller fails CLOSED on `undefined`, never treats
 * "could not look" as "nothing there".
 */
export async function salvageBranchContent(
  repoRoot: string,
  branch: string,
): Promise<{ real: string[]; artifacts: string[] } | undefined> {
  try {
    const mergeBase = (await run('git', ['-C', repoRoot, 'merge-base', 'origin/main', branch])).trim()
    const diff = await run('git', ['-C', repoRoot, 'diff', '--name-only', '-z', '--no-renames', `${mergeBase}..${branch}`])
    const paths = diff.split('\0').filter((p) => p.length > 0)
    const ignored = await ignoredPathsAmong(repoRoot, paths)
    return {
      real: paths.filter((p) => !ignored.has(p)),
      artifacts: paths.filter((p) => ignored.has(p)),
    }
  } catch {
    return undefined
  }
}

export type WedgeResolution =
  | { kind: 'none' }
  | { kind: 'cleared'; worktree: string; salvageBranch: string }
  | { kind: 'blocked'; worktree: string; salvageBranch: string; reason: string }

/**
 * The pre-dispatch half of the #1755 fix, run by `realDispatch` before a
 * worker is launched for `fleetBranch`:
 *
 * - No salvage worktree for this branch → `none`, dispatch proceeds.
 * - A salvage worktree holding ONLY artifacts (a staged/committed
 *   `.test-encrypted-seed.sqlite` and nothing else, on both axes: the
 *   worktree's own uncommitted state and the salvage branch's committed
 *   diff) → the worktree is removed (`--force`; the salvage BRANCH is kept —
 *   deleting any salvage branch is an operator decision, never this
 *   function's), and the lane dispatches fresh. This is the break-it case
 *   that must keep dispatching.
 * - Any real work anywhere in the wedge → `blocked`, naming the worktree and
 *   the salvage branch, so the caller can record the distinct WEDGED outcome
 *   instead of burning a dispatch. This is the break-it case that must keep
 *   refusing: seven salvage branches hold genuinely completed work, and the
 *   whole value of the guard is that it preserved them.
 */
export async function resolveWedgeForDispatch(repoRoot: string, fleetBranch: string): Promise<WedgeResolution> {
  const wedges = await findWedgedWorktrees(repoRoot, fleetBranch)
  if (wedges.length === 0) return { kind: 'none' }

  let cleared: { worktree: string; salvageBranch: string } | undefined
  for (const wedge of wedges) {
    const uncommitted = await classifyWorktreeChanges(wedge.worktree)
    const committed = await salvageBranchContent(repoRoot, wedge.salvageBranch)

    if (committed === undefined) {
      return {
        kind: 'blocked', worktree: wedge.worktree, salvageBranch: wedge.salvageBranch,
        reason: `could not diff ${wedge.salvageBranch} against origin/main — refusing to guess whether it holds work`,
      }
    }
    if (uncommitted.real.length > 0) {
      return {
        kind: 'blocked', worktree: wedge.worktree, salvageBranch: wedge.salvageBranch,
        reason: `worktree holds uncommitted real changes (${uncommitted.real.length} file(s): ${uncommitted.real.slice(0, 5).join(', ')})`,
      }
    }
    if (committed.real.length > 0) {
      return {
        kind: 'blocked', worktree: wedge.worktree, salvageBranch: wedge.salvageBranch,
        reason: `salvage branch holds real work (${committed.real.length} file(s): ${committed.real.slice(0, 5).join(', ')})`,
      }
    }

    // Artifact-only: unstage any staged artifacts first so no later
    // porcelain-based check can mistake the tree for dirty, then remove the
    // worktree. The salvage branch itself is deliberately kept.
    await unstageArtifacts(wedge.worktree, uncommitted.artifacts)
    await destroyWorktree(wedge.worktree)
    cleared = wedge
  }
  return cleared !== undefined
    ? { kind: 'cleared', worktree: cleared.worktree, salvageBranch: cleared.salvageBranch }
    : { kind: 'none' }
}

export interface SalvageInventoryEntry {
  branch: string
  /** Whether a worktree is currently attached to this salvage branch. */
  hasWorktree: boolean
  /** Real (non-artifact) files beyond origin/main. `undefined` when the
   *  comparison could not be made — reported as "unreadable", never as
   *  "empty". */
  realFiles?: number
  artifactFiles?: number
}

/**
 * The `doctor` half of #1755: every local `salvage/*` branch, classified by
 * whether it holds real work. 39 of these accrued on the dispatch host with
 * no signal at all; 32 held nothing but the test-seed artifact and 7 held
 * completed work — a report that names the second group is what makes the
 * difference visible before the branches cost more to rebase than they save.
 * Never throws: a doctor that crashes on one unreadable branch reports
 * nothing about the other 38.
 */
export async function salvageInventory(repoRoot: string): Promise<SalvageInventoryEntry[]> {
  let branches: string[]
  try {
    branches = (await run('git', ['-C', repoRoot, 'branch', '--list', 'salvage/*', '--format=%(refname:short)']))
      .split('\n').map((b) => b.trim()).filter((b) => b.length > 0)
  } catch {
    return []
  }
  if (branches.length === 0) return []

  // One worktree listing serves every branch — `git worktree list` per
  // branch would ask the same question N times.
  const attached = new Set<string>()
  try {
    const wt = await run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'])
    for (const line of wt.split('\n')) {
      if (line.startsWith('branch ')) attached.add(line.slice('branch '.length).trim().replace(/^refs\/heads\//, ''))
    }
  } catch { /* treated as none attached */ }

  const entries: SalvageInventoryEntry[] = []
  for (const branch of branches) {
    const content = await salvageBranchContent(repoRoot, branch)
    entries.push({
      branch,
      hasWorktree: attached.has(branch),
      realFiles: content?.real.length,
      artifactFiles: content?.artifacts.length,
    })
  }
  return entries
}
