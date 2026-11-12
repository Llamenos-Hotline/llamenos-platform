/**
 * The diff a reviewer judges, as FILES it reads — never one block inlined
 * into its brief (#2726).
 *
 * What went wrong. Every reviewer prompt used to end in `## Diff` followed by
 * the whole diff. kimi receives its brief as a FILE (`-p @<file>`) and pages
 * through it with its `Read` tool, whose page is a 100,000-character budget;
 * on #2470 (+811/-313, a 2,755-line brief) that page ended at line 1,702, the
 * model never sent the continuation offset, and it judged ~62% of the diff.
 * #2728 made the gate NOTICE that (`brief-coverage.ts`) — it did not make a
 * large diff reviewable. Any brief that is one inlined blob grows with the
 * diff, so some diff is always one page too long, and the only "fix" left is
 * to raise a page limit or truncate, which reproduces the bug silently.
 *
 * What replaces it: the old-fashioned way. The engine has the diff (`git
 * diff` of the PR's range); it writes it out as numbered PART files, each
 * small enough to come back whole from ONE `Read` call on either engine, cut
 * at file and hunk boundaries. The brief carries only an index — which part
 * holds which files — so its length is bounded by the number of changed
 * files, not by the size of the change. The reviewer reads every part, and
 * the two exported trees beside them for context, exactly as a human reviewer
 * walks `git diff` file by file.
 *
 * And coverage stops being a claim. The gate wrote every part, so it knows
 * each one's exact line count; the engine's own stdout transcript records
 * every `Read` and every line it returned. `diffReadCoverage` derives, from
 * those two facts alone, whether every line of every part reached the model.
 * A verdict from a session that did not read all of it is discarded however
 * confident it sounds (`review.ts`, `'diff-unread'`), and a complete one is
 * published WITH its measured coverage, so the check says how much was read.
 *
 * Nothing here truncates. `reassembleReviewDiff` is the proof: the parts,
 * concatenated and unwrapped, are the input line for line, and the guard test
 * pins that on a diff far larger than the old page.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { linesOf, readableLineCount, readLinesByPath, sameLine } from './brief-coverage.js'

// ---------------------------------------------------------------------------
// The page every part must fit inside — measured, not chosen.
// ---------------------------------------------------------------------------

/** kimi 2.1.1's `Read` page: a 100,000-character budget per call (measured
 *  on the #2470 sessions — `Effective max_chars: 100000`). */
export const KIMI_READ_PAGE_CHARS = 100_000
/** claude's `Read` default: the first 2,000 lines of a file per call. */
export const CLAUDE_READ_PAGE_LINES = 2_000
/** claude's `Read` truncates any single line longer than this. */
export const CLAUDE_READ_LINE_CHARS = 2_000
/** Where #2470's brief was cut: the first line kimi's page did NOT return was
 *  1,703. The guard test builds a diff well past this to prove it is gone. */
export const OLD_BRIEF_PAGE_LINES = 1_702

// ---------------------------------------------------------------------------
// The part shape — comfortably inside every page above.
// ---------------------------------------------------------------------------

/** At most this many lines in one part file, header included. */
export const DIFF_PART_MAX_LINES = 600
/** At most this many characters in one part file, header included. Kept well
 *  under kimi's page even after `Read` prefixes every line with `<n>\t`, and
 *  well under claude's per-read token ceiling. */
export const DIFF_PART_MAX_CHARS = 40_000
/** A diff line longer than this is WRAPPED, never cut: the rest continues on
 *  following lines that start with `DIFF_LINE_CONTINUATION`. Below claude's
 *  own line truncation, so no `Read` ever drops the tail of a line. */
export const DIFF_LINE_MAX_CHARS = 1_000
/** Marks a wrapped line's continuation. No diff line, and no line of the
 *  locale summary, can start with it — so the wrap is unambiguous and
 *  `reassembleReviewDiff` undoes it exactly. */
export const DIFF_LINE_CONTINUATION = '↪ '

/** One part file: what the reviewer opens, and what the gate measures. */
export interface ReviewDiffPart {
  /** 1-based. */
  readonly index: number
  /** `part-001.diff`, … — sorts in reading order. */
  readonly name: string
  /** Absolute path the reviewer opens. */
  readonly path: string
  /** The file's whole content: one header line, then the diff lines. */
  readonly text: string
  /** `text`'s lines, counted the way both engines' `Read` counts them. */
  readonly lineCount: number
  /** First/last line of the (wrapped) review diff this part carries, 1-based. */
  readonly fromLine: number
  readonly toLine: number
  /** Files whose diff appears in this part, in order. */
  readonly files: readonly string[]
  /** The file whose diff was already running when this part began, if any —
   *  a big file split across parts says so in both. */
  readonly continues: string | undefined
}

