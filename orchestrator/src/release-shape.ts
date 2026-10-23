import { KNOPE_RELEASE_BRANCH } from './roles/release.js'

/**
 * Is this PR the knope release PR — decided from what the PR IS, never from
 * a label or a title (#1158 retired the label as a trigger; #1114 is what a
 * release PR that failed to get one looked like: a required `fleet/review`
 * that could never conclude).
 *
 * WHY A RELEASE PR CANNOT REACH GREEN OTHERWISE (measured on #1944, run
 * 39943449486): knope force-pushes the `release` branch on every `main`
 * merge, so every update is a `synchronize` onto a NEW tree. A push never
 * starts a review (fleet-review.yml invariant 2) and a PASS earned on another
 * tree covers nothing (#2014), so the gate concluded
 *   `fleet/review: FAILED — this head's tree (836170ff…) has no verdict: the
 *    last PASS was earned on fa241912…, a different tree`
 * — `tree-changed`, a red that clears only on a requested review. The
 * operator's standing ruling is that release PRs need no review at all, and
 * the gate has to say so with a real conclusion, not a skip (#844/#848).
 *
 * WHAT IT KEYS ON, and why each part cannot silently stop matching:
 *
 *  1. The head branch is `release` (`KNOPE_RELEASE_BRANCH`) — the one name
 *     `knope.toml`'s `prepare-release` workflow pushes. Necessary, never
 *     sufficient: anyone with push access can name a branch `release`, which
 *     is exactly why REVIEW_SKIP_AUTHORS refuses to key on a branch name.
 *  2. Every changed file is one `knope.toml` itself lists as a
 *     `versioned_files` entry, or its `changelog`. The list is READ from the
 *     base checkout's `knope.toml` — never copied here — so a versioned file
 *     added to knope is picked up with no edit to this file, and one this
 *     parser cannot read yields NO match (the ordinary gate, red as before),
 *     never a match against a stale list.
 *  3. The diff is a pure version swap: `package.json` carries exactly one
 *     `"version": "A"` → `"version": "B"` (semver, B > A), every other
 *     versioned file changes only by swapping A for B on lines that are
 *     otherwise byte-identical, and the changelog only gains lines. A PR on a
 *     branch named `release` that touches anything else — a dependency, a
 *     script, a workflow — fails (3) and gets the ordinary gate.
 *
 * Part (3) is what makes (1) safe to rely on: the diff this accepts contains
 * no executable change by construction, so there is nothing for a review to
 * read. Knope changing the SHAPE of its output makes this stop matching
 * LOUDLY — `tree-changed` again, with this module's reason in the log —
 * never quietly turn every PR green.
 */
export type ReleasePrShape =
  | { ok: true; from: string; to: string; files: string[] }
  | { ok: false; reason: string }

export interface ReleasePrInput {
  /** The PR's head branch (`FLEET_CI_BRANCH`). */
  branch: string
  /** `ciDiff` text — `git diff --full-index --no-color …`. */
  diff: string
  /** `ciChangedFiles` — cross-checked against the diff's own file list. */
  changedFiles: readonly string[]
  /** The BASE checkout's `knope.toml` text. */
  knopeToml: string
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

/** The paths `knope.toml`'s `[package]` lists as `versioned_files`. Empty
 *  when the array cannot be found or never closes — an empty list matches
 *  nothing, so an unreadable config fails toward the ordinary gate. */
export function knopeVersionedPaths(toml: string): string[] {
  const lines = toml.split('\n')
  const start = lines.findIndex((l) => /^\s*versioned_files\s*=\s*\[/.test(l))
  if (start < 0) return []
  const paths: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (line.startsWith(']')) return paths
    if (line.startsWith('#') || line.length === 0) continue
    const bare = /^"([^"]+)"/.exec(line)
    const tabled = /\bpath\s*=\s*"([^"]+)"/.exec(line)
    const path = bare?.[1] ?? tabled?.[1]
    if (path !== undefined) paths.push(path)
  }
  return [] // never closed: unreadable, not "these are all of them"
}

/** The `changelog = "…"` path, if the config names one. */
export function knopeChangelogPath(toml: string): string | undefined {
  return /^\s*changelog\s*=\s*"([^"]+)"/m.exec(toml)?.[1]
}

interface FileChange { path: string; removed: string[]; added: string[] }

/**
 * Splits a `git diff` into per-file removed/added lines. Returns a reason
 * string for anything that is not a plain in-place edit of an existing file —
 * a new, deleted, renamed, mode-changed or binary file has an extended header
 * line this refuses, because none of them is a version swap.
 */
