import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Would a candidate's changes MERGE into the merge group it would join? —
 * queue-feed's requirement 3, answered per shared file by git's own merge
 * rather than by the file names (#2570).
 *
 * WHY NOT FILE NAMES. Requirement 3 exists because under ALLGREEN a group
 * that cannot be built fails as a whole. It used to be answered by file-set
 * intersection: any file two PRs both touch was a conflict. Measured on
 * 2026-11-07, that is overwhelmingly a false positive for the files nearly
 * every PR touches, and accurate for ordinary source files:
 *
 *   - `package.json`: 6 overlapping pairs in the live open set, 1 real
 *     conflict (two PRs appending to the same `test:repo` line); across the
 *     61 concurrently-open pairs of merged PRs since 2026-09-07, 0 real
 *     conflicts in the 43 that could be replayed.
 *   - i18n locales: 2 real conflicts in ~79 replayable pairs; PROTOCOL.md 3
 *     in 72; the settings files 4 in ~45.
 *   - ordinary source files in the live open set: 6 of the 9 overlapping
 *     pairs DO conflict.
 *
 * So the rule was right about the question and wrong about the granularity:
 * a script addition, a version bump and a dependency change all land in
 * `package.json`, and touching the same file is not the same as touching the
 * same lines.
 *
 * WHAT THIS DOES. For every file the candidate shares with the group it would
 * join (the queue's entries in queue order, then this pass's selections in
 * arming order), it rebuilds that file as the group would hold it — the base
 * branch's tip, then each earlier member's change three-way-merged in turn —
 * and three-way-merges the candidate's change on top. The merge is git's
 * own: `git merge-tree --write-tree --merge-base` (merge-ort, histogram diff,
 * the same content merge and conflict rule GitHub's merge machinery uses),
 * run in a throwaway object store over the exact blobs. Nothing is
 * predicted: a file is batchable only when that merge is clean.
 *
 * FAILURE DIRECTION. Anything that cannot be simulated answers CONFLICT: a
 * blob that cannot be read or does not exist on one side (an added, deleted
 * or renamed file is not a modify/modify merge this can replay), binary
 * content, an earlier member that itself does not merge, more shared files
 * than `MAX_SIMULATED_FILES`, or any git error. Refusing costs one PR one
 * pass; a wrong "clean" costs the whole group.
 */

/** Above this many shared files the candidate is refused without reading
 *  anything: the overlap is no longer a hotspot, and the bound keeps a pass's
 *  API reads finite. */
export const MAX_SIMULATED_FILES = 25

/** One three-way merge. `undefined` when the merge could not be run at all. */
export type MergeOutcome = { clean: true; merged: string } | { clean: false } | undefined

/** One member of the group, in the order it is (or will be) merged. */
export interface GroupMember {
  pr: number
  files: ReadonlySet<string>
}

export interface MergeSimReads {
  /** The base branch's current tip commit. `undefined` on failure. */
  readBranchHead(branch: string): Promise<string | undefined>
  /** A member's head commit. `undefined` on failure. */
  readHead(pr: number): Promise<string | undefined>
  /** The commit a PR's diff is taken from. `undefined` on failure. */
  readMergeBase(baseRef: string, headSha: string): Promise<string | undefined>
  /** A file's text at a commit. `undefined` on failure OR absence — the two
   *  are deliberately not told apart: either way the merge is not a
   *  modify/modify one this can replay. */
  readBlobAt(path: string, sha: string): Promise<string | undefined>
  /** git's three-way merge of one file's content (`gitThreeWayMerge`). */
  mergeContents(base: string, ours: string, theirs: string): Promise<MergeOutcome>
}

export type SharedFilesVerdict =
  /** Every shared file merges cleanly (`files` may be empty: no overlap). */
  | { kind: 'clean'; files: string[] }
  /** git reports a conflict on `file` against the members that touch it. */
  | { kind: 'conflict'; file: string; with: number[] }
  /** The merge could not be simulated — read as a conflict by the caller. */
  | { kind: 'unprovable'; reason: string }

/** Per-pass memo of every read: a group member's blobs are read once however
 *  many candidates share its files. */
export interface MergeSimCache {
  heads: Map<number, Promise<string | undefined>>
  bases: Map<string, Promise<string | undefined>>
  blobs: Map<string, Promise<string | undefined>>
  tip?: Promise<string | undefined>
}

export function newMergeSimCache(): MergeSimCache {
  return { heads: new Map(), bases: new Map(), blobs: new Map() }
}

function memo<K, V>(m: Map<K, Promise<V>>, k: K, f: () => Promise<V>): Promise<V> {
  let hit = m.get(k)
  if (hit === undefined) {
    hit = f()
    m.set(k, hit)
  }
  return hit
}

/** Content git would not three-way-merge as text, or that did not survive
 *  the read as text. */
function isText(s: string): boolean {
  return !s.includes('\u0000') && !s.includes('�')
}

/**
 * Requirement 3 for one candidate against the group it would join.
 * `group` is in merge order; the candidate is merged last.
 */
export async function sharedFilesMerge(
  branch: string,
  candidate: { pr: number; head: string; files: readonly string[] },
  group: readonly GroupMember[],
  reads: MergeSimReads,
  cache: MergeSimCache,
): Promise<SharedFilesVerdict> {
  const shared = [...new Set(candidate.files)].filter((f) => group.some((m) => m.files.has(f))).sort()
  if (shared.length === 0) return { kind: 'clean', files: [] }
  if (shared.length > MAX_SIMULATED_FILES) {
    return { kind: 'unprovable', reason: `shares ${shared.length} files with the group (more than ${MAX_SIMULATED_FILES} are never simulated)` }
  }

  cache.tip ??= reads.readBranchHead(branch)
  const tip = await cache.tip
  if (tip === undefined) return { kind: 'unprovable', reason: `the ${branch} tip could not be read` }

  const headOf = (pr: number): Promise<string | undefined> => memo(cache.heads, pr, () => reads.readHead(pr))
  const baseOf = (head: string): Promise<string | undefined> => memo(cache.bases, head, () => reads.readMergeBase(branch, head))
  const blob = (path: string, sha: string): Promise<string | undefined> => memo(cache.blobs, `${sha}:${path}`, () => reads.readBlobAt(path, sha))

  /** One member's change to `path`, as (base, head) contents. */
  const changeOf = async (pr: number, head: string | undefined, path: string): Promise<{ base: string; head: string } | string> => {
    if (head === undefined) return `#${pr}'s head could not be read`
    const mb = await baseOf(head)
    if (mb === undefined) return `#${pr}'s merge base with ${branch} could not be read`
    const [b, h] = await Promise.all([blob(path, mb), blob(path, head)])
    if (b === undefined || h === undefined) {
      return `${path} could not be read at #${pr}'s ${b === undefined ? 'merge base' : 'head'} (or is added, deleted or renamed there)`
    }
    if (!isText(b) || !isText(h)) return `${path} is not text in #${pr}`
    return { base: b, head: h }
  }

  const merge = async (base: string, ours: string, theirs: string): Promise<MergeOutcome> => {
    try {
      return await reads.mergeContents(base, ours, theirs)
    } catch {
      return undefined
    }
  }

  for (const path of shared) {
    let current = await blob(path, tip)
    if (current === undefined) return { kind: 'unprovable', reason: `${path} could not be read at the ${branch} tip (or does not exist there)` }
    if (!isText(current)) return { kind: 'unprovable', reason: `${path} is not text` }

    const members = group.filter((m) => m.files.has(path))
    for (const m of members) {
      const change = await changeOf(m.pr, await headOf(m.pr), path)
      if (typeof change === 'string') return { kind: 'unprovable', reason: change }
      const out = await merge(change.base, current, change.head)
      if (out === undefined) return { kind: 'unprovable', reason: `git could not merge #${m.pr}'s ${path}` }
      if (!out.clean) return { kind: 'unprovable', reason: `#${m.pr}'s ${path} does not merge into the group ahead of it — the group's own content is unknown` }
      current = out.merged
    }

    const own = await changeOf(candidate.pr, candidate.head, path)
    if (typeof own === 'string') return { kind: 'unprovable', reason: own }
    const out = await merge(own.base, current, own.head)
    if (out === undefined) return { kind: 'unprovable', reason: `git could not merge ${path}` }
    if (!out.clean) return { kind: 'conflict', file: path, with: members.map((m) => m.pr) }
  }
  return { kind: 'clean', files: shared }
}

// ---------------------------------------------------------------------------
// The merge itself — git's, in a throwaway object store.
// ---------------------------------------------------------------------------

/** A fixed identity and no user/system config: the scratch store must not
 *  read the host's git configuration (a `merge.conflictStyle`, a custom
 *  driver), and `commit-tree` needs an identity to write anything. */
const SCRATCH_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'queue-feed', GIT_AUTHOR_EMAIL: 'queue-feed@invalid', GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'queue-feed', GIT_COMMITTER_EMAIL: 'queue-feed@invalid', GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
}

function git(gitDir: string, args: string[], input?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile('git', [`--git-dir=${gitDir}`, ...args], {
      env: SCRATCH_ENV, timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout) => {
      if (err === null) return resolvePromise({ code: 0, stdout })
      const code = (err as { code?: unknown }).code
      if (typeof code === 'number') return resolvePromise({ code, stdout })
      rejectPromise(err)
    })
    child.stdin?.on('error', () => { /* surfaces as the child's own error */ })
    child.stdin?.end(input ?? '')
  })
}