export interface ReviewDiffPlan {
  /** The directory the parts live in — granted to the reviewer read-only. */
  readonly dir: string
  readonly parts: readonly ReviewDiffPart[]
  /** Lines of the review diff (locale summary included), after wrapping. */
  readonly totalLines: number
}

/** The two halves `compactReviewDiff` (review.ts) produces. Both are content
 *  the reviewer must read, so both go into parts. */
export interface ReviewDiffInput {
  readonly diff: string
  readonly summary: string
}

const SUMMARY_LABEL = '(locale value changes)'
const FILE_HEADER_RE = /^diff --git a\/(.*?) b\/(.*)$/

/** Splits one over-long line into `DIFF_LINE_MAX_CHARS` segments; every
 *  segment after the first carries the continuation marker. */
function wrapLine(line: string): string[] {
  if (line.length <= DIFF_LINE_MAX_CHARS) return [line]
  const room = DIFF_LINE_MAX_CHARS - DIFF_LINE_CONTINUATION.length
  const out = [line.slice(0, DIFF_LINE_MAX_CHARS)]
  for (let i = DIFF_LINE_MAX_CHARS; i < line.length; i += room) {
    out.push(DIFF_LINE_CONTINUATION + line.slice(i, i + room))
  }
  return out
}

function toLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

interface Unit { file: string; startsFile: boolean; lines: string[] }

/** File sections, then hunks within each: the boundaries a part may be cut at
 *  without splitting anything a reader needs in one piece. A unit larger than
 *  a whole part is cut by lines — rare, and named in both parts' index. */
function unitsOf(input: ReviewDiffInput): Unit[] {
  const units: Unit[] = []
  const summary = toLines(input.summary).flatMap(wrapLine)
  if (summary.length > 0) units.push({ file: SUMMARY_LABEL, startsFile: true, lines: summary })
  for (const section of input.diff.split(/(?=^diff --git )/m)) {
    const lines = toLines(section)
    if (lines.length === 0) continue
    const m = FILE_HEADER_RE.exec(lines[0] as string)
    const file = m !== null ? (m[2] as string) : '(diff preamble)'
    let current: string[] = []
    let first = true
    for (const line of lines) {
      if (line.startsWith('@@') && current.some((l) => l.startsWith('@@'))) {
        units.push({ file, startsFile: first, lines: current.flatMap(wrapLine) })
        current = []
        first = false
      }
      current.push(line)
    }
    units.push({ file, startsFile: first, lines: current.flatMap(wrapLine) })
  }
  return units
}

const headerFor = (index: number, count: number, from: number, to: number, total: number): string =>
  `# fleet/review diff part ${index} of ${count} — review-diff lines ${from}-${to} of ${total}`

/**
 * Pure: lays the review diff out as parts under `dir`. Writes nothing —
 * `writeReviewDiff` does — so the layout itself is testable without a disk.
 */
