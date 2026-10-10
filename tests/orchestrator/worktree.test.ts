import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// worktree.ts calls `promisify(execFile)` once at import time, same reasoning
// as review.test.ts: the `util.promisify.custom` hook must exist on the mock
// BEFORE worktree.ts is imported. `git` passes through to the REAL execFile
// (salvage/destroy are exercised against real temp git repos below); `tmux`,
// `pkill` and `gh` are trapped by the mock so this suite never depends on
// those binaries being installed or authenticated.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { vi: vitest } = await import('vitest')
  const { promisify: nodePromisify } = await import('node:util')
  const realExecFileAsync = nodePromisify(actual.execFile)
  const mockFn = vitest.fn()
  ;(mockFn as unknown as Record<symbol, unknown>)[nodePromisify.custom] =
    (file: string, args?: readonly string[], options?: unknown) => {
      if (file === 'git') return realExecFileAsync(file, args as string[], options as never)
      return mockFn(file, args, options)
    }
  return { ...actual, execFile: mockFn }
})

import { execFile } from 'node:child_process'
import {
  stopSession, killWorktreeProcesses, salvageUncommittedWork, destroyWorktree, labelIssue, settle,
  classifyWorktreeChanges, parsePorcelainPaths, findWedgedWorktrees, resolveWedgeForDispatch,
  salvageInventory, salvagedFleetBranch,
} from '../../orchestrator/src/worktree.js'

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockExecFile.mockReset()
  mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })
})

// --- Real git fixtures: a bare "origin" plus a linked worktree off a main repo ---

const createdDirs: string[] = []

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

interface Fixture { bareOrigin: string; mainRepo: string; worktree: string; branch: string }

function makeFixture(): Fixture {
  const bareOrigin = tmp('llamenos-fleet-wt-origin-')
  execSync('git init -q --bare', { cwd: bareOrigin })

  const mainRepo = tmp('llamenos-fleet-wt-main-')
  execSync('git init -q -b main', { cwd: mainRepo })
  execSync('git config user.email test@example.com', { cwd: mainRepo })
  execSync('git config user.name Test', { cwd: mainRepo })
  writeFileSync(join(mainRepo, 'file.txt'), 'hello\n')
  // The ignore rules the #1755 artifact classification is exercised against —
  // same shape as the real repo's `.gitignore:98-99`.
  writeFileSync(join(mainRepo, '.gitignore'), '/.test-encrypted-seed.sqlite\n/*.sqlite\n')
  execSync('git add file.txt .gitignore', { cwd: mainRepo })
  execSync('git commit -q -m init', { cwd: mainRepo })
  execSync(`git remote add origin ${bareOrigin}`, { cwd: mainRepo })
  execSync('git push -q -u origin main', { cwd: mainRepo })

  const branch = 'work-1'
  const worktree = join(tmp('llamenos-fleet-wt-parent-'), 'wt')
  execSync(`git worktree add -q -b ${branch} ${worktree} main`, { cwd: mainRepo })
  execSync('git config user.email test@example.com', { cwd: worktree })
  execSync('git config user.name Test', { cwd: worktree })

  return { bareOrigin, mainRepo, worktree, branch }
}

/** The exact #1755 wedge state: a gitignored test artifact force-staged into
 *  the index (`git status` reports `A`), which a bare dirty-tree check cannot
 *  tell apart from real work. */
function stageIgnoredArtifact(dir: string, name = '.test-encrypted-seed.sqlite'): string {
  writeFileSync(join(dir, name), 'fake sqlite seed\n')
  execSync(`git add -f ${name}`, { cwd: dir })
  return name
}

afterEach(() => {
  for (const d of createdDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* already gone */ }
  }
})

describe('stopSession', () => {
  it('calls tmux kill-session with the given name', async () => {
    await stopSession('fleet-ios-42')
    expect(mockExecFile).toHaveBeenCalledWith('tmux', ['kill-session', '-t', 'fleet-ios-42'], expect.anything())
  })

  it('does not throw when the session no longer exists', async () => {
    mockExecFile.mockRejectedValueOnce(new Error('no session'))
    await expect(stopSession('gone')).resolves.toBeUndefined()
  })
})

