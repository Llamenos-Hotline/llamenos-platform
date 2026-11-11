import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  briefReadCoverage,
  describeIncompleteRead,
  readableLineCount,
} from '../../orchestrator/src/brief-coverage.js'
import { canFallbackAfterFailure, invokeVerifierEngine } from '../../orchestrator/src/review.js'

/**
 * #2726 — "the review engine cannot read past line 1702 of its brief".
 *
 * What was measured (kimi 2.1.1 session logs from the 2026-11-10 reviews of
 * #2470): the `Read` tool pages by a 100,000-CHARACTER budget, which on that
 * 2,755-line brief is exactly 1,702 lines. It does NOT ignore the offset —
 * sibling sessions on 2,755/2,778-line briefs sent `line_offset: 1703` and got
 * lines 1,703-2,755 back in one call. The failing session's raw tool calls were
 * `{"path":"…brief.md"}` seven times: the model said it would pass the offset
 * and never did. The API is fine; the invocation was the defect, and it was
 * invisible to the gate because a model that stops after 62% of a diff can
 * still write `VERDICT: PASS`.
 *
 * Every transcript below uses the REAL stdout envelope (captured from
 * `kimi --output-format stream-json`): assistant `tool_calls[].function.
 * arguments`, then a `role: "tool"` result whose content is `<n>\t<line>`.
 */

const BRIEF_PATH = '/tmp/llamenos-review-brief-0123456789abcdef.md'
const PAGE_CHARS = 100_000 // kimi's default Read budget

/** A brief longer than one page: ~2,800 lines of ~50 chars. */
function longBrief(lines = 2800): string {
  return Array.from({ length: lines }, (_, i) => `brief line ${i + 1}: ${'x'.repeat(40)}`).join('\n') + '\n'
}

/** What kimi's `Read` returns for `line_offset`: whole lines until the char budget is spent. */
function readPage(text: string, lineOffset: number, maxChars = PAGE_CHARS): string {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const out: string[] = []
  let chars = 0
  for (let n = lineOffset; n <= lines.length; n++) {
    const rendered = `${n}\t${lines[n - 1]}`
    if (out.length > 0 && chars + rendered.length + 1 > maxChars) break
    out.push(rendered)
    chars += rendered.length + 1
  }
  return out.join('\n')
}

/** The number of the last line a rendered page returned. */
function lastLineNo(page: string): number {
  const m = /^(\d+)\t/.exec(page.split('\n').at(-1) ?? '')
  if (m === null) throw new Error('page has no numbered last line')
  return Number(m[1])
}

let nextId = 0
function readCall(path: string, args: Record<string, unknown>): { id: string; line: string } {
  const id = `tool_${nextId++}`
  return {
    id,
    line: JSON.stringify({ role: 'assistant', tool_calls: [{ type: 'function', id, function: { name: 'Read', arguments: JSON.stringify({ path, ...args }) } }] }),
  }
}
function transcript(steps: Array<{ args: Record<string, unknown>; result: string; path?: string }>): string {
  const out: string[] = [JSON.stringify({ role: 'meta', type: 'system.version', version: '2.1.1' })]
  for (const s of steps) {
    const call = readCall(s.path ?? BRIEF_PATH, s.args)
    out.push(call.line, JSON.stringify({ role: 'tool', tool_call_id: call.id, content: s.result }))
  }
  out.push(JSON.stringify({ role: 'assistant', content: 'VERDICT: PASS' }))
  return out.join('\n')
}

describe('readableLineCount — counts lines the way kimi Read does', () => {
  it('does not count the empty remainder after a trailing newline', () => {
    expect(readableLineCount('a\nb\n')).toBe(2)
    expect(readableLineCount('a\nb')).toBe(2)
    expect(readableLineCount('a\n\nb\n')).toBe(3)
    expect(readableLineCount('')).toBe(0)
  })
})

