/**
 * Rails for scripts/lib/test-reporter.sh (#2494): a step's reported result must
 * be derived from THAT step's own output, and a step with no result must never
 * read as a pass.
 *
 * The defect these exist for: parse_playwright_results took `tail -1` over the
 * cumulative run log, so a green project that ran after a red one was reported
 * as "N failed". A single-project fixture cannot catch that, which is why every
 * attribution test here runs at least two steps, the red one first.
 *
 *   bun test scripts/lib/test-reporter.test.ts
 *
 * Each test drives the real library through bash with its own TMPDIR, so runs
 * never share a log, and reads the JSON summary the library writes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const LIBRARY = resolve(import.meta.dir, 'test-reporter.sh')

interface Suite {
  name: string
  status: 'ok' | 'error'
  passed: number | null
  failed: number | null
  skipped: number | null
  reason: string | null
}
interface Summary {
  result: 'pass' | 'fail'
  suites: Suite[]
}
interface Run {
  exitCode: number
  stderr: string
  summary: Summary | null
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'test-reporter-rail-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** Playwright's own summary blocks (list/line reporter, non-TTY). */
const RED_PROJECT = [
  'Running 5 tests using 3 workers',
  '  ✘  1 [backend-bdd] › a.feature:3:1 › breaks (12ms)',
  '  1) [backend-bdd] › a.feature:3:1 › breaks',
  '    Error: expect(received).toBe(expected)',
  '  2 failed',
  '    [backend-bdd] › a.feature:3:1 › breaks',
  '    [backend-bdd] › a.feature:9:1 › also breaks',
  '  3 passed (4.1s)',
].join('\n')
const GREEN_PROJECT = ['Running 7 tests using 3 workers', '  7 passed (2.0s)'].join('\n')

/** A bash-literal for printf, so fixture text needs no shell quoting. */
function emit(text: string, exit = 0): string {
  return `bash -c ${shq(`printf '%s\\n' ${shq(text)}; exit ${exit}`)}`
}
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/**
 * Runs `body` after sourcing the library and `reporter_init`, then
 * `reporter_summary pass` (unless the body already exits). REPORTER_TIMEOUT is
 * left at a long value on purpose: the timeout-warning watcher sleeps for 80%
 * of it, and if it ever again outlives its step while holding stdout, this
 * piped spawn blocks for minutes and the test times out.
 */