describe('killWorktreeProcesses', () => {
  it('calls pkill -f with the worktree path', async () => {
    await killWorktreeProcesses('/some/worktree')
    expect(mockExecFile).toHaveBeenCalledWith('pkill', ['-f', '/some/worktree'], expect.anything())
  })

  it('does not throw when nothing matches', async () => {
    mockExecFile.mockRejectedValueOnce(new Error('exit 1'))
    await expect(killWorktreeProcesses('/none')).resolves.toBeUndefined()
  })
})

describe('salvageUncommittedWork', () => {
  it('reports salvaged: false and touches nothing when the worktree is clean', async () => {
    const f = makeFixture()
    const result = await salvageUncommittedWork(f.worktree, f.branch)
    expect(result).toEqual({ salvaged: false })
    // MUTATION GUARD: a version of this function that always tries to push
    // would fail loudly here (there is nothing to commit), which is exactly
    // the case this early return exists to skip.
  })

  it('commits and pushes uncommitted work to a new salvage branch', async () => {
    const f = makeFixture()
    writeFileSync(join(f.worktree, 'uncommitted.txt'), 'rescue me\n')
    const result = await salvageUncommittedWork(f.worktree, f.branch)
    expect(result.salvaged).toBe(true)
    expect(result.branch).toMatch(new RegExp(`^salvage/${f.branch}-\\d+$`))

    // Proof it actually reached the remote, not just a local branch: list
    // branches on the bare "origin" fixture directly.
    const remoteBranches = execSync('git branch --list', { cwd: f.bareOrigin }).toString()
    expect(remoteBranches).toContain(result.branch)
  })

  it('preserves the uncommitted file content in the pushed branch', async () => {
    const f = makeFixture()
    writeFileSync(join(f.worktree, 'uncommitted.txt'), 'the 1070 correct lines\n')
    const result = await salvageUncommittedWork(f.worktree, f.branch)
    const showOutput = execSync(`git show ${result.branch}:uncommitted.txt`, { cwd: f.bareOrigin }).toString()
    expect(showOutput).toBe('the 1070 correct lines\n')
  })
})

describe('parsePorcelainPaths', () => {
  it('parses NUL-terminated entries and skips truncated tails', () => {
    expect(parsePorcelainPaths('A  .test-encrypted-seed.sqlite\0 M src/a.ts\0?? b.txt\0x')).toEqual([
      '.test-encrypted-seed.sqlite', 'src/a.ts', 'b.txt',
    ])
  })

  it('parses nothing from an empty status', () => {
    expect(parsePorcelainPaths('')).toEqual([])
  })
})

describe('classifyWorktreeChanges (issue #1755)', () => {
  it('reports a clean tree as neither real nor artifact', async () => {
    const f = makeFixture()
    expect(await classifyWorktreeChanges(f.worktree)).toEqual({ real: [], artifacts: [] })
  })

  it('classifies a staged gitignored artifact as an artifact, NOT as work — the wedge shape', async () => {
    const f = makeFixture()
    const name = stageIgnoredArtifact(f.worktree)
    const result = await classifyWorktreeChanges(f.worktree)
    expect(result.real).toEqual([])
    expect(result.artifacts).toEqual([name])
  })

  it('classifies any root-level *.sqlite as an artifact, not just the one known filename', async () => {
    const f = makeFixture()
    const name = stageIgnoredArtifact(f.worktree, 'other.sqlite')
    const result = await classifyWorktreeChanges(f.worktree)
    expect(result.artifacts).toEqual([name])
  })

  it('classifies one genuinely modified source file as real work — the guard that must never weaken', async () => {
    const f = makeFixture()
    writeFileSync(join(f.worktree, 'file.txt'), 'changed\n')
    const result = await classifyWorktreeChanges(f.worktree)
    expect(result.real).toEqual(['file.txt'])
    expect(result.artifacts).toEqual([])
  })

  it('classifies an untracked, non-ignored file as real work', async () => {
    const f = makeFixture()
    writeFileSync(join(f.worktree, 'new-feature.ts'), 'export {}\n')
    const result = await classifyWorktreeChanges(f.worktree)
    expect(result.real).toEqual(['new-feature.ts'])
  })

  it('separates real work from artifacts in a mixed tree', async () => {
    const f = makeFixture()
    writeFileSync(join(f.worktree, 'file.txt'), 'changed\n')
    const name = stageIgnoredArtifact(f.worktree)
    const result = await classifyWorktreeChanges(f.worktree)
    expect(result.real).toEqual(['file.txt'])
    expect(result.artifacts).toEqual([name])
  })
})