describe('briefReadCoverage — what the transcript proves was read', () => {
  const brief = longBrief()

  it('the brief really is longer than one page (a fix verified on a short brief proves nothing)', () => {
    expect(brief.length).toBeGreaterThan(PAGE_CHARS)
    const firstPage = readPage(brief, 1)
    const last = lastLineNo(firstPage)
    expect(last, 'page one must stop short of the end of the brief').toBeLessThan(readableLineCount(brief))
  })

  it('#2470\'s failure: seven Reads with no line_offset, each restarting at line 1 -> incomplete, named', () => {
    const page = readPage(brief, 1)
    const t = transcript(Array.from({ length: 7 }, () => ({ args: {}, result: page })))
    const c = briefReadCoverage(t, BRIEF_PATH, brief)
    expect(c.complete).toBe(false)
    expect(c.reads).toHaveLength(7)
    const lastRead = lastLineNo(page)
    expect(c.missing).toEqual([[lastRead + 1, readableLineCount(brief)]])
    const said = describeIncompleteRead(c)
    expect(said).toContain(`${c.linesRead} of ${c.totalLines}`)
    expect(said).toMatch(/7 Read calls sent no line_offset and each restarted at line 1/)
  })

  it('following the Next Read hint (line_offset) reads everything -> complete', () => {
    const first = readPage(brief, 1)
    const next = lastLineNo(first) + 1
    const c = briefReadCoverage(transcript([
      { args: {}, result: first },
      { args: { line_offset: next, max_chars: PAGE_CHARS }, result: readPage(brief, next) },
    ]), BRIEF_PATH, brief)
    expect(c.complete).toBe(true)
    expect(c.missing).toEqual([])
    expect(c.linesRead).toBe(c.totalLines)
  })

  it('one Read with a larger max_chars also counts as complete', () => {
    const c = briefReadCoverage(transcript([{ args: { max_chars: 500_000 }, result: readPage(brief, 1, 500_000) }]), BRIEF_PATH, brief)
    expect(c.complete).toBe(true)
  })

  it('an offset that is sent but not honoured is reported as exactly that', () => {
    const page = readPage(brief, 1)
    const c = briefReadCoverage(transcript([
      { args: {}, result: page },
      { args: { line_offset: 1703 }, result: page }, // answered from line 1
    ]), BRIEF_PATH, brief)
    expect(c.complete).toBe(false)
    expect(describeIncompleteRead(c)).toContain('asked for line_offset 1703 and were answered from line 1')
  })

  it('a brief the model never opened is incomplete, not "nothing to check"', () => {
    const c = briefReadCoverage(transcript([]), BRIEF_PATH, brief)
    expect(c.complete).toBe(false)
    expect(c.linesRead).toBe(0)
    expect(describeIncompleteRead(c)).toContain('never read')
  })

  it('reads of OTHER files never count toward the brief', () => {
    const c = briefReadCoverage(transcript([
      { args: {}, path: '/somewhere/else.ts', result: readPage(brief, 1, 10_000_000) },
    ]), BRIEF_PATH, brief)
    expect(c.linesRead).toBe(0)
    expect(c.complete).toBe(false)
  })

  it('a tab inside a source line is not mistaken for a line number', () => {
    const tabbed = 'one\n7\tlooks like a numbered line\nthree\n'
    const c = briefReadCoverage(transcript([{ args: {}, result: readPage(tabbed, 1) }]), BRIEF_PATH, tabbed)
    expect(c.complete).toBe(true)
    expect(c.linesRead).toBe(3)
  })

  it('tolerates non-JSON lines in stdout', () => {
    const t = `not json\n${transcript([{ args: {}, result: readPage(brief, 1, 500_000) }])}\n{broken`
    expect(briefReadCoverage(t, BRIEF_PATH, brief).complete).toBe(true)
  })
})