export function planReviewDiff(input: ReviewDiffInput, dir: string): ReviewDiffPlan {
  // A header is at most ~90 chars; reserve it so a full body plus its header
  // still fits the part ceiling.
  const HEADER_RESERVE = 120
  const maxBodyLines = DIFF_PART_MAX_LINES - 1
  const maxBodyChars = DIFF_PART_MAX_CHARS - HEADER_RESERVE

  interface Draft { lines: string[]; chars: number; files: string[]; continues: string | undefined }
  const drafts: Draft[] = []
  let cur: Draft = { lines: [], chars: 0, files: [], continues: undefined }
  let lastFile: string | undefined
  const flush = (): void => {
    if (cur.lines.length > 0) drafts.push(cur)
    cur = { lines: [], chars: 0, files: [], continues: undefined }
  }
  const add = (line: string, file: string, startsFile: boolean): void => {
    if (cur.lines.length === 0 && !startsFile && file === lastFile) cur.continues = file
    if (cur.files[cur.files.length - 1] !== file) cur.files.push(file)
    cur.lines.push(line)
    cur.chars += line.length + 1
    lastFile = file
  }
  const fits = (lines: number, chars: number): boolean =>
    cur.lines.length + lines <= maxBodyLines && cur.chars + chars <= maxBodyChars

  for (const unit of unitsOf(input)) {
    const chars = unit.lines.reduce((n, l) => n + l.length + 1, 0)
    if (!fits(unit.lines.length, chars)) flush()
    if (fits(unit.lines.length, chars)) {
      unit.lines.forEach((l, i) => add(l, unit.file, unit.startsFile && i === 0))
      continue
    }
    // Bigger than a whole part: cut by lines. Never by characters — every
    // line is already at most DIFF_LINE_MAX_CHARS, so a line always fits.
    unit.lines.forEach((l, i) => {
      if (!fits(1, l.length + 1)) flush()
      add(l, unit.file, unit.startsFile && i === 0)
    })
  }
  flush()

  const totalLines = drafts.reduce((n, d) => n + d.lines.length, 0)
  const width = Math.max(3, String(drafts.length).length)
  let from = 1
  const parts = drafts.map((d, i): ReviewDiffPart => {
    const index = i + 1
    const to = from + d.lines.length - 1
    const name = `part-${String(index).padStart(width, '0')}.diff`
    const text = `${headerFor(index, drafts.length, from, to, totalLines)}\n${d.lines.join('\n')}\n`
    const part: ReviewDiffPart = {
      index, name, path: join(dir, name), text, lineCount: readableLineCount(text),
      fromLine: from, toLine: to, files: d.files, continues: d.continues,
    }
    from = to + 1
    return part
  })
  return { dir, parts, totalLines }
}

/**
 * The inverse of `planReviewDiff`: the review diff's lines, recovered from the
 * parts alone. Exists so the guard test can prove the parts are the WHOLE
 * input — nothing dropped, nothing reordered, every wrapped line rejoined.
 */
export function reassembleReviewDiff(plan: ReviewDiffPlan): string[] {
  const out: string[] = []
  for (const part of plan.parts) {
    for (const line of toLines(part.text).slice(1)) {
      if (line.startsWith(DIFF_LINE_CONTINUATION) && out.length > 0) {
        out[out.length - 1] += line.slice(DIFF_LINE_CONTINUATION.length)
      } else {
        out.push(line)
      }
    }
  }
  return out
}

/** The lines `reassembleReviewDiff` must reproduce, for the same input. */
export function reviewDiffLines(input: ReviewDiffInput): string[] {
  return [...toLines(input.summary), ...toLines(input.diff)]
}

/** A plan written to disk; `cleanup` removes the directory and every part. */
export interface WrittenReviewDiff { plan: ReviewDiffPlan; cleanup(): Promise<void> }

/** Writes the parts into a fresh private directory — one per reviewer
 *  session, so concurrent reviewers of one export never share (or delete)
 *  each other's parts. */
export async function writeReviewDiff(input: ReviewDiffInput): Promise<WrittenReviewDiff> {
  const dir = await mkdtemp(join(tmpdir(), 'llamenos-review-diff-'))
  try {
    // mkdtemp creates the directory 0700 — private to this process's user.
    const plan = planReviewDiff(input, dir)
    for (const part of plan.parts) await writeFile(part.path, part.text, { mode: 0o600 })
    return { plan, cleanup: async () => { await rm(dir, { recursive: true, force: true }) } }
  } catch (e) {
    await rm(dir, { recursive: true, force: true })
    throw e
  }
}

/** The heading of the diff section in every reviewer brief. */
export const REVIEW_DIFF_HEADING = '## The diff'

/**
 * The brief's diff section: an INDEX of the parts, never their content. Its
 * length grows with the number of parts and files, not with the size of the
 * change — which is what keeps the brief inside one page however large the
 * diff gets.
 */
