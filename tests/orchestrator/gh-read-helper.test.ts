import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Rails for `.github/scripts/gh-read.sh` — the ONE bounded-retry policy for a
 * gate's GitHub API reads (#2481, #2483).
 *
 * WHY THE HELPER IS A FILE. #2482 fixed a single-shot PR lookup that ejected
 * two merge groups through fleet/review, by writing `lookup_retryable` and
 * `gh_read` inline in fleet-review.yml's queue arm. fleet-verify.yml had the
 * same single-shot read (#2483) — a duplicate that existed because nobody
 * fixing one copy knew of the other. A `run:` block cannot be imported by
 * another workflow, so the policy moved here and fleet-verify.yml sources it.
 *
 * WHY THERE IS STILL A SECOND COPY, AND WHAT KEEPS IT HONEST. fleet-review.yml
 * still carries the definitions inline: #2483 was scoped not to touch that
 * workflow. Until it sources this file too, the LOCKSTEP rail below pins the
 * two byte-identical (indentation aside). A policy change made in one place
 * and not the other fails here, naming both files — which is the whole defect
 * this file exists to prevent.
 *
 * The policy rails source the REAL file and drive it with a stubbed `gh` and
 * a recording `sleep`, so they test the literal bytes the workflows run.
 */

const REPO_ROOT = process.cwd()
const GH_READ_LIB = join(REPO_ROOT, '.github', 'scripts', 'gh-read.sh')
const FLEET_REVIEW_YML = join(REPO_ROOT, '.github', 'workflows', 'fleet-review.yml')

/** The policy's definitions — `lookup_retryable() {` through the closing
 *  brace of `gh_read() {` — with each line's leading indentation stripped,
 *  so a copy inside a YAML `run: |` block compares equal to the file. */
function policyBlock(text: string, where: string): string[] {
  const lines = text.split('\n').map((l) => l.replace(/^\s+/, '').trimEnd())
  const start = lines.findIndex((l) => l === 'lookup_retryable() {')
  const fn = lines.findIndex((l, i) => i > start && l === 'gh_read() {')
  expect(start, `no lookup_retryable() definition in ${where} — this rail must not pass vacuously`).toBeGreaterThan(-1)
  expect(fn, `no gh_read() definition after lookup_retryable in ${where}`).toBeGreaterThan(start)
  // gh_read's body ends at the first top-level `}` line after `done`.
  const done = lines.findIndex((l, i) => i > fn && l === 'done')
  const end = lines.findIndex((l, i) => i > done && l === '}')
  expect(done, `gh_read in ${where} has no retry loop`).toBeGreaterThan(fn)
  expect(end, `gh_read in ${where} is not closed`).toBeGreaterThan(done)
  return lines.slice(start, end + 1)
}

describe('rail: one retry policy — fleet-review.yml\'s inline copy is byte-identical to the shared helper', () => {
  it('finds a non-trivial policy in the shared helper — the parser must not pass vacuously', () => {
    const block = policyBlock(readFileSync(GH_READ_LIB, 'utf8'), 'gh-read.sh')
    expect(block.length).toBeGreaterThan(30)
    expect(block).toContain('GH_READ_ATTEMPTS=5')
  })

  it('fleet-review.yml (#2482) and .github/scripts/gh-read.sh (#2483) define the same policy, line for line', () => {
    const shared = policyBlock(readFileSync(GH_READ_LIB, 'utf8'), 'gh-read.sh')
    const inline = policyBlock(readFileSync(FLEET_REVIEW_YML, 'utf8'), 'fleet-review.yml')
    expect(
      inline,
      'the retry policy drifted between fleet-review.yml and .github/scripts/gh-read.sh — change both, or (better) make fleet-review.yml source the helper and delete its inline copy',
    ).toEqual(shared)
  })

  it('MUTATION: a one-character drift in either copy is caught', () => {
    const shared = readFileSync(GH_READ_LIB, 'utf8')
    const drifted = shared.replace('5??|408|429) return 0 ;;', '5??|408|429|404) return 0 ;;')
    expect(drifted).not.toBe(shared)
    expect(policyBlock(drifted, 'mutated helper')).not.toEqual(policyBlock(readFileSync(FLEET_REVIEW_YML, 'utf8'), 'fleet-review.yml'))
  })
})

// ---------------------------------------------------------------------------
// The policy itself, driven directly.
// ---------------------------------------------------------------------------

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'llamenos-gh-read-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

interface ReadResult {
  status: number | null
  output: string
  out: string
  err: string
  calls: number
  sleeps: number[]
}

/**
 * Sources the real helper and runs one `gh_read`, against a `gh` stub that
 * fails its first `failTimes` calls (every call when omitted) with `stderr`
 * and otherwise prints `body` and exits 0.
 */
function read(opts: { stderr?: string; failTimes?: number; body?: string; fail?: boolean }): ReadResult {
  const bin = join(scratch, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(scratch, 'stderr'), opts.stderr ?? '')
  writeFileSync(join(scratch, 'body'), opts.body ?? '{"ok":true}')
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
n=$(( $(cat "${scratch}/calls" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "${scratch}/calls"
if [ "${opts.fail ? '1' : ''}" = "1" ]; then
  if [ -z "${opts.failTimes ?? ''}" ] || [ "$n" -le "${opts.failTimes ?? 0}" ]; then
    cat "${scratch}/stderr" >&2
    exit 1
  fi
fi
cat "${scratch}/body"
`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(bin, 'sleep'), `#!/usr/bin/env bash\necho "$1" >> "${scratch}/sleeps"\n`)
  chmodSync(join(bin, 'sleep'), 0o755)
  const script = `set -euo pipefail
. "$GH_READ_LIB"
if gh_read "probe" "repos/o/r/pulls/1"; then rc=0; else rc=$?; fi
printf '%s' "$GH_READ_OUT" > "${scratch}/out"
printf '%s' "\${GH_READ_ERR:-}" > "${scratch}/err"
exit "$rc"
`
  writeFileSync(join(scratch, 'run.sh'), script)
  const r = spawnSync('bash', ['-e', join(scratch, 'run.sh')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, GH_READ_LIB },
  })
  const text = (p: string): string => {
    try {
      return readFileSync(join(scratch, p), 'utf8')
    } catch {
      return ''
    }
  }
  return {
    status: r.status,
    output: `${r.stdout}\n${r.stderr}`,
    out: text('out'),
    err: text('err'),
    calls: Number(text('calls').trim() || '0'),
    sleeps: text('sleeps').trim().split('\n').filter(Boolean).map(Number),
  }
}

describe('rail: the shared policy — 5 attempts at 2/4/8/16s, transient failures only, never an answer', () => {
  it('a 200 is returned on the first call, never retried — even when its body talks about server errors', () => {
    const r = read({ body: '{"message":"Server Error (HTTP 502)","auto_merge":null}' })
    expect(r.status).toBe(0)
    expect(r.calls).toBe(1)
    expect(r.sleeps).toEqual([])
    expect(r.out).toBe('{"message":"Server Error (HTTP 502)","auto_merge":null}')
  })

  it('a transient failure is retried with 2/4/8/16s backoff, and the eventual answer is returned', () => {
    const r = read({ fail: true, failTimes: 4, stderr: 'gh: Server Error (HTTP 502)' })
    expect(r.status).toBe(0)
    expect(r.calls).toBe(5)
    expect(r.sleeps).toEqual([2, 4, 8, 16])
    expect(r.out).toBe('{"ok":true}')
  })

  it('gives up after exactly 5 attempts, returning 1 with the last error', () => {
    const r = read({ fail: true, stderr: 'gh: Server Error (HTTP 502)' })
    expect(r.status).toBe(1)
    expect(r.calls).toBe(5)
    expect(r.sleeps).toEqual([2, 4, 8, 16])
    expect(r.err).toContain('HTTP 502')
    expect(r.output).toContain('still failing after 5/5 attempts')
  })

  for (const stderr of [
    'dial tcp: i/o timeout',
    'GraphQL: Something went wrong while executing your query.',
    'gh: Server Error (HTTP 500)',
    'gh: Service Unavailable (HTTP 503)',
    'gh: Request Timeout (HTTP 408)',
    'gh: Too Many Requests (HTTP 429)',
    'gh: API rate limit exceeded for installation. (HTTP 403)',
    'gh: You have exceeded a secondary rate limit. (HTTP 403)',
  ]) {
    it(`retries: ${stderr}`, () => {
      const r = read({ fail: true, failTimes: 1, stderr })
      expect(r.status).toBe(0)
      expect(r.calls).toBe(2)
      expect(r.sleeps).toEqual([2])
    })
  }

  for (const stderr of [
    'gh: Not Found (HTTP 404)',
    'gh: Bad credentials (HTTP 401)',
    'gh: Resource not accessible by integration (HTTP 403)',
    'gh: Validation Failed (HTTP 422)',
    'gh: Conflict (HTTP 409)',
  ]) {
    it(`does not retry: ${stderr}`, () => {
      const r = read({ fail: true, stderr })
      expect(r.status).toBe(1)
      expect(r.calls).toBe(1)
      expect(r.sleeps).toEqual([])
      expect(r.output).toContain('non-retryable')
    })
  }
})
