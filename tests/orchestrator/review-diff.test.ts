import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  CLAUDE_READ_LINE_CHARS, CLAUDE_READ_PAGE_LINES, DIFF_LINE_CONTINUATION, KIMI_READ_PAGE_CHARS, OLD_BRIEF_PAGE_LINES,
  describeDiffCoverage, diffReadCoverage, planReviewDiff, reassembleReviewDiff, reviewDiffLines,
  type ReviewDiffPlan,
} from '../../orchestrator/src/review-diff.js'
import { buildReviewPrompt, invokeVerifierEngine, toSecondOpinion } from '../../orchestrator/src/review.js'
import { readableLineCount } from '../../orchestrator/src/brief-coverage.js'
import { composeReviewSet } from '../../orchestrator/src/ci.js'
import { checkRunConclusion } from '../../orchestrator/src/review-and-merge.js'
import type { VerifyReport } from '../../orchestrator/src/verify.js'

/**
 * #2726 — "the review engine cannot paginate past ~line 1702 of its brief".
 *
 * The brief used to END in the whole diff, so its length grew with the diff
 * and some diff was always one page too long for the reviewer's `Read`. The
 * diff is now written out as PART files, each of which comes back whole from
 * one `Read` on either engine, and the brief only indexes them. These tests are
 * the guard: on a diff far past the old page they prove
 *
 *   1. nothing is dropped — the parts reassemble to the input, line for line;
 *   2. every part fits one page of BOTH engines' `Read`, measured against the
 *      page limits as constants, so shrinking a page below a part fails here;
 *   3. the brief stays inside one page however large the diff gets;
 *   4. coverage is measured: a reviewer that reads every part passes, and one
 *      that skips any part — even one line — is discarded and fails the check
 *      (#2725: an incomplete review must never conclude `success`).
 */

/** A diff well past every old limit: many files, one giant hunk, a minified
 *  line longer than claude's line truncation, and a long tail. */
function largeDiff(): string {
  const out: string[] = []
  for (let f = 0; f < 30; f++) {
    out.push(`diff --git a/apps/worker/file-${f}.ts b/apps/worker/file-${f}.ts`, 'index 1111111..2222222 100644',
      `--- a/apps/worker/file-${f}.ts`, `+++ b/apps/worker/file-${f}.ts`)
    for (let h = 0; h < 3; h++) {
      out.push(`@@ -${h * 40 + 1},20 +${h * 40 + 1},24 @@ export function f${f}_${h}() {`)
      for (let l = 0; l < 24; l++) out.push(`${l % 3 === 0 ? '+' : l % 3 === 1 ? '-' : ' '}  const v${f}_${h}_${l} = compute(${'a'.repeat(30)}) // ${f}:${h}:${l}`)
    }
  }
  // One file whose single hunk is larger than a whole part.
  out.push('diff --git a/apps/worker/huge.ts b/apps/worker/huge.ts', 'new file mode 100644', '--- /dev/null', '+++ b/apps/worker/huge.ts', '@@ -0,0 +1,1500 @@')
  for (let l = 0; l < 1500; l++) out.push(`+export const huge${l} = ${'"' + 'z'.repeat(60) + '"'} // tail-marker-${l}`)
  // A minified line, far longer than claude's per-line truncation.
  out.push('diff --git a/site/min.js b/site/min.js', '--- a/site/min.js', '+++ b/site/min.js', '@@ -1 +1 @@',
    '-var a=1', `+${Array.from({ length: 700 }, (_, i) => `v${i}=${i * 7}`).join(';')};END-OF-MINIFIED-LINE`)
  return `${out.join('\n')}\n`
}

const SUMMARY = '## Locale value changes (locale patches omitted)\n\n### de\n+ "a.b" = "neu"\n'

function rendered(text: string): string {
  return text.split('\n').filter((_, i, a) => i < a.length - 1 || a[i] !== '').map((l, i) => `${i + 1}\t${l}`).join('\n')
}

const report = (files: string[]): VerifyReport => ({
  passed: true, reasons: [], changedFiles: files, addedLines: 1, impact: 'low', impactReasons: [],
})