describe('salvageUncommittedWork with ignored artifacts (issue #1755)', () => {
  it('treats an artifact-only tree as having no work: unstages the artifact, creates no salvage branch, leaves the file on disk', async () => {
    const f = makeFixture()
    const name = stageIgnoredArtifact(f.worktree)
    const result = await salvageUncommittedWork(f.worktree, f.branch)
    expect(result).toEqual({ salvaged: false, clearedArtifacts: 1 })

    // The tree now reads genuinely clean to a porcelain-based check — the
    // artifact is back to untracked-and-ignored — and the file itself is
    // untouched on disk (a dispatcher seed cache can reuse it).
    const status = execSync('git status --porcelain', { cwd: f.worktree }).toString()
    expect(status.trim()).toBe('')
    expect(existsSync(join(f.worktree, name))).toBe(true)

    // No salvage branch was created, locally or on the remote.
    const branches = execSync('git branch --list', { cwd: f.mainRepo }).toString()
    expect(branches).not.toContain('salvage/')
    // And the worktree is still on its ORIGINAL branch — the wedge was that
    // salvage left it checked out somewhere else.
    const onBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: f.worktree }).toString().trim()
    expect(onBranch).toBe(f.branch)
  })

  it('still salvages real work, and the salvage commit does NOT carry the artifact', async () => {
    const f = makeFixture()
    writeFileSync(join(f.worktree, 'uncommitted.txt'), 'rescue me\n')
    stageIgnoredArtifact(f.worktree)
    const result = await salvageUncommittedWork(f.worktree, f.branch)
    expect(result.salvaged).toBe(true)
    const files = execSync(`git show --name-only --format= ${result.branch}`, { cwd: f.bareOrigin }).toString()
    expect(files).toContain('uncommitted.txt')
    expect(files).not.toContain('.test-encrypted-seed.sqlite')
  })
})

describe('salvagedFleetBranch (PR #1772 review: structural parse, never prefix)', () => {
  it('recovers the fleet branch from the slash form', () => {
    expect(salvagedFleetBranch('salvage/fleet/ios/1755-1790000000000')).toBe('fleet/ios/1755')
  })

  it('recovers the dash form (older worker-name flow) by stripping only the trailing epoch', () => {
    expect(salvagedFleetBranch('salvage/fleet-ios-7-1790000000000')).toBe('fleet-ios-7')
  })

  it('does NOT confuse an item id with the epoch when the ids prefix each other', () => {
    // The whole defect: item 1's prefix also matches items 12 and 1755. The
    // parse must keep the item-id segment intact for comparison.
    expect(salvagedFleetBranch('salvage/fleet/ios/1-1790000000000')).toBe('fleet/ios/1')
    expect(salvagedFleetBranch('salvage/fleet/ios/1755-1790000000000')).toBe('fleet/ios/1755')
    expect(salvagedFleetBranch('salvage/fleet/ios/12-1790000000000')).toBe('fleet/ios/12')
  })

  it('rejects non-salvage branches and epoch-less salvage names', () => {
    expect(salvagedFleetBranch('fleet/ios/1')).toBeUndefined()
    expect(salvagedFleetBranch('main')).toBeUndefined()
    expect(salvagedFleetBranch('salvage/fleet/ios/1')).toBeUndefined()
  })
})

