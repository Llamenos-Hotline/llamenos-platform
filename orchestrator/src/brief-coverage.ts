/**
 * Did the reviewer actually READ the whole brief? (#2726)
 *
 * The kimi reviewer receives its brief as `-p @<file>`: the whole prompt is a
 * path, and the model fetches the content itself with kimi's `Read` tool. That
 * tool is paged by a CHARACTER budget — 100,000 chars per call by default, which
 * on a real diff is ~1,700 lines — not by the file. A brief longer than one
 * page arrives as page one plus a `Next Read: {"line_offset": N}` hint, and it is
 * the MODEL's job to send that offset back.
 *
 * Measured on #2470 (2,755-line brief, 2026-11-10): the `Read` tool was fine.
 * Two sibling sessions on 2,755/2,778-line briefs followed the hint and got
 * lines 1,703–2,755 back in one call. The failing session's raw tool calls were
 * `{"path":"…brief.md"}` seven times over — the model wrote "I must pass
 * line_offset=1703" in its reasoning and then emitted arguments without it, so
 * every call returned page one. The harness did not drop the offset; the model
 * never sent it.
 *
 * That session refused to guess and said so. The next one might not: a model
 * that has read 62% of a diff and writes `VERDICT: PASS` is indistinguishable,
 * in the verdict line, from one that read all of it. So the gate must not take
 * the model's word for what it read. The engine's own stdout transcript lists
 * every `Read` call and every result, and the brief is a file the gate wrote and
 * so knows the exact length of — coverage is a fact the gate can derive, not a
 * claim it has to trust.
 *
 * This module is that derivation. It is pure (a transcript and the brief text
 * in, a report out) so it can be pinned by tests without an engine.
 */

/** What the transcript proves about the reviewer's reading of the brief. */
export interface BriefCoverage {
  /** Lines in the brief file, counted the way kimi's `Read` counts them. */
  readonly totalLines: number
  /** How many distinct brief lines a `Read` result actually returned. */
  readonly linesRead: number
  /** Every `Read` of the brief file, in order. */
  readonly reads: readonly BriefRead[]
  /** Inclusive `[from, to]` ranges of brief lines no `Read` returned. */
  readonly missing: readonly (readonly [number, number])[]
  /** True only when every line of the brief was returned to the model. */
  readonly complete: boolean
}

export interface BriefRead {
  /** The `line_offset` the MODEL sent, or undefined if it sent none. */
  readonly requestedOffset: number | undefined
  /** The first line number the result actually started at, if it returned any. */
  readonly startedAt: number | undefined
  /** The last line number the result returned, if it returned any. */
  readonly endedAt: number | undefined
}

/**
 * Lines in `text` as kimi's `Read` reports them: one per `\n`-terminated line,
 * plus a final unterminated one. A trailing newline does NOT add an empty line
 * (verified against kimi 2.1.1: a 2,801-line file with a trailing newline reads
 * as `Total lines in file: 2801`).
 */
export function readableLineCount(text: string): number {
  if (text === '') return 0
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return text.endsWith('\n') ? n : n + 1
}

/** The shape of one kimi `--output-format stream-json` line this reads. Every
 *  field is optional: an unrecognised line is skipped, never an error. */
interface KimiEvent {
  role?: unknown
  tool_call_id?: unknown
  content?: unknown
  tool_calls?: unknown
}

function parseEvents(stdout: string): KimiEvent[] {
  const events: KimiEvent[] = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      const v: unknown = JSON.parse(t)
      if (v !== null && typeof v === 'object') events.push(v as KimiEvent)
    } catch { /* not an event line */ }
  }
  return events
}

/** A tool result's text, whether the envelope carries a string or text parts. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      const text = (part as { text?: unknown } | null)?.text
      return typeof text === 'string' ? text : ''
    }).join('\n')
  }
  return ''
}

/** One rendered line as either engine's `Read` returns it: `<n>\t<text>`
 *  (both, as measured) or `<n>→<text>` (older claude builds), after optional
 *  padding. Deliberately NOT a multiline regex: JS `^` under the `m` flag also
 *  matches after `\r`, U+2028 and U+2029, all of which can sit INSIDE one
 *  physical line of PR-controlled content — so a crafted line could otherwise
 *  forge a "line N was returned" record. Results are split on `\n` only. */
const NUMBERED_LINE_RE = /^ *(\d+)(?:\t|\u2192)(.*)$/s