describe('canFallbackAfterFailure — brief-unread crosses to the other engine', () => {
  it('crosses even when the diagnostics happen to contain auth-shaped words', () => {
    expect(canFallbackAfterFailure('brief-unread', 'diff mentions 401 unauthorized')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// End to end through invokeVerifierEngine, with a fake kimi that pages exactly
// like the real Read tool and a fake claude. The ONLY difference between the
// runs below is whether the fake model sends the continuation offset.
// ---------------------------------------------------------------------------

/** `kimi` stand-in. Emulates `-p @<file>`: the model Reads the brief with the
 *  100,000-char page budget. mode "diligent" follows `Next Read`; mode
 *  "forgetful" repeats the offset-less call (the #2470 session) then still
 *  writes a PASS. The mode lives in a file beside the binary because the gate
 *  hands the engine an allowlisted environment. */
const FAKE_KIMI = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const argv = process.argv.slice(2)
const ref = argv[argv.indexOf('-p') + 1]
const briefPath = ref.slice(1)
const mode = fs.readFileSync(path.join(__dirname, 'mode'), 'utf8').trim()
const text = fs.readFileSync(briefPath, 'utf8')
const lines = text.split('\\n'); if (lines[lines.length - 1] === '') lines.pop()
function page(offset) {
  const out = []; let chars = 0
  for (let n = offset; n <= lines.length; n++) {
    const r = n + '\\t' + lines[n - 1]
    if (out.length > 0 && chars + r.length + 1 > 100000) break
    out.push(r); chars += r.length + 1
  }
  return out
}
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let id = 0
function read(args) {
  const tid = 'tool_' + id++
  emit({ role: 'assistant', tool_calls: [{ type: 'function', id: tid, function: { name: 'Read', arguments: JSON.stringify({ path: briefPath, ...args }) } }] })
  const p = page(args.line_offset || 1)
  emit({ role: 'tool', tool_call_id: tid, content: p.join('\\n') })
  return Number(p[p.length - 1].split('\\t')[0])
}
emit({ role: 'meta', type: 'system.version', version: '2.1.1' })
let last = read({})
if (mode === 'diligent') { while (last < lines.length) last = read({ line_offset: last + 1, max_chars: 100000 }) }
else { for (let i = 0; i < 6; i++) read({}) }
emit({ role: 'assistant', content: 'Reviewed.\\nVERDICT: PASS' })
`

/** `claude` stand-in: takes the brief on stdin (no pages) and passes. */
const FAKE_CLAUDE = `#!/usr/bin/env bash
cat >/dev/null
printf '{"type":"result","subtype":"success","num_turns":1,"result":"VERDICT: PASS"}\\n'
`

let scratch: string
let binDir: string
let exportDir: string
const saved: Record<string, string | undefined> = {}

function setEnv(k: string, v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k]
  if (v === undefined) delete process.env[k]; else process.env[k] = v
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'llamenos-brief-coverage-'))
  binDir = join(scratch, 'bin')
  exportDir = join(scratch, 'export')
  mkdirSync(binDir)
  mkdirSync(exportDir)
  writeFileSync(join(exportDir, 'file.ts'), 'export const x = 1\n')
  writeFileSync(join(binDir, 'kimi'), FAKE_KIMI)
  writeFileSync(join(binDir, 'claude'), FAKE_CLAUDE)
  chmodSync(join(binDir, 'kimi'), 0o755)
  chmodSync(join(binDir, 'claude'), 0o755)
  setEnv('PATH', `${binDir}${delimiter}${process.env['PATH'] ?? ''}`)
  setEnv('HOME', join(scratch, 'home'))
  mkdirSync(join(scratch, 'home'))
  setEnv('FLEET_REVIEW_PRIMARY', 'kimi')
  setEnv('FLEET_REVIEW_FALLBACK', 'on')
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  for (const k of Object.keys(saved)) delete saved[k]
  rmSync(scratch, { recursive: true, force: true })
})

function review(mode: 'diligent' | 'forgetful') {
  writeFileSync(join(binDir, 'mode'), mode)
  return invokeVerifierEngine({
    authorEngine: 'claude', exportDir, prompt: longBrief(), maxTurns: 1, timeoutMs: 60_000,
  })
}

describe('invokeVerifierEngine — a kimi review that did not read the whole brief is not a review (#2726)', () => {
  it('control: a reviewer that follows the continuation is accepted, on kimi', async () => {
    const run = await review('diligent')
    expect(run.reached, run.diagnostics).toBe(true)
    expect(run.engine).toBe('kimi')
    expect(run.fallbackFor).toBeUndefined()
  })

  it('a reviewer that stops at page one is discarded and the claude fallback carries the review', async () => {
    const run = await review('forgetful')
    expect(run.reached, run.diagnostics).toBe(true)
    expect(run.engine).toBe('claude')
    expect(run.fallbackFor).toBe('kimi')
  })

  it('with no fallback it is LOUD: unreachable, the PASS it wrote is dropped, and the lines are named', async () => {
    setEnv('FLEET_REVIEW_FALLBACK', 'off')
    const run = await review('forgetful')
    expect(run.reached).toBe(false)
    expect(run.failureKind).toBe('brief-unread')
    expect(run.assistantText, 'the verdict from a partial read must not survive').toBe('')
    expect(run.diagnostics).toMatch(/did not read the whole brief: the reviewer read \d+ of 2800 brief lines/)
    expect(run.diagnostics).toMatch(/Read calls sent no line_offset and each restarted at line 1/)
  })
})