describe('resolveWedgeForDispatch (issue #1755)', () => {
  /**
   * Builds the wedge: the worktree is checked out onto
   * `salvage/<branch>-<epoch>` with the given files committed there.
   * `artifact` commits the ignored seed via `git add -f`; `realFile` commits
   * a genuine source change.
   */
  function wedgeFixture(f: Fixture, opts: { artifact?: boolean; realFile?: boolean; salvageBranch?: string }): string {
    const salvageBranch = opts.salvageBranch ?? `salvage/${f.branch}-1790000000000`
    execSync(`git checkout -q -b ${salvageBranch}`, { cwd: f.worktree })
    if (opts.artifact === true) {
      stageIgnoredArtifact(f.worktree)
    }
    if (opts.realFile === true) {
      writeFileSync(join(f.worktree, 'real-work.ts'), 'export const finished = true\n')
      execSync('git add real-work.ts', { cwd: f.worktree })
    }
    execSync('git commit -q -m salvage', { cwd: f.worktree })
    return salvageBranch
  }

  it('reports none when no salvage worktree exists for the branch', async () => {
    const f = makeFixture()
    expect(await resolveWedgeForDispatch(f.mainRepo, f.branch)).toEqual({ kind: 'none' })
  })

  it('clears an artifact-only wedge — the lane dispatches — and KEEPS the salvage branch', async () => {
    const f = makeFixture()
    const salvageBranch = wedgeFixture(f, { artifact: true })
    const result = await resolveWedgeForDispatch(f.mainRepo, f.branch)
    expect(result).toEqual({ kind: 'cleared', worktree: f.worktree, salvageBranch })
    // The worktree is gone, so the next dispatch cuts a fresh one...
    expect(existsSync(f.worktree)).toBe(false)
    // ...but the salvage BRANCH is never this function's to delete.
    const branches = execSync('git branch --list', { cwd: f.mainRepo }).toString()
    expect(branches).toContain(salvageBranch)
  })

  it('refuses a wedge whose salvage branch holds real work, and preserves everything', async () => {
    const f = makeFixture()
    const salvageBranch = wedgeFixture(f, { artifact: true, realFile: true })
    const result = await resolveWedgeForDispatch(f.mainRepo, f.branch)
    expect(result.kind).toBe('blocked')
    if (result.kind !== 'blocked') throw new Error('unreachable')
    expect(result.worktree).toBe(f.worktree)
    expect(result.salvageBranch).toBe(salvageBranch)
    expect(result.reason).toContain('real-work.ts')
    // Nothing was destroyed: the work is exactly where the guard found it.
    expect(existsSync(f.worktree)).toBe(true)
    expect(existsSync(join(f.worktree, 'real-work.ts'))).toBe(true)
    const branches = execSync('git branch --list', { cwd: f.mainRepo }).toString()
    expect(branches).toContain(salvageBranch)
  })

  it('refuses a wedge whose worktree holds uncommitted real changes even when the salvage branch is artifact-only', async () => {
    const f = makeFixture()
    wedgeFixture(f, { artifact: true })
    writeFileSync(join(f.worktree, 'file.txt'), 'real modification\n')
    const result = await resolveWedgeForDispatch(f.mainRepo, f.branch)
    expect(result.kind).toBe('blocked')
    if (result.kind !== 'blocked') throw new Error('unreachable')
    expect(result.reason).toContain('file.txt')
    expect(existsSync(f.worktree)).toBe(true)
  })

  it('finds the dash-form salvage branch name (older flow named branches after the worker, not the fleet branch)', async () => {
    const f = makeFixture()
    // fleetBranch 'fleet/ios/7' wedges under BOTH `salvage/fleet/ios/7-*` and
    // `salvage/fleet-ios-7-*`; exercise the dash form explicitly.
    const salvageBranch = wedgeFixture(f, { artifact: true, salvageBranch: 'salvage/fleet-ios-7-1790000000000' })
    const found = await findWedgedWorktrees(f.mainRepo, 'fleet/ios/7')
    expect(found).toEqual([{ worktree: f.worktree, salvageBranch }])
    const result = await resolveWedgeForDispatch(f.mainRepo, 'fleet/ios/7')
    expect(result.kind).toBe('cleared')
  })

  it('does NOT wedge item 1 behind item 1755\'s salvage branch — issue ids prefix each other (PR #1772 review)', async () => {
    const f = makeFixture()
    // The genuine prefix pair the original suite never exercised (it used
    // items 1 and 7): `salvage/fleet/ios/1` is a string prefix of
    // `salvage/fleet/ios/1755-…`, so an undelimited startsWith matched one
    // item's wedge against a sibling item whose id merely extends it. Wedge
    // the worktree on item 1755's salvage branch, then resolve for item 1.
    wedgeFixture(f, { artifact: true, salvageBranch: 'salvage/fleet/ios/1755-1790000000000' })

    // Item 1 sees NO wedge: the parse compares the recovered fleet branch by
    // equality, and 'fleet/ios/1755' !== 'fleet/ios/1'.
    expect(await findWedgedWorktrees(f.mainRepo, 'fleet/ios/1')).toEqual([])
    expect(await resolveWedgeForDispatch(f.mainRepo, 'fleet/ios/1')).toEqual({ kind: 'none' })

    // Item 1's dispatch therefore proceeds — and because WEDGED is the only
    // outcome that posts the reconcile comment and applies `needs-human`
    // (tick.ts), no comment or label lands on item 1 for item 1755's state.
    // resolveWedgeForDispatch itself never calls gh; assert the precondition
    // directly: nothing was cleared or destroyed for item 1 either.
    expect(existsSync(f.worktree)).toBe(true)

    // …and the wedge still belongs to item 1755, found intact.
    expect(await findWedgedWorktrees(f.mainRepo, 'fleet/ios/1755'))
      .toEqual([{ worktree: f.worktree, salvageBranch: 'salvage/fleet/ios/1755-1790000000000' }])
  })
})

