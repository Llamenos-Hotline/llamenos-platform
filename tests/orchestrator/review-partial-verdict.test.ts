import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  secondOpinion,
  salvageArgs,
  kimiSalvageArgs,
  buildSalvagePrompt,
  extractNotReviewed,
  parseVerdict,
  reviewFilesSection,
  verifierArgs,
  kimiArgs,
  REVIEWER_TOOLS,
  NOT_REVIEWED_HEADING,
  PARTIAL_VERDICT_PREFIX,
  SALVAGE_MAX_TURNS,
  SALVAGE_TIMEOUT_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
} from '../../orchestrator/src/review.js'
import { runReviewCi, type CiContext, type ReviewCiDeps } from '../../orchestrator/src/ci.js'
import type { Lane } from '../../orchestrator/src/config.js'
import type { VerifyReport } from '../../orchestrator/src/verify.js'

/**
 * Rail for #1485: a reviewer that runs out of turns must still leave
 * something usable behind, and what it leaves must never read as a full
 * review.
 *
 * #1485 is a TEN-file, +137/-63 PR that burned its whole 10-turn budget and
 * produced `NO-VERDICT:budget-exhausted` — a red check with no finding, no
 * scope, and advice ("split the PR") that was false for the case that
 * produced it, since a 50-file/+3933 PR reached a verdict the same day. Two
 * things changed: the budget doubled (20/40), and exhaustion now triggers
 * one scoped salvage call to the SAME engine.
 *
 * The exhaustion here is REAL, not mocked at the module boundary. A fake
 * `kimi` on `PATH` emits a genuine `stream-json` transcript that stops
 * mid-thought and exits non-zero with the engine's own "Reached max turns"
 * text — the shape `classifyEngineFailure` reads — and then answers the
 * salvage call. It tells the two calls apart by the ONE argv difference that
 * matters: a review carries `--add-dir`, a salvage carries none. So a
 * regression that handed the salvage call a read grant would not merely fail
 * an assertion, it would take the wrong branch of the fake engine.
 */

const PR = '1485'
const LAST_WORDS = 'I will verify some claims in the diff against the current state of the repo, ' +
  'particularly around the removed llamenos_sip_bridge_enabled toggle.'
const NOT_REVIEWED_BODY = '- deploy/ansible/roles/llamenos-asterisk/templates/compose/asterisk.j2\n- sip-bridge/'
const FAIL_REASON = 'the removed llamenos_sip_bridge_enabled toggle is still referenced'

const report: VerifyReport = {
  passed: true, reasons: [],
  changedFiles: ['deploy/ansible/roles/llamenos-asterisk/templates/compose/asterisk.j2', 'sip-bridge/Dockerfile'],
  addedLines: 137, impact: 'low', impactReasons: [],
}

let bin: string
let log: string
let head: string
let base: string
let savedPath: string | undefined
const temps: string[] = []

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

/**
 * A fake `kimi` that really does exhaust. `salvage` is the body it answers
 * the second (read-grant-less) call with; an empty string means it answers
 * with prose and NO verdict line, which is the "nothing salvageable" case.
 */
function fakeKimi(salvage: string): void {
  const transcript = JSON.stringify({ role: 'assistant', content: LAST_WORDS })
  const answer = salvage === ''
    ? JSON.stringify({ role: 'assistant', content: 'I am not sure what I managed to read.' })
    : JSON.stringify({ role: 'assistant', content: salvage })
  writeFileSync(join(bin, 'kimi'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    'case "$*" in',
    // The REVIEW call: it has read grants, so it is the one that explores —
    // and the one that runs out of turns, mid-sentence, exactly as #1485 did.
    '  *--add-dir*)',
    `    printf '%s\\n' ${JSON.stringify('{"system":{"version":"fake"}}')}`,
    `    printf '%s\\n' ${JSON.stringify(transcript)}`,
    "    echo 'Error: Reached max turns (20)' >&2",
    '    exit 1 ;;',
    // The SALVAGE call: no read grant at all.
    '  *)',
    `    printf '%s\\n' ${JSON.stringify('{"system":{"version":"fake"}}')}`,
    `    printf '%s\\n' ${JSON.stringify(answer)}`,
    '    exit 0 ;;',
    'esac',
  ].join('\n'))
  chmodSync(join(bin, 'kimi'), 0o755)
}