async function gitOk(gitDir: string, args: string[], input?: string): Promise<string> {
  const r = await git(gitDir, args, input)
  if (r.code !== 0) throw new Error(`git ${args[0] ?? ''} exited ${r.code}`)
  return r.stdout.trim()
}

/** A commit whose tree holds `content` as its one file. */
async function commitOf(gitDir: string, content: string): Promise<string> {
  const blob = await gitOk(gitDir, ['hash-object', '-w', '--stdin'], content)
  const tree = await gitOk(gitDir, ['mktree'], `100644 blob ${blob}\tf\n`)
  return await gitOk(gitDir, ['commit-tree', tree, '-m', 'f'])
}

/**
 * git's three-way merge of one file's content: `merge-tree --write-tree` with
 * an explicit merge base, over three single-file commits. Exit 0 is a clean
 * merge, exit 1 a conflict; anything else — or a merged tree that does not
 * hold the file — is `undefined`, never "clean".
 */
export async function gitThreeWayMerge(base: string, ours: string, theirs: string): Promise<MergeOutcome> {
  const dir = await mkdtemp(join(tmpdir(), 'queue-feed-merge-'))
  try {
    await gitOk(dir, ['init', '--bare', '--quiet', dir])
    const [b, o, t] = [await commitOf(dir, base), await commitOf(dir, ours), await commitOf(dir, theirs)]
    const r = await git(dir, ['merge-tree', '--write-tree', '--no-messages', `--merge-base=${b}`, o, t])
    if (r.code === 1) return { clean: false }
    if (r.code !== 0) return undefined
    const tree = r.stdout.split('\n')[0]?.trim() ?? ''
    if (!/^[0-9a-f]{40}$/.test(tree)) return undefined
    const merged = await git(dir, ['cat-file', 'blob', `${tree}:f`])
    return merged.code === 0 ? { clean: true, merged: merged.stdout } : undefined
  } catch {
    return undefined
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