describe('planReviewDiff — a diff past the old page is laid out whole, in pages that fit (#2726)', () => {
  const diff = largeDiff()
  const input = { diff, summary: SUMMARY }
  const plan = planReviewDiff(input, '/review-diff')

  it('the fixture really is past every old limit', () => {
    expect(readableLineCount(diff)).toBeGreaterThan(OLD_BRIEF_PAGE_LINES * 2)
    expect(diff.length).toBeGreaterThan(KIMI_READ_PAGE_CHARS * 2)
    expect(plan.parts.length).toBeGreaterThan(3)
  })

  it('drops nothing: the parts reassemble to the input, line for line', () => {
    const want = reviewDiffLines(input)
    const got = reassembleReviewDiff(plan)
    expect(got.length).toBe(want.length)
    expect(got).toEqual(want)
    expect(got.at(-1)).toContain('END-OF-MINIFIED-LINE')
    expect(got).toContain('+export const huge1499 = "' + 'z'.repeat(60) + '" // tail-marker-1499')
  })

  it('every part comes back whole from ONE Read on either engine', () => {
    for (const part of plan.parts) {
      // claude: the first CLAUDE_READ_PAGE_LINES lines, each up to CLAUDE_READ_LINE_CHARS.
      expect(part.lineCount, part.name).toBeLessThanOrEqual(CLAUDE_READ_PAGE_LINES)
      for (const line of part.text.split('\n')) expect(line.length, part.name).toBeLessThanOrEqual(CLAUDE_READ_LINE_CHARS)
      // kimi: a character budget over the RENDERED page (`<n>\t` per line).
      expect(rendered(part.text).length, part.name).toBeLessThanOrEqual(KIMI_READ_PAGE_CHARS)
    }
  })

  it('wraps an over-long line instead of letting a Read truncate it', () => {
    const wrapped = plan.parts.flatMap((p) => p.text.split('\n')).filter((l) => l.startsWith(DIFF_LINE_CONTINUATION))
    expect(wrapped.length).toBeGreaterThan(0)
  })

  it('numbers parts and lines contiguously, and names a file that spans parts', () => {
    let next = 1
    for (const part of plan.parts) {
      expect(part.fromLine).toBe(next)
      next = part.toLine + 1
    }
    expect(next - 1).toBe(plan.totalLines)
    expect(plan.parts.some((p) => p.continues === 'apps/worker/huge.ts')).toBe(true)
    expect(plan.parts[0]!.files[0]).toBe('(locale value changes)')
  })

  it('the brief indexes the parts and stays inside one page however big the diff is', () => {
    const files = Array.from({ length: 30 }, (_, f) => `apps/worker/file-${f}.ts`)
    const brief = buildReviewPrompt('2470', plan, report(files), '/export/head', '/export/base')
    for (const part of plan.parts) expect(brief).toContain(part.path)
    expect(brief).not.toContain('tail-marker-')
    expect(readableLineCount(brief)).toBeLessThan(OLD_BRIEF_PAGE_LINES)
    expect(rendered(brief).length).toBeLessThan(KIMI_READ_PAGE_CHARS)
    // Four times the diff grows the brief by the index only.
    const bigger = planReviewDiff({ diff: diff.repeat(4), summary: '' }, '/review-diff')
    const biggerBrief = buildReviewPrompt('2470', bigger, report(files), '/export/head', '/export/base')
    expect(biggerBrief.length - brief.length).toBeLessThan(diff.length / 10)
  })
})

// ---------------------------------------------------------------------------
// Measured coverage, end to end through invokeVerifierEngine, with fake
// engines whose `Read` pages exactly like the real ones.
// ---------------------------------------------------------------------------

/** `kimi` stand-in. Reads the brief (`-p @<file>`), then the part paths the
 *  brief lists, with the real 100,000-char page and NO offset ever sent —
 *  the #2470 session's exact behaviour. Mode "skip-last" never opens the last
 *  part; mode "skip-line" gets a page cut one line short of the first part. */