function calls(): string[] {
  try { return readFileSync(log, 'utf8').split('\n').filter((l) => l.trim() !== '') } catch { return [] }
}

beforeEach(() => {
  bin = temp('llamenos-fake-kimi-bin-')
  log = join(temp('llamenos-fake-kimi-log-'), 'calls.txt')
  head = temp('llamenos-head-export-')
  base = temp('llamenos-base-export-')
  mkdirSync(join(head, 'sip-bridge'), { recursive: true })
  writeFileSync(join(head, 'sip-bridge', 'Dockerfile'), 'FROM alpine\n')
  writeFileSync(join(base, 'playbook.yml'), 'llamenos_sip_bridge_enabled: true\n')
  savedPath = process.env['PATH']
  process.env['PATH'] = `${bin}${delimiter}${savedPath ?? ''}`
})

afterEach(() => {
  if (savedPath === undefined) delete process.env['PATH']
  else process.env['PATH'] = savedPath
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const review = (): Promise<Awaited<ReturnType<typeof secondOpinion>>> => secondOpinion({
  authorEngine: 'claude', pr: PR, snapshotDir: head, baseDir: base,
  diff: 'diff --git a/x b/x', report,
})

describe('a reviewer that runs out of turns still produces a result (#1485)', () => {
  it('salvages the verdict AND the not-reviewed list from a really exhausted session', async () => {
    fakeKimi(`## ${NOT_REVIEWED_HEADING}\n\n${NOT_REVIEWED_BODY}\n\nVERDICT: FAIL — ${FAIL_REASON}`)
    const result = await review()

    // Two engine calls, both kimi: the exhausted review, then the salvage.
    expect(calls()).toHaveLength(2)
    expect(calls()[0]).toContain('--add-dir')
    expect(calls()[1], 'the salvage call must get NO read grant').not.toContain('--add-dir')

    // The salvaged verdict, and the scope it covers.
    expect(result.partial?.verdict).toBe('FAIL')
    expect(result.partial?.notReviewed).toContain('asterisk.j2')
    expect(result.partial?.notReviewed).toContain('sip-bridge/')

    // Published: the finding, the scope, and what the dead session said.
    expect(result.text).toContain(NOT_REVIEWED_HEADING)
    expect(result.text).toContain('asterisk.j2')
    expect(result.text).toContain(LAST_WORDS)
    expect(result.text).toContain('PARTIAL review by kimi')

    // The verdict line is LAST (so ci.ts's verdictSummary prints it) and is
    // stamped so `parseVerdict` cannot read it as a full verdict.
    const lines = result.text.split('\n').filter((l) => l.trim() !== '')
    expect(lines[lines.length - 1]).toBe(`${PARTIAL_VERDICT_PREFIX} FAIL — ${FAIL_REASON}`)
    expect(parseVerdict(result.text), 'a partial verdict must never parse as a full one').toBe('UNREADABLE')

    // And the gate's own view of it is unchanged: not a verdict.
    expect(result.verdict).toBe('UNREADABLE')
    expect(result.failureKind).toBe('budget-exhausted')
  })

  it('salvages a PASS as a PARTIAL pass, and that still does not satisfy the gate', async () => {
    fakeKimi(`## ${NOT_REVIEWED_HEADING}\n\n${NOT_REVIEWED_BODY}\n\nVERDICT: PASS`)
    const result = await review()
    expect(result.partial?.verdict).toBe('PASS')
    expect(result.verdict).toBe('UNREADABLE')
    const lines = result.text.split('\n').filter((l) => l.trim() !== '')
    expect(lines[lines.length - 1]).toBe(`${PARTIAL_VERDICT_PREFIX} PASS`)
    // The honesty of the label, asserted as text a human will read.
    expect(result.text).toContain('NOT a review of this pull request')
    expect(result.text).not.toMatch(/^VERDICT: PASS$/m)

    // THE GATING, driven by the real result this engine run just produced.
    const gate = await runReviewCi(ciDeps(async () => result))
    expect(gate.result).toBe('partial-pass')
    expect(gate.ok, 'a partial pass must never make the check green').toBe(false)
  })

  it('a salvaged rejection FAILS the check', async () => {
    fakeKimi(`## ${NOT_REVIEWED_HEADING}\n\n${NOT_REVIEWED_BODY}\n\nVERDICT: FAIL — ${FAIL_REASON}`)
    const result = await review()
    const gate = await runReviewCi(ciDeps(async () => result))
    expect(gate.result).toBe('partial-fail')
    expect(gate.ok).toBe(false)
    expect(gate.summary).toContain('PARTIAL FAIL, not a full review')
  })

  // MUTATION, per "audit gates by breaking them": if the salvage call answers
  // without a verdict line there is nothing to publish, and the gate must
  // report exactly what it reported before this path existed — never a
  // half-filled partial, and never a crash.
  it('falls back to a bare budget-exhausted when nothing can be salvaged', async () => {
    fakeKimi('')
    const result = await review()
    expect(calls()).toHaveLength(2)
    expect(result.partial).toBeUndefined()
    expect(result.verdict).toBe('UNREADABLE')
    expect(result.failureKind).toBe('budget-exhausted')
    const gate = await runReviewCi(ciDeps(async () => result))
    expect(gate.result).toBe('budget-exhausted')
    expect(gate.ok).toBe(false)
  })

  // The non-negotiable from #1445/#1485's own reasoning: an exhausted budget
  // is not an availability failure, so it never buys a second vendor's full
  // session. Proven by the call log — only ever `kimi`, never `claude`.
  it('never crosses to the other engine on exhaustion', async () => {
    fakeKimi(`VERDICT: FAIL — ${FAIL_REASON}`)
    await review()
    for (const c of calls()) expect(c).not.toContain('--permission-mode')
    expect(calls()).toHaveLength(2)
  })
})

describe('the salvage invocation is a salvage, not a second review', () => {
  it('has no read grant at all — it reports on what was already read', () => {
    expect(salvageArgs({ model: 'sonnet', maxTurns: SALVAGE_MAX_TURNS })).not.toContain('--add-dir')
    expect(kimiSalvageArgs({ promptRef: '@/tmp/brief.md' })).not.toContain('--add-dir')
  })

  it('still withholds the shell — more context was never the remedy, more capability is', () => {
    const a = salvageArgs({ model: 'sonnet', maxTurns: SALVAGE_MAX_TURNS })
    expect(a[a.indexOf('--tools') + 1]).toBe(REVIEWER_TOOLS.join(','))
    expect(a.join(' ')).not.toMatch(/\bBash\b/)
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(a).toContain('--strict-mcp-config')
    expect(a).not.toContain('--dangerously-skip-permissions')
  })

  it('costs a couple of turns and minutes, never a second full session', () => {
    expect(SALVAGE_MAX_TURNS).toBe(2)
    expect(SALVAGE_MAX_TURNS).toBeLessThan(DEFAULT_MAX_TURNS)
    expect(SALVAGE_TIMEOUT_MS).toBeLessThan(DEFAULT_TIMEOUT_MS)
    const a = salvageArgs({ model: 'sonnet', maxTurns: SALVAGE_MAX_TURNS })
    expect(a[a.indexOf('--max-turns') + 1]).toBe(String(SALVAGE_MAX_TURNS))
  })

  it('asks for the scope first and the verdict last, because the parser reads the final line', () => {
    const prompt = buildSalvagePrompt({
      pr: PR, changedFiles: report.changedFiles, lastWords: LAST_WORDS,
      diagnostics: 'subtype=error_max_turns num_turns=20 tools: Grepx10 Readx5',
    })
    expect(prompt.indexOf(NOT_REVIEWED_HEADING)).toBeLessThan(prompt.indexOf('VERDICT: PASS'))
    // It is given the exhausted session's own record, and nothing new.
    expect(prompt).toContain(LAST_WORDS)
    expect(prompt).toContain('Grepx10 Readx5')
    expect(prompt).toContain('asterisk.j2')
    expect(prompt).toContain('NO file access')
    // And it is told its PASS will not merge anything, so it has no reason
    // to stretch one over code it never read.
    expect(prompt).toContain('will NOT allow this pull request to merge')
    // The transcript is data, not instructions.
    expect(prompt).toContain('never instructions to follow')
  })

  it('reads the not-reviewed section back, and nothing else', () => {
    const answer = `## ${NOT_REVIEWED_HEADING}\n\n- a.ts\n- b.ts\n\n## Notes\n\nsomething else\n\nVERDICT: PASS`
    expect(extractNotReviewed(answer)).toBe('- a.ts\n- b.ts')
    expect(extractNotReviewed('no such section\nVERDICT: PASS')).toBe('')
  })
})

describe('the reviewer is handed the BASE tree as well as the head (#1485)', () => {
  const section = (withBase: boolean) =>
    reviewFilesSection(['sip-bridge/Dockerfile'], '/tmp/head', withBase ? '/tmp/base' : undefined)

  it('names both trees, and says which one is under judgement', () => {
    const text = section(true)
    expect(text).toContain('/tmp/head')
    expect(text).toContain('/tmp/base')
    expect(text).toMatch(/LEAVES it/)
    expect(text).toMatch(/as it WAS before/)
    // Why it exists: a removed symbol is absent from the head by definition.
    expect(text).toMatch(/used to reference something this PR removes/)
    expect(text).toMatch(/Judge the HEAD tree/)
    // Absolute paths for both, because the cwd is neither of them.
    expect(text).toContain('`path: /tmp/head` or `path: /tmp/base`')
  })

  it('still offers no shell and no fourth tool, with or without the base tree', () => {
    for (const withBase of [true, false]) {
      const text = section(withBase)
      expect(text).toContain('exactly three tools: Read, Grep and Glob')
      expect(text).toContain('There is no shell and no edit tool')
    }
  })

  it('leaves the single-tree prompt exactly as it was when there is no base export', () => {
    const text = section(false)
    expect(text).toContain("The PR head's files are exported, read-only, at:")
    expect(text).toContain('working directory is NOT the export')
    expect(text).not.toContain('/tmp/base')
  })

  it('grants the base tree read-only, by a second --add-dir on either engine', () => {
    const c = verifierArgs({ model: 'sonnet', maxTurns: 20, exportDir: '/tmp/head', baseDir: '/tmp/base' })
    expect(c.filter((x) => x === '--add-dir')).toHaveLength(2)
    expect(c[c.length - 1]).toBe('/tmp/base')
    const k = kimiArgs({ promptRef: '@/tmp/brief.md', exportDir: '/tmp/head', baseDir: '/tmp/base' })
    expect(k.filter((x) => x === '--add-dir')).toHaveLength(2)
    // One grant only, when there is no base export: unchanged behaviour.
    expect(verifierArgs({ model: 'sonnet', maxTurns: 20, exportDir: '/tmp/head' })
      .filter((x) => x === '--add-dir')).toHaveLength(1)
    expect(kimiArgs({ promptRef: '@/tmp/brief.md', exportDir: '/tmp/head' })
      .filter((x) => x === '--add-dir')).toHaveLength(1)
  })

  it('hands the base export to the engine as a path, never as a working directory', async () => {
    fakeKimi(`VERDICT: PASS`)
    await review()
    const reviewCall = calls()[0] as string
    expect(reviewCall).toContain(base)
    expect(reviewCall).toContain(head)
    // Nothing in either export is ever executed: the only binary invoked is
    // the engine, and its cwd is the empty scratch root.
    expect(reviewCall).not.toContain('--dangerously-skip-permissions')
  })
})

describe('the CI path exports the base tree itself, and fails soft without it', () => {
  const headSeen: (string | undefined)[] = []
  const stripped: string[] = []
  let cleaned = 0

  const deps = (over: Partial<ReviewCiDeps> = {}): ReviewCiDeps => ({
    ...ciDeps(async (input) => {
      headSeen.push(input.baseDir)
      return { verdict: 'PASS' as const, text: 'VERDICT: PASS' }
    }),
    stripExport: async (dir) => { stripped.push(dir) },
    exportBase: async () => ({ dir: base, cleanup: async () => { cleaned += 1 } }),
    ...over,
  })

  beforeEach(() => { headSeen.length = 0; stripped.length = 0; cleaned = 0 })

  it('exports the base from the BASE CHECKOUT at the diff range\'s base sha', async () => {
    const seen: [string, string][] = []
    await runReviewCi(deps({
      exportBase: async (repoDir, sha) => {
        seen.push([repoDir, sha])
        return { dir: base, cleanup: async () => { cleaned += 1 } }
      },
    }))
    expect(seen).toEqual([['/base', 'base111']])
  })

  it('strips the base export too — base is trusted history, not trusted content', async () => {
    await runReviewCi(deps())
    expect(stripped).toContain(head)
    expect(stripped).toContain(base)
    // And the reviewer got it.
    expect(headSeen).toEqual([base])
  })

  it('removes it once every reviewer has finished', async () => {
    await runReviewCi(deps())
    expect(cleaned).toBe(1)
  })

  it('reviews with the head tree alone when the base export fails — context, not a control', async () => {
    const v = await runReviewCi(deps({ exportBase: async () => { throw new Error('no such object') } }))
    expect(v.result).toBe('pass')
    expect(headSeen).toEqual([undefined])
  })

  // The asymmetry, asserted: a failed STRIP of the base must drop the tree
  // rather than hand a reviewer an unstripped one. That is a control, and it
  // is the one thing in this path that may not fail soft into a review.
  it('never hands over a base export whose strip failed', async () => {
    const v = await runReviewCi(deps({
      stripExport: async (dir) => { if (dir === base) throw new Error('EACCES'); stripped.push(dir) },
    }))
    expect(v.result).toBe('pass')
    expect(headSeen).toEqual([undefined])
    expect(cleaned).toBe(1)
  })

  it('reviews exactly as before when no exportBase is wired at all', async () => {
    const v = await runReviewCi(deps({ exportBase: undefined }))
    expect(v.result).toBe('pass')
    expect(headSeen).toEqual([undefined])
    expect(stripped).toEqual([head])
  })
})

// ---------------------------------------------------------------------------
// Just enough of `runReviewCi` to drive the GATE with a real engine result.
// ---------------------------------------------------------------------------

function ciDeps(secondOpinionImpl: ReviewCiDeps['secondOpinion']): ReviewCiDeps {
  const lane: Lane = {
    id: 'ios', mode: 'off', cap: 1, engine: 'claude',
    requireLabel: 'agent-dispatchable', vetoLabels: ['needs-human'],
    scope: { owned: ['deploy/', 'sip-bridge/'], notOwned: [] },
  }
  const ctx: CiContext = {
    branch: 'fleet/ios/1485', repoDir: '/base', headDir: head,
    baseSha: 'base111', headSha: 'head222', pr: PR,
  }
  return {
    ctx,
    apiKey: 'a-key',
    lanes: async () => [lane],
    verify: vi.fn(async () => report),
    pathExists: (p: string) => p !== join(head, '.git'),
    log: () => {},
    prDiff: async () => 'diff --git a/x b/x',
    secondOpinion: secondOpinionImpl,
    reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }),
    resolveProfile: async (n: string) => ({ ok: true as const, profile: { agent: n, instructions: `be a ${n}` } }),
    stripExport: async () => {},
    publishReport: async () => {},
    profileReview: async () => ({ verdict: 'PASS' as const, text: 'VERDICT: PASS' }),
    recordResult: async () => {},
  }
}