function runReporter(body: string, platform = 'rail'): Run {
  const script = [
    'set -euo pipefail',
    `source ${shq(LIBRARY)}`,
    `reporter_init ${shq(platform)}`,
    body,
    'reporter_summary pass',
  ].join('\n')
  const proc = Bun.spawnSync(['bash', '-c', script], {
    env: { ...process.env, TMPDIR: tmp, JSON_OUTPUT: 'true', REPORTER_TIMEOUT: '600' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const runDirs = readdirSync(tmp).filter((d) => d.startsWith(`test-${platform}-`))
  let summary: Summary | null = null
  if (runDirs.length === 1) {
    try {
      summary = JSON.parse(readFileSync(join(tmp, runDirs[0], 'summary.json'), 'utf8')) as Summary
    } catch {
      summary = null
    }
  }
  return { exitCode: proc.exitCode ?? -1, stderr: proc.stderr.toString(), summary }
}

function suite(run: Run, name: string): Suite {
  const s = run.summary?.suites.find((x) => x.name === name)
  if (!s) throw new Error(`no suite ${name} in ${JSON.stringify(run.summary)}\nstderr: ${run.stderr}`)
  return s
}

describe('a step is reported from its own output', () => {
  test('a passing project after a failing one is reported as passed', () => {
    const run = runReporter(`
      reporter_run_step "first" ${emit(RED_PROJECT, 1)} || true
      reporter_record_step_results "first" playwright
      reporter_run_step "second" ${emit(GREEN_PROJECT)} || true
      reporter_record_step_results "second" playwright
    `)
    expect(suite(run, 'first')).toMatchObject({ status: 'ok', passed: 3, failed: 2, skipped: 0 })
    expect(suite(run, 'second')).toMatchObject({ status: 'ok', passed: 7, failed: 0, skipped: 0 })
  })

  test('a failing project after a passing one keeps its own failures', () => {
    const run = runReporter(`
      reporter_run_step "green" ${emit(GREEN_PROJECT)} || true
      reporter_record_step_results "green" playwright
      reporter_run_step "red" ${emit(RED_PROJECT, 1)} || true
      reporter_record_step_results "red" playwright
    `)
    expect(suite(run, 'green')).toMatchObject({ status: 'ok', passed: 7, failed: 0 })
    expect(suite(run, 'red')).toMatchObject({ status: 'ok', passed: 3, failed: 2 })
  })

  test('recording out of order still attributes each result to its own step', () => {
    const run = runReporter(`
      reporter_run_step "first" ${emit(RED_PROJECT, 1)} || true
      reporter_run_step "second" ${emit(GREEN_PROJECT)} || true
      reporter_record_step_results "second" playwright
      reporter_record_step_results "first" playwright
    `)
    expect(suite(run, 'first')).toMatchObject({ passed: 3, failed: 2 })
    expect(suite(run, 'second')).toMatchObject({ passed: 7, failed: 0 })
  })

  test('cargo results are scoped to their step too', () => {
    const run = runReporter(`
      reporter_run_step "unit" ${emit('test result: FAILED. 4 passed; 1 failed; 2 ignored; 0 measured', 101)} || true
      reporter_record_step_results "unit" cargo
      reporter_run_step "interop" ${emit('test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured')} || true
      reporter_record_step_results "interop" cargo
    `)
    expect(suite(run, 'unit')).toMatchObject({ status: 'ok', passed: 4, failed: 1, skipped: 2 })
    expect(suite(run, 'interop')).toMatchObject({ status: 'ok', passed: 9, failed: 0, skipped: 0 })
  })

  test('every Playwright summary category is read, coloured or not', () => {
    const esc = '\u001b'
    const block = [
      `${esc}[31m  1 failed${esc}[39m`,
      '    [p] › x',
      '  1 interrupted',
      '  2 flaky',
      '  3 skipped',
      '  1 did not run',
      `${esc}[32m  5 passed${esc}[39m${esc}[2m (1.2m)${esc}[22m`,
    ].join('\n')
    const run = runReporter(`
      reporter_run_step "all" ${emit(block, 1)} || true
      reporter_record_step_results "all" playwright
    `)
    // flaky → passed, interrupted → failed, did not run → skipped
    expect(suite(run, 'all')).toMatchObject({ status: 'ok', passed: 7, failed: 2, skipped: 4 })
  })

  test('test output that merely mentions "N passed" is not taken for the summary', () => {
    const noisy = ['Running 2 tests', '[step] the volunteer saw "3 failed" attempts', 'log: 12 passed checks', '  2 passed (1s)'].join('\n')
    const run = runReporter(`
      reporter_run_step "noisy" ${emit(noisy)} || true
      reporter_record_step_results "noisy" playwright
    `)
    expect(suite(run, 'noisy')).toMatchObject({ status: 'ok', passed: 2, failed: 0 })
  })
})

describe('an absent result never reads as a pass', () => {
  test('a project with no output is an error, and the run fails', () => {
    const run = runReporter(`
      reporter_run_step "silent" true || true
      reporter_record_step_results "silent" playwright
    `)
    const s = suite(run, 'silent')
    expect(s.status).toBe('error')
    expect(s.passed).toBeNull()
    expect(s.failed).toBeNull()
    expect(s.reason).toContain('printed nothing')
    expect(run.summary?.result).toBe('fail')
    expect(run.exitCode).not.toBe(0)
  })

  test('output without a summary (crash before the runner reported) is an error', () => {
    const run = runReporter(`
      reporter_run_step "crashed" ${emit('Error: No tests found', 1)} || true
      reporter_record_step_results "crashed" playwright
    `)
    expect(suite(run, 'crashed')).toMatchObject({ status: 'error', passed: null })
    expect(run.summary?.result).toBe('fail')
  })

  test('a silent project after a green one does not inherit the green result', () => {
    const run = runReporter(`
      reporter_run_step "green" ${emit(GREEN_PROJECT)} || true
      reporter_record_step_results "green" playwright
      reporter_run_step "silent" true || true
      reporter_record_step_results "silent" playwright
    `)
    expect(suite(run, 'green')).toMatchObject({ status: 'ok', passed: 7 })
    expect(suite(run, 'silent')).toMatchObject({ status: 'error', passed: null })
    expect(run.exitCode).not.toBe(0)
  })

  test('a step that never ran is an error', () => {
    const run = runReporter('reporter_record_step_results "ghost" playwright')
    expect(suite(run, 'ghost')).toMatchObject({ status: 'error', passed: null })
    expect(suite(run, 'ghost').reason).toContain('never ran')
    expect(run.exitCode).not.toBe(0)
  })

  test('a non-zero exit with a summary claiming no failures is an error, counts kept', () => {
    const fatal = ['  4 passed (1s)', '  1 error was not a part of any test, see above for details'].join('\n')
    const run = runReporter(`
      reporter_run_step "fatal" ${emit(fatal, 1)} || true
      reporter_record_step_results "fatal" playwright
    `)
    expect(suite(run, 'fatal')).toMatchObject({ status: 'error', passed: 4, failed: 0 })
    expect(run.exitCode).not.toBe(0)
  })

  test('a parse with no summary recorded via reporter_record_parsed is an error', () => {
    const run = runReporter(`
      parse_xcodebuild_results /nonexistent/xcodebuild.log
      reporter_record_parsed "LlamenosTests" "/nonexistent/xcodebuild.log"
    `)
    expect(suite(run, 'LlamenosTests')).toMatchObject({ status: 'error', passed: null })
    expect(run.exitCode).not.toBe(0)
  })

  test('an all-green run passes and exits 0', () => {
    const run = runReporter(`
      reporter_run_step "green" ${emit(GREEN_PROJECT)}
      reporter_record_step_results "green" playwright
    `)
    expect(run.summary?.result).toBe('pass')
    expect(run.exitCode).toBe(0)
  })
})

describe('attribution cannot be ambiguous', () => {
  test('reusing a step name aborts the run instead of mixing two outputs', () => {
    const run = runReporter(`
      reporter_run_step "dup" ${emit(RED_PROJECT, 1)} || true
      reporter_run_step "dup" ${emit(GREEN_PROJECT)} || true
      reporter_record_step_results "dup" playwright
    `)
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain("step 'dup' already ran")
    expect(run.summary).toBeNull()
  })
})
