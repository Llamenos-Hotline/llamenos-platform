/**
 * Rails for scripts/ci-run-gate.sh (#2455): a gate that could not run must be
 * unmistakable, must still fail, and must never be mistaken for a verdict.
 *
 *   bun test scripts/ci-run-gate.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'ci-run-gate.sh')
const tmp = mkdtempSync(join(tmpdir(), 'ci-run-gate-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function gate(code: number) {
  const out = join(tmp, `out-${code}-${Math.random()}`)
  const summary = join(tmp, `sum-${code}-${Math.random()}`)
  writeFileSync(out, '')
  writeFileSync(summary, '')
  const r = Bun.spawnSync(['bash', SCRIPT, 'migration-order', '--', 'bash', '-c', `echo ran; exit ${code}`], {
    env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exit: r.exitCode,
    stdout: r.stdout.toString(),
    output: readFileSync(out, 'utf8'),
    summary: readFileSync(summary, 'utf8'),
  }
}

describe('ci-run-gate.sh', () => {
  test('exit 0 passes through, with no did-not-run marker', () => {
    const r = gate(0)
    expect(r.exit).toBe(0)
    expect(r.output).toBe('')
    expect(r.stdout).not.toContain('DID NOT RUN')
  })

  test('BREAK IT: exit 1 (a real finding) still fails and is NOT labelled "did not run"', () => {
    const r = gate(1)
    expect(r.exit).toBe(1)
    expect(r.output).toBe('')
    expect(r.stdout).not.toContain('DID NOT RUN')
    expect(r.summary).toBe('')
  })

  test('BREAK IT: exit 2 (could not run) still FAILS, loudly labelled, with the marker set', () => {
    const r = gate(2)
    expect(r.exit).toBe(1)
    expect(r.stdout).toContain('::error title=migration-order DID NOT RUN (not drift)::')
    expect(r.output).toBe('did_not_run=migration-order\n')
    expect(r.summary).toContain('migration-order: DID NOT RUN')
  })

  test('any other code is treated as did-not-run too, never as a pass', () => {
    const r = gate(137)
    expect(r.exit).toBe(1)
    expect(r.output).toContain('did_not_run=migration-order')
  })
})