describe('salvageInventory (issue #1755 doctor report)', () => {
  it('reports nothing when no salvage branches exist', async () => {
    const f = makeFixture()
    expect(await salvageInventory(f.mainRepo)).toEqual([])
  })

  it('counts salvage branches and names the ones holding real work', async () => {
    const f = makeFixture()

    // Artifact-only salvage branch, no worktree attached.
    execSync('git branch salvage/old-artifact-1 main', { cwd: f.mainRepo })

    // Real-work salvage branch attached to the fixture worktree.
    execSync('git checkout -q -b salvage/work-1-1790000000000', { cwd: f.worktree })
    writeFileSync(join(f.worktree, 'real-work.ts'), 'export const finished = true\n')
    execSync('git add real-work.ts', { cwd: f.worktree })
    stageIgnoredArtifact(f.worktree)
    execSync('git commit -q -m salvage', { cwd: f.worktree })

    const inventory = await salvageInventory(f.mainRepo)
    const byBranch = new Map(inventory.map((e) => [e.branch, e]))
    expect(inventory.length).toBe(2)

    const artifactOnly = byBranch.get('salvage/old-artifact-1')
    expect(artifactOnly?.realFiles).toBe(0)
    expect(artifactOnly?.hasWorktree).toBe(false)

    const withWork = byBranch.get('salvage/work-1-1790000000000')
    expect(withWork?.realFiles).toBe(1)
    expect(withWork?.artifactFiles).toBe(1)
    expect(withWork?.hasWorktree).toBe(true)
  })
})

describe('destroyWorktree', () => {
  it('removes the worktree directory and deregisters it from the repo', async () => {
    const f = makeFixture()
    expect(existsSync(f.worktree)).toBe(true)
    await destroyWorktree(f.worktree)
    expect(existsSync(f.worktree)).toBe(false)
    const list = execSync('git worktree list', { cwd: f.mainRepo }).toString()
    expect(list).not.toContain(f.worktree)
  })

  it('removes a worktree even after it was checked out onto a fresh salvage branch (dirty from the main repo\'s view)', async () => {
    const f = makeFixture()
    writeFileSync(join(f.worktree, 'uncommitted.txt'), 'x\n')
    await salvageUncommittedWork(f.worktree, f.branch)
    await expect(destroyWorktree(f.worktree)).resolves.toBeUndefined()
    expect(existsSync(f.worktree)).toBe(false)
  })
})

describe('labelIssue', () => {
  it('calls gh issue edit with --add-label', async () => {
    await labelIssue('42', 'fleet:merged')
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh', expect.arrayContaining(['issue', 'edit', '42', '--add-label', 'fleet:merged']), expect.anything(),
    )
  })
})