/** The `[lineNumber, text]` pairs a `Read` result rendered, split on `\n`
 *  only — the one line separator both engines' `Read` uses. */
export function numberedLines(content: unknown): Array<readonly [number, string]> {
  const out: Array<readonly [number, string]> = []
  for (const line of contentText(content).split('\n')) {
    const m = NUMBERED_LINE_RE.exec(line)
    if (m !== null) out.push([Number(m[1]), m[2] as string])
  }
  return out
}

/** What the coverage checks compare a returned line against: a `\r` (a CRLF
 *  file) or trailing whitespace an engine may normalise away says nothing
 *  about WHICH line was shown, so neither may turn a real read into a miss. */
export function sameLine(returned: string, actual: string): boolean {
  const norm = (x: string): string => x.replace(/[\r\u2028\u2029]/g, '').trimEnd()
  return norm(returned) === norm(actual)
}

/** `text`'s physical lines, 1-based, as `Read` numbers them. */
export function linesOf(text: string): string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Derives, from kimi's own stdout transcript, which lines of `briefText` (the
 * file at `briefPath`) were returned to the model.
 *
 * What it cannot see, stated rather than hidden: the stdout envelope carries
 * the result text but not kimi's `<system>` status block, so a SINGLE line
 * longer than the character budget — returned as a fragment — still counts as
 * read once its first fragment arrives. A diff line over 100,000 chars is
 * outside anything this repo produces (locale catalogs are summarised, lockfile
 * lines are short); the failure this guards is the page boundary, which is
 * visible line-by-line.
 */
export function briefReadCoverage(stdout: string, briefPath: string, briefText: string): BriefCoverage {
  const totalLines = readableLineCount(briefText)
  const actual = linesOf(briefText)
  const pending = new Map<string, number | undefined>()
  const seen = new Set<number>()
  const reads: BriefRead[] = []

  for (const ev of parseEvents(stdout)) {
    if (ev.role === 'assistant' && Array.isArray(ev.tool_calls)) {
      for (const call of ev.tool_calls as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) {
        if (call.function?.name !== 'Read' || typeof call.id !== 'string') continue
        let args: { path?: unknown; line_offset?: unknown }
        try { args = JSON.parse(String(call.function.arguments)) as typeof args } catch { continue }
        if (args.path !== briefPath) continue
        pending.set(call.id, typeof args.line_offset === 'number' ? args.line_offset : undefined)
      }
    } else if (ev.role === 'tool' && typeof ev.tool_call_id === 'string' && pending.has(ev.tool_call_id)) {
      const requestedOffset = pending.get(ev.tool_call_id)
      pending.delete(ev.tool_call_id)
      let startedAt: number | undefined
      let endedAt: number | undefined
      for (const [n, text] of numberedLines(ev.content)) {
        // A line counts only if the text returned under its number IS that
        // line of the brief — the brief carries the PR's own description, so
        // a number alone is something the PR could forge.
        if (n < 1 || n > totalLines || !sameLine(text, actual[n - 1] as string)) continue
        startedAt ??= n
        endedAt = n
        seen.add(n)
      }
      reads.push({ requestedOffset, startedAt, endedAt })
    }
  }

  const missing: Array<readonly [number, number]> = []
  let runStart: number | undefined
  for (let n = 1; n <= totalLines + 1; n++) {
    const absent = n <= totalLines && !seen.has(n)
    if (absent && runStart === undefined) runStart = n
    if (!absent && runStart !== undefined) { missing.push([runStart, n - 1]); runStart = undefined }
  }

  return { totalLines, linesRead: seen.size, reads, missing, complete: missing.length === 0 }
}

/**
 * The sentence an UNREADABLE verdict carries when the brief was not fully read.
 * It names the lines, and — when the transcript shows it — the mechanism, so
 * the person reading a red check does not have to open a session log to learn
 * that the cause was an omitted `line_offset` rather than a broken tool.
 */