export function reviewDiffSection(plan: ReviewDiffPlan): string {
  if (plan.parts.length === 0) {
    return `${REVIEW_DIFF_HEADING}\n\nThis pull request's diff is EMPTY — there are no diff parts to read.`
  }
  const index = plan.parts.map((p) => {
    const files = p.files.map((f) => (f === p.continues ? `${f} (continued)` : f)).join(', ')
    return `- \`${p.path}\` — lines ${p.fromLine}-${p.toLine}: ${files}`
  }).join('\n')
  return `${REVIEW_DIFF_HEADING} — ${plan.parts.length} part${plan.parts.length === 1 ? '' : 's'}, ` +
    `${plan.totalLines} lines\n\n` +
    'The diff is NOT in this brief. It was split, at file and hunk boundaries, into the part files ' +
    `below, in a read-only directory (\`${plan.dir}\`). Each part is small enough to come back whole ` +
    'from ONE Read call with no offset or limit, so open each one exactly as listed.\n\n' +
    'Read EVERY part, in full, before you write a verdict. This is measured, not asked: the gate reads ' +
    'your own session transcript, and a review that was not returned every line of every part is ' +
    'discarded as incomplete, whatever its verdict says. Read the head and base trees above for any ' +
    'context a part does not give you.\n\n' +
    `Line 1 of each part is a header the gate wrote; the rest is the diff. A diff line longer than ` +
    `${DIFF_LINE_MAX_CHARS} characters is wrapped: a line starting with "${DIFF_LINE_CONTINUATION.trim()}" ` +
    'continues the line above it. Where a locale catalog changed, its value changes come first, ' +
    `labelled ${SUMMARY_LABEL}, in place of the raw patch.\n\n${index}`
}

// ---------------------------------------------------------------------------
// Coverage — derived from the transcript, never from what the model says.
// ---------------------------------------------------------------------------

export interface PartCoverage {
  readonly name: string
  readonly totalLines: number
  readonly linesRead: number
  /** Inclusive line ranges of this part no Read returned. */
  readonly missing: readonly (readonly [number, number])[]
}

export interface DiffCoverage {
  readonly parts: readonly PartCoverage[]
  readonly partsComplete: number
  readonly totalLines: number
  readonly linesRead: number
  /** True only when every line of every part was returned to the model. */
  readonly complete: boolean
}

function gaps(seen: ReadonlySet<number>, total: number): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = []
  let start: number | undefined
  for (let n = 1; n <= total + 1; n++) {
    const absent = n <= total && !seen.has(n)
    if (absent && start === undefined) start = n
    if (!absent && start !== undefined) { out.push([start, n - 1]); start = undefined }
  }
  return out
}

/**
 * Which lines of which parts the engine's stdout transcript proves were
 * returned to the model — kimi's and claude's stream-json envelopes both.
 */
export function diffReadCoverage(stdout: string, plan: ReviewDiffPlan): DiffCoverage {
  const byPath = new Map<string, Array<readonly [number, string]>>()
  for (const [p, lines] of readLinesByPath(stdout)) {
    const key = normalize(p)
    byPath.set(key, [...(byPath.get(key) ?? []), ...lines])
  }
  const parts = plan.parts.map((part): PartCoverage => {
    // A line is read only when the text returned under its number IS that
    // line of the part. The parts are PR content, so a bare number in a
    // result is something the PR itself could forge.
    const actual = linesOf(part.text)
    const seen = new Set((byPath.get(normalize(part.path)) ?? [])
      .filter(([n, text]) => n >= 1 && n <= part.lineCount && sameLine(text, actual[n - 1] as string))
      .map(([n]) => n))
    return { name: part.name, totalLines: part.lineCount, linesRead: seen.size, missing: gaps(seen, part.lineCount) }
  })
  const totalLines = parts.reduce((n, p) => n + p.totalLines, 0)
  const linesRead = parts.reduce((n, p) => n + p.linesRead, 0)
  const partsComplete = parts.filter((p) => p.missing.length === 0).length
  return { parts, partsComplete, totalLines, linesRead, complete: partsComplete === parts.length }
}

/** One sentence: how much of the diff the reviewer was shown, measured. Used
 *  both for a complete review (published beside the verdict) and for an
 *  incomplete one (the reason it was discarded). */
export function describeDiffCoverage(c: DiffCoverage): string {
  if (c.parts.length === 0) return 'the diff is empty, so there was nothing to read'
  const pct = c.totalLines === 0 ? 100 : Math.floor((c.linesRead / c.totalLines) * 100)
  const head = `read ${c.partsComplete} of ${c.parts.length} diff part${c.parts.length === 1 ? '' : 's'} in full ` +
    `(${c.linesRead} of ${c.totalLines} part lines, ${pct}%), measured from the session transcript`
  if (c.complete) return head
  const missing = c.parts.filter((p) => p.missing.length > 0).map((p) => p.linesRead === 0
    ? `${p.name} never opened`
    : `${p.name} lines ${p.missing.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ')} never returned`)
  return `${head}; ${missing.join('; ')}`
}