function parseDiff(diff: string): FileChange[] | string {
  const out: FileChange[] = []
  let cur: FileChange | undefined
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      if (m === null || m[1] !== m[2]) return `unparseable or renaming diff header: ${line}`
      cur = { path: m[1] as string, removed: [], added: [] }
      out.push(cur)
      inHunk = false
      continue
    }
    if (cur === undefined) {
      if (line.length === 0) continue
      return `unexpected content before the first file header: ${line.slice(0, 80)}`
    }
    if (!inHunk) {
      if (line.startsWith('@@')) { inHunk = true; continue }
      // The only extended-header lines a plain edit of an existing file has.
      if (line.startsWith('index ') || line.startsWith('--- a/') || line.startsWith('+++ b/') || line.length === 0) continue
      return `${cur.path}: not a plain in-place edit (${line.slice(0, 80)})`
    }
    if (line.startsWith('@@')) continue
    if (line.startsWith('-')) cur.removed.push(line.slice(1))
    else if (line.startsWith('+')) cur.added.push(line.slice(1))
    // ' ' context and '\ No newline at end of file' carry no change.
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `line` with every standalone occurrence of `from` replaced by `to`, or
 *  `undefined` when `from` does not occur as a whole version. */
function swapVersion(line: string, from: string, to: string): string | undefined {
  const re = new RegExp(`(?<![\\d.])${escapeRe(from)}(?![\\d.])`, 'g')
  return re.test(line) ? line.replace(re, to) : undefined
}

function isGreater(to: RegExpExecArray, from: RegExpExecArray): boolean {
  for (let i = 1; i <= 3; i++) {
    const a = Number(to[i]), b = Number(from[i])
    if (a !== b) return a > b
  }
  return false
}

export function releasePrShape(input: ReleasePrInput): ReleasePrShape {
  const no = (reason: string): ReleasePrShape => ({ ok: false, reason })
  if (input.branch !== KNOPE_RELEASE_BRANCH) return no(`head branch is "${input.branch}", not "${KNOPE_RELEASE_BRANCH}"`)

  const versioned = knopeVersionedPaths(input.knopeToml)
  if (versioned.length === 0) return no('knope.toml names no readable versioned_files')
  const changelog = knopeChangelogPath(input.knopeToml)
  const allowed = new Set([...versioned, ...(changelog === undefined ? [] : [changelog])])

  const parsed = parseDiff(input.diff)
  if (typeof parsed === 'string') return no(parsed)
  const files = parsed.map((f) => f.path)
  if (files.length === 0) return no('the diff changes no file')
  if (new Set(files).size !== files.length) return no('a file appears twice in the diff')
  const listed = [...input.changedFiles].sort().join('\n')
  if (listed !== [...files].sort().join('\n')) return no('the changed-file list and the diff disagree about what changed')
  const stray = files.filter((p) => !allowed.has(p))
  if (stray.length > 0) return no(`touches files knope.toml does not version: ${stray.join(', ')}`)

  // The version pair comes from package.json, knope's first versioned file.
  const pkg = parsed.find((f) => f.path === 'package.json')
  if (pkg === undefined) return no('package.json is not in the diff, so there is no version bump to recognise')
  const pair = (side: string[]): string | undefined => {
    const hits = side.map((l) => /^\s*"version"\s*:\s*"([^"]+)",?\s*$/.exec(l)?.[1]).filter((v): v is string => v !== undefined)
    return side.length === 1 && hits.length === 1 ? hits[0] : undefined
  }
  const from = pair(pkg.removed)
  const to = pair(pkg.added)
  if (from === undefined || to === undefined) return no('package.json does not change exactly one "version" line')
  const fromM = SEMVER.exec(from), toM = SEMVER.exec(to)
  if (fromM === null || toM === null) return no(`"${from}" → "${to}" is not a plain X.Y.Z bump`)
  if (!isGreater(toM, fromM)) return no(`"${from}" → "${to}" does not raise the version`)

  for (const f of parsed) {
    if (f.path === changelog) {
      if (f.removed.length > 0) return no(`${f.path} loses ${f.removed.length} line(s); a release only adds to it`)
      continue
    }
    if (f.removed.length === 0 || f.removed.length !== f.added.length) {
      return no(`${f.path}: ${f.removed.length} removed vs ${f.added.length} added lines — not a version swap`)
    }
    for (let i = 0; i < f.removed.length; i++) {
      const swapped = swapVersion(f.removed[i] as string, from, to)
      if (swapped === undefined || swapped !== f.added[i]) {
        return no(`${f.path}: line "${(f.added[i] as string).trim().slice(0, 80)}" is not the removed line with ${from} → ${to}`)
      }
    }
  }
  return { ok: true, from, to, files }
}