export function describeIncompleteRead(c: BriefCoverage): string {
  const pct = c.totalLines === 0 ? 0 : Math.floor((c.linesRead / c.totalLines) * 100)
  const gaps = c.missing.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ')
  const head = c.reads.length === 0
    ? `the reviewer never read the ${c.totalLines}-line brief (no Read of it appears in the transcript)`
    : `the reviewer read ${c.linesRead} of ${c.totalLines} brief lines (${pct}%); lines ${gaps} were never returned to it`
  const restarts = c.reads.filter((r) => r.requestedOffset === undefined && r.startedAt === 1).length
  const mechanism = restarts >= 2
    ? ` ${restarts} Read calls sent no line_offset and each restarted at line 1 — the continuation argument was never sent`
    : ''
  // The OTHER way a continuation can fail, and the one the reviewer on #2470
  // believed it was seeing: an offset was sent and the tool answered from
  // somewhere else. Reported as a fact when it happens, never inferred.
  const ignored = c.reads.filter((r) => r.requestedOffset !== undefined && r.startedAt !== r.requestedOffset)
  const anomaly = ignored.length === 0 ? '' : ` ${ignored.length} Read call(s) asked for line_offset ${
    ignored.map((r) => r.requestedOffset).join(', ')} and were answered from line ${
    ignored.map((r) => r.startedAt ?? 'none').join(', ')} — the offset was not honoured`
  return `${head}.${mechanism}${anomaly}`
}

/** claude `--output-format stream-json` shapes this reads (verified against
 *  the installed binary): an `assistant` event whose `message.content` holds
 *  `{type:"tool_use", id, name:"Read", input:{file_path, offset?, limit?}}`,
 *  then a `user` event whose `message.content` holds
 *  `{type:"tool_result", tool_use_id, content}` — the content rendered as
 *  `<n>\t<line>`, the same numbering kimi's `Read` uses. */
interface ClaudeContentItem {
  type?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
}

function claudeItems(ev: Record<string, unknown>): ClaudeContentItem[] {
  const msg = ev['message']
  if (msg === null || typeof msg !== 'object') return []
  const content = (msg as { content?: unknown }).content
  return Array.isArray(content)
    ? content.filter((c): c is ClaudeContentItem => c !== null && typeof c === 'object')
    : []
}

/**
 * Every file the transcript shows a `Read` of, mapped to the numbered lines
 * (number AND text) its results actually returned — for EITHER engine's stream-json envelope, told
 * apart by shape. A call with no matching result (a crash mid-call) and a
 * result with no numbered lines (an error such as "file too large") both
 * contribute nothing: only a line the model was shown counts as read.
 */
export function readLinesByPath(stdout: string): Map<string, Array<readonly [number, string]>> {
  const pending = new Map<string, string>()
  const out = new Map<string, Array<readonly [number, string]>>()
  const record = (path: string, content: unknown): void => {
    const lines = out.get(path) ?? []
    lines.push(...numberedLines(content))
    out.set(path, lines)
  }
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    let ev: Record<string, unknown>
    try {
      const v: unknown = JSON.parse(t)
      if (v === null || typeof v !== 'object') continue
      ev = v as Record<string, unknown>
    } catch { continue }

    // kimi: tool_calls on an assistant message, then a role:"tool" result.
    if (ev['role'] === 'assistant' && Array.isArray(ev['tool_calls'])) {
      for (const call of ev['tool_calls'] as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) {
        if (call.function?.name !== 'Read' || typeof call.id !== 'string') continue
        let args: { path?: unknown }
        try { args = JSON.parse(String(call.function.arguments)) as typeof args } catch { continue }
        if (typeof args.path === 'string') pending.set(call.id, args.path)
      }
      continue
    }
    if (ev['role'] === 'tool' && typeof ev['tool_call_id'] === 'string') {
      const path = pending.get(ev['tool_call_id'])
      if (path !== undefined) { pending.delete(ev['tool_call_id']); record(path, ev['content']) }
      continue
    }

    // claude: tool_use items in an assistant message, tool_result items in a user one.
    if (ev['type'] === 'assistant') {
      for (const item of claudeItems(ev)) {
        if (item.type !== 'tool_use' || item.name !== 'Read' || typeof item.id !== 'string') continue
        const input = item.input as { file_path?: unknown } | undefined
        if (typeof input?.file_path === 'string') pending.set(item.id, input.file_path)
      }
    } else if (ev['type'] === 'user') {
      for (const item of claudeItems(ev)) {
        if (item.type !== 'tool_result' || typeof item.tool_use_id !== 'string') continue
        const path = pending.get(item.tool_use_id)
        if (path !== undefined) { pending.delete(item.tool_use_id); record(path, item.content) }
      }
    }
  }
  return out
}