const FAKE_KIMI = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const argv = process.argv.slice(2)
const brief = argv[argv.indexOf('-p') + 1].slice(1)
const mode = fs.readFileSync(path.join(__dirname, 'mode'), 'utf8').trim()
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let id = 0
function read(p, cut) {
  const lines = fs.readFileSync(p, 'utf8').split('\\n'); if (lines[lines.length - 1] === '') lines.pop()
  const out = []; let chars = 0
  for (let n = 1; n <= lines.length - (cut || 0); n++) {
    const r = n + '\\t' + lines[n - 1]
    if (out.length > 0 && chars + r.length + 1 > 100000) break
    out.push(r); chars += r.length + 1
  }
  const tid = 'tool_' + id++
  emit({ role: 'assistant', tool_calls: [{ type: 'function', id: tid, function: { name: 'Read', arguments: JSON.stringify({ path: p }) } }] })
  emit({ role: 'tool', tool_call_id: tid, content: out.join('\\n') })
}
emit({ role: 'meta', type: 'system.version', version: '2.1.1' })
read(brief)
const parts = [...fs.readFileSync(brief, 'utf8').matchAll(/\`(\\/[^\`]*\\/part-\\d+\\.diff)\`/g)].map((m) => m[1])
fs.writeFileSync(path.join(__dirname, 'parts-seen'), String(parts.length))
parts.forEach((p, i) => {
  if (mode === 'skip-last' && i === parts.length - 1) return
  read(p, mode === 'skip-line' && i === 0 ? 1 : 0)
})
emit({ role: 'assistant', content: 'Reviewed.\\nVERDICT: PASS' })
`

/** `claude` stand-in for the fallback arm: reads nothing and passes — the
 *  shape of a reviewer that answers from the brief alone. */
const FAKE_CLAUDE = `#!/usr/bin/env bash
cat >/dev/null
printf '{"type":"result","subtype":"success","num_turns":1,"result":"VERDICT: PASS"}\\n'
`

describe('invokeVerifierEngine — coverage is measured on the parts, and incomplete fails (#2726, #2725)', () => {
  let scratch: string
  let binDir: string
  let exportDir: string
  const saved: Record<string, string | undefined> = {}
  const setEnv = (k: string, v: string | undefined): void => {
    if (!(k in saved)) saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'llamenos-review-diff-test-'))
    binDir = join(scratch, 'bin')
    exportDir = join(scratch, 'export')
    mkdirSync(binDir)
    mkdirSync(exportDir)
    mkdirSync(join(scratch, 'home'))
    writeFileSync(join(binDir, 'kimi'), FAKE_KIMI)
    writeFileSync(join(binDir, 'claude'), FAKE_CLAUDE)
    chmodSync(join(binDir, 'kimi'), 0o755)
    chmodSync(join(binDir, 'claude'), 0o755)
    setEnv('PATH', `${binDir}${delimiter}${process.env['PATH'] ?? ''}`)
    setEnv('HOME', join(scratch, 'home'))
    setEnv('FLEET_REVIEW_PRIMARY', 'kimi')
    setEnv('FLEET_REVIEW_FALLBACK', 'on')
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    for (const k of Object.keys(saved)) delete saved[k]
    rmSync(scratch, { recursive: true, force: true })
  })

  function review(mode: 'all' | 'skip-last' | 'skip-line') {
    writeFileSync(join(binDir, 'mode'), mode)
    return invokeVerifierEngine({
      authorEngine: 'claude', exportDir, diff: largeDiff(), maxTurns: 1, timeoutMs: 60_000,
      brief: (parts) => buildReviewPrompt('2470', parts, report(['apps/worker/huge.ts']), exportDir),
    })
  }

  it('a reviewer that never sends an offset still reads the WHOLE large diff — and says how much it read', async () => {
    const run = await review('all')
    expect(run.reached, run.diagnostics).toBe(true)
    expect(run.engine).toBe('kimi')
    expect(run.coverage?.complete).toBe(true)
    const result = toSecondOpinion(run)
    expect(result.verdict).toBe('PASS')
    expect(result.text).toMatch(/^reviewed by kimi — read (\d+) of \1 diff parts in full \(\d+ of \d+ part lines, 100%\)/)
  })

  it.each(['skip-last', 'skip-line'] as const)('a reviewer that misses any of it (%s) is discarded, and the check FAILS', async (mode) => {
    const run = await review(mode)
    // kimi's PASS is dropped; the fallback claude read nothing, so it is dropped too.
    expect(run.reached).toBe(false)
    expect(run.failureKind).toBe('diff-unread')
    expect(run.assistantText, 'a verdict from a partial read must not survive').toBe('')
    expect(run.diagnostics).toMatch(/kimi did not read the whole diff: read \d+ of \d+ diff parts in full/)
    expect(run.diagnostics).toMatch(mode === 'skip-last' ? /never opened/ : /never returned/)
    const result = toSecondOpinion(run)
    expect(result.verdict).toBe('UNREADABLE')
    // #2725: whatever produces the check, an incomplete review is a failure.
    const composed = composeReviewSet(['general'], [{ status: 'fulfilled', value: result }])
    expect(composed.ok).toBe(false)
    expect(composed.verdict).toBe('UNREADABLE')
    expect(composed.summary).toMatch(/did not read the whole diff/)
    expect(checkRunConclusion(composed.verdict)).toBe('failure')
  })
})

describe('diffReadCoverage — reads the claude envelope as well as kimi\'s', () => {
  const plan: ReviewDiffPlan = planReviewDiff({ diff: largeDiff(), summary: '' }, '/parts')
  const claudeRead = (path: string, text: string, id: string, cut = 0): string[] => {
    const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop()
    return [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: lines.slice(0, lines.length - cut).map((l, i) => `${i + 1}\t${l}`).join('\n') }] } }),
    ]
  }

  it('complete only when every part was returned in full', () => {
    const all = plan.parts.flatMap((p, i) => claudeRead(p.path, p.text, `t${i}`)).join('\n')
    expect(diffReadCoverage(all, plan).complete).toBe(true)
    const short = plan.parts.flatMap((p, i) => claudeRead(p.path, p.text, `t${i}`, i === 2 ? 5 : 0)).join('\n')
    const c = diffReadCoverage(short, plan)
    expect(c.complete).toBe(false)
    expect(describeDiffCoverage(c)).toContain(`${plan.parts[2]!.name} lines`)
  })

  it('a Read answered with an error (no numbered lines) counts as nothing read', () => {
    const errs = plan.parts.map((p, i) => [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `e${i}`, name: 'Read', input: { file_path: p.path } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `e${i}`, is_error: true, content: 'File content exceeds maximum allowed tokens' }] } }),
    ].join('\n')).join('\n')
    const c = diffReadCoverage(errs, plan)
    expect(c.linesRead).toBe(0)
    expect(c.complete).toBe(false)
  })
})