describe('settle', () => {
  it('stops the session, salvages, destroys the worktree, and labels needs-human, in that order, when the caller says so', async () => {
    const f = makeFixture()
    writeFileSync(join(f.worktree, 'uncommitted.txt'), 'salvage me\n')
    const log = vi.fn()

    await settle(
      { name: 'fleet-ios-1', itemId: '1', outcome: 'BLOCKED', worktree: f.worktree, branch: f.branch, needsHuman: true },
      log,
    )

    // Ordering: tmux kill-session must be the FIRST mocked call, and the
    // gh label call must be the LAST — with the real git salvage/destroy
    // calls (not visible on the mock) happening in between. This is the
    // "salvage before destroy" property, made observable: if destroy ran
    // before salvage, the worktree directory would already be gone by the
    // time salvageUncommittedWork tried to read its status, and salvage
    // would throw instead of succeeding.
    expect(mockExecFile.mock.calls[0]?.[0]).toBe('tmux')
    const ghCallIndex = mockExecFile.mock.calls.findIndex((c) => c[0] === 'gh')
    expect(ghCallIndex).toBe(mockExecFile.mock.calls.length - 1)
    expect(mockExecFile.mock.calls[ghCallIndex]?.[1]).toEqual(expect.arrayContaining(['needs-human']))
    expect(existsSync(f.worktree)).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('salvaged uncommitted work'))
  })

  it('destroys the worktree on a FAILED outcome too', async () => {
    const f = makeFixture()
    const log = vi.fn()
    await settle({ name: 'fleet-ios-1', itemId: '1', outcome: 'FAILED', worktree: f.worktree, branch: f.branch, needsHuman: false }, log)
    expect(existsSync(f.worktree)).toBe(false)
  })

  it('does NOT destroy the worktree when salvage itself fails — teardown must not run ahead of a failed salvage', async () => {
    const f = makeFixture()
    writeFileSync(join(f.worktree, 'uncommitted.txt'), 'at risk\n')
    // git calls in this suite pass straight through to the REAL execFile (see
    // the vi.mock factory above), so the push leg is broken authentically —
    // by pointing origin at a path that cannot receive a push — rather than
    // by intercepting the call. checkout/add/commit still succeed against the
    // real local repo (proving there IS uncommitted work worth salvaging);
    // only the push, the step that actually gets it out of the doomed
    // worktree, fails.
    execSync(`git remote set-url origin ${join(tmpdir(), 'llamenos-fleet-nonexistent-origin')}`, { cwd: f.worktree })
    const log = vi.fn()
    await settle({ name: 'fleet-ios-1', itemId: '1', outcome: 'BLOCKED', worktree: f.worktree, branch: f.branch, needsHuman: true }, log)
    expect(existsSync(f.worktree)).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('refusing to destroy the worktree'))
  })

  it('skips worktree steps entirely when no worktree is known, but still applies needs-human when asked', async () => {
    const log = vi.fn()
    await settle({ name: 'fleet-ios-1', itemId: '1', outcome: 'BLOCKED', needsHuman: true }, log)
    const ghCall = mockExecFile.mock.calls.find((c) => c[0] === 'gh')
    expect(ghCall?.[1]).toEqual(expect.arrayContaining(['needs-human']))
  })

  // G1: this is the property the whole redesign exists for. settle() must
  // NEVER write an outcome-shaped label (`fleet:merged`, `fleet:rejected`,
  // ...) for ANY outcome — that is exactly the cached claim that drifted
  // from reality on issue #660 (`fleet:merged` on a PR that was never
  // merged). A label is only ever `needs-human`, and only when the caller
  // explicitly says so.
  it('applies NO label at all for any outcome when needsHuman is not set — outcome labels no longer exist', () => {
    return Promise.all(
      (['SUCCESS', 'REJECTED', 'BLOCKED', 'FAILED', 'TIMEOUT', 'QUOTA', 'SHADOW', 'DISPATCHED'] as const).map(async (outcome) => {
        mockExecFile.mockClear()
        await settle({ name: 'fleet-ios-1', itemId: '1', outcome }, () => {})
        const ghCall = mockExecFile.mock.calls.find((c) => c[0] === 'gh')
        expect(ghCall, `outcome ${outcome} must not label the issue`).toBeUndefined()
      }),
    )
  })

  it('applies needs-human even for a claimed SUCCESS the fleet could not verify', async () => {
    const log = vi.fn()
    await settle({ name: 'fleet-ios-1', itemId: '1', outcome: 'SUCCESS', needsHuman: true }, log)
    const ghCall = mockExecFile.mock.calls.find((c) => c[0] === 'gh')
    expect(ghCall?.[1]).toEqual(expect.arrayContaining(['needs-human']))
  })
})
