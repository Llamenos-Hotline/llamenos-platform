import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseVerdict, stripReviewerControlFiles, verifierFor,
  classifyEngineFailure, reviewerBinaryFor, reviewerInvocationFor,
} from '../../orchestrator/src/review.js'

// #812: `fleet/review` retired `opencode` as the reviewer engine entirely —
// the reviewer is now always a `claude` session on a dedicated self-hosted
// runner (see review.ts's doc comment above `verifierFor` for the full
// rationale and the honest cost: same model family as the `claude`-authored
// lanes, still a genuinely separate session on a separate machine).
describe('verifierFor', () => {
  it('always resolves to claude now, regardless of the author engine', () => {
    expect(verifierFor('claude')).toBe('claude')
    expect(verifierFor('opencode')).toBe('claude')
  })
})

// #866: the smoke test and the real review must derive their engine/model
// from the SAME function — never two hand-kept literals that happen to
// agree until one of them changes. See `reviewerInvocationFor`'s own doc
// comment in review.ts for the live incident this rail guards.
describe('reviewerInvocationFor / reviewerBinaryFor', () => {
  it('resolves claude for either author engine (verifierFor collapses both today)', () => {
    expect(reviewerInvocationFor('claude')).toEqual({ engine: 'claude', binary: 'claude', model: expect.any(String) })
    expect(reviewerInvocationFor('opencode')).toEqual({ engine: 'claude', binary: 'claude', model: expect.any(String) })
  })

  // MUTATION (per "audit gates by breaking them"): `verifierFor` cannot
  // itself be driven to return anything but `'claude'` today, so a test
  // that only calls `reviewerInvocationFor` could never observe
  // `reviewerBinaryFor` refusing a second engine. Calling the hard-fail
  // helper directly proves the contract holds independently of
  // `verifierFor`'s current, coincidentally-single-valued behavior: if a
  // future edit ever makes `verifierFor` resolve to `'opencode'` again
  // without ALSO teaching `reviewerBinaryFor` how to invoke it, this is the
  // function that turns that gap into a loud, immediate throw instead of a
  // silent divergence from whatever the smoke test proved.
  //
  // Verified live: commenting out this function's `if` guard (so it always
  // returns `'claude'` regardless of `engine`) makes this exact test fail
  // with "expected [Function] to throw an error" — see the PR body for the
  // transcript.
  it('MUTATION: refuses (throws) for any engine besides claude — never a silent fallback', () => {
    expect(() => reviewerBinaryFor('opencode')).toThrow(/no wired reviewer invocation/)
  })
})

describe('classifyEngineFailure', () => {
  it('reads claude\'s own "unrecognized model" text as engine-misconfigured, not engine-unavailable', () => {
    // Verbatim (stdout + stderr) from the installed claude binary given
    // `--model this-is-not-a-real-model` — captured for this PR's own
    // investigation into #866's live failure.
    const stdout = "There's an issue with the selected model (this-is-not-a-real-model). " +
      'It may not exist or you may not have access to it. Run --model to pick a different model.'
    const stderr = '"this-is-not-a-real-model" isn\'t described by this version\'s model catalog; ' +
      '[claude-code:unrecognized_model] {"model":"this-is-not-a-real-model","query_source":"sdk"}'
    expect(classifyEngineFailure(`${stdout}\n${stderr}`)).toBe('engine-misconfigured')
  })

  it('reads claude\'s own "Reached max turns" text as budget-exhausted, not engine-unavailable', () => {
    // Verbatim from a real run: fleet/review on #1445 (3 files) spent all ten
    // turns in 68 seconds and emitted no verdict. Reported as
    // `engine-unavailable` it became "re-request the review" — which re-runs
    // the same diff under the same budget and exhausts again, a loop costing
    // a full session each time. The remedy differs, so the classification
    // must too.
    expect(classifyEngineFailure('Error: Reached max turns (10)')).toBe('budget-exhausted')
    expect(classifyEngineFailure('fleet/review: FAIL — review unavailable: Error: Reached max turns (20)')).toBe('budget-exhausted')
  })

  it('reads an ordinary crash/timeout/outage as engine-unavailable', () => {
    expect(classifyEngineFailure('spawn ENOENT')).toBe('engine-unavailable')
    expect(classifyEngineFailure('simulated: Unexpected server error from provider')).toBe('engine-unavailable')
    expect(classifyEngineFailure('')).toBe('engine-unavailable')
    // 'turns' alone must not trip the budget branch
    expect(classifyEngineFailure('took several turns to connect')).toBe('engine-unavailable')
  })
})

describe('parseVerdict', () => {
  it('reads an explicit PASS on the final line', () => {
    expect(parseVerdict('SCOPE: ok\nVERDICT: PASS')).toBe('PASS')
  })
  it('reads an explicit FAIL with its reason', () => {
    expect(parseVerdict('VERDICT: FAIL — touched files outside its lane')).toBe('FAIL')
  })
  it('treats a missing verdict as UNREADABLE, not as a pass', () => {
    expect(parseVerdict('I think it looks fine honestly')).toBe('UNREADABLE')
  })
  it('treats empty output as UNREADABLE', () => {
    expect(parseVerdict('')).toBe('UNREADABLE')
    expect(parseVerdict('  \n\n ')).toBe('UNREADABLE')
  })
  it('does not mistake a mention of the word "pass" without the VERDICT label for a verdict', () => {
    expect(parseVerdict('this diff should pass CI once merged')).toBe('UNREADABLE')
  })
  // #801 — the verdict is the FINAL line, exactly as VERIFIER_BRIEF demands.
  it('takes the final FAIL, not a VERDICT: PASS quoted earlier from the diff', () => {
    const output = [
      'Walking through the diff:',
      '',
      '```diff',
      "+    secondOpinion: vi.fn(async () => ({ verdict: 'PASS' as const, text: 'looks fine' })),",
      'VERDICT: PASS',
      '```',
      '',
      'That quoted line is test data, not my verdict. The change also logs the hub key.',
      'VERDICT: FAIL — writes the hub key to the job log',
    ].join('\n')
    expect(parseVerdict(output)).toBe('FAIL')
  })
  it('takes the final FAIL over an earlier verdict reached while reasoning in the open', () => {
    expect(parseVerdict('My first read said VERDICT: PASS, but on closer inspection…\nVERDICT: FAIL — leaks a key')).toBe('FAIL')
  })
  it('is UNREADABLE when a well-formed VERDICT: PASS is followed by more prose', () => {
    expect(parseVerdict('VERDICT: PASS\nActually, one more thing I noticed.')).toBe('UNREADABLE')
  })
  // Accepted risk, stated so the next edit to VERDICT_LINE_RE sees it: last
  // line wins in the PERMISSIVE direction too. The brief demands exactly one
  // verdict line at the end; a reviewer talked out of an earlier FAIL (or
  // prompt-injected into a final PASS) ends on PASS, and the parser cannot
  // tell those apart — that is an LLM-layer problem, not a parsing one.
  it('takes a final PASS over an earlier FAIL: the last line wins in both directions', () => {
    expect(parseVerdict('VERDICT: FAIL — leaks key\nOn reflection the key is a test fixture.\nVERDICT: PASS')).toBe('PASS')
  })
  it('tolerates trailing newlines and trailing whitespace after a valid final line', () => {
    expect(parseVerdict('ok\nVERDICT: PASS   \n\n  \n')).toBe('PASS')
    expect(parseVerdict('ok\r\nVERDICT: FAIL — nope\t\r\n')).toBe('FAIL')
  })
  // FAIL matches on `\b`, which a stray `\r` would not break; PASS is anchored
  // with `$`, which it would. So CRLF has to be pinned on PASS specifically.
  it('reads a CRLF-terminated PASS: the `$` anchor must not see the carriage return', () => {
    expect(parseVerdict('ok\r\nVERDICT: PASS\r\n')).toBe('PASS')
  })
  // Fail closed on terminal colour codes — and the CI smoke step now judges
  // the engine's output with this same function, so an engine that starts
  // emitting them fails the smoke step instead of passing it.
  it('is UNREADABLE when the verdict line carries ANSI escape codes', () => {
    expect(parseVerdict('\x1b[32mVERDICT: PASS\x1b[0m')).toBe('UNREADABLE')
    expect(parseVerdict('VERDICT: PASS\x1b[0m')).toBe('UNREADABLE')
    expect(parseVerdict('VERDICT: PASS\n\x1b[0m')).toBe('UNREADABLE')
  })
  it('is case-sensitive: a lowercase verdict line is UNREADABLE', () => {
    expect(parseVerdict('verdict: pass')).toBe('UNREADABLE')
    expect(parseVerdict('VERDICT: Pass')).toBe('UNREADABLE')
  })
  it('is anchored: a verdict that does not start its line is UNREADABLE', () => {
    expect(parseVerdict('  VERDICT: PASS')).toBe('UNREADABLE')
    expect(parseVerdict('**VERDICT: PASS**')).toBe('UNREADABLE')
    expect(parseVerdict('so, VERDICT: PASS')).toBe('UNREADABLE')
  })
  it('accepts nothing after PASS, and no word merely beginning with PASS or FAIL', () => {
    expect(parseVerdict('VERDICT: PASS — but only just')).toBe('UNREADABLE')
    expect(parseVerdict('VERDICT: PASSED')).toBe('UNREADABLE')
    expect(parseVerdict('VERDICT: FAILED')).toBe('UNREADABLE')
  })
})

describe('stripReviewerControlFiles', () => {
  it('removes agent instructions/config at any depth, case-insensitively, and every symlink — without following one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'llamenos-fleet-strip-test-'))
    const outside = mkdtempSync(join(tmpdir(), 'llamenos-fleet-strip-outside-'))
    try {
      writeFileSync(join(outside, 'secret.json'), '{}')
      mkdirSync(join(root, '.opencode', 'tool'), { recursive: true })
      writeFileSync(join(root, '.opencode', 'tool', 'x.ts'), '')
      writeFileSync(join(root, 'opencode.json'), '{}')
      writeFileSync(join(root, 'Agents.md'), 'obey')
      mkdirSync(join(root, 'packages', 'crypto', '.claude'), { recursive: true })
      writeFileSync(join(root, 'packages', 'crypto', 'CLAUDE.md'), 'obey')
      writeFileSync(join(root, 'packages', 'crypto', 'lib.rs'), 'fn main() {}')
      symlinkSync(outside, join(root, 'packages', 'linked-dir'))
      symlinkSync(join(outside, 'secret.json'), join(root, 'notes.md'))

      const removed = await stripReviewerControlFiles(root)

      expect(removed.sort()).toEqual([
        '.opencode', 'Agents.md', 'notes.md', 'opencode.json',
        'packages/crypto/.claude', 'packages/crypto/CLAUDE.md', 'packages/linked-dir',
      ])
      expect(readdirSync(root).sort()).toEqual(['packages'])
      expect(readdirSync(join(root, 'packages', 'crypto'))).toEqual(['lib.rs'])
      // The link was removed, not walked: the target outside is untouched.
      expect(readFileSync(join(outside, 'secret.json'), 'utf8')).toBe('{}')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

// --- I/O-bearing behaviour, mocked at the node:child_process boundary ---

// review.ts (and gh.ts) call `promisify(execFile)` exactly once, at module
// import time. `promisify` decides right then whether the function has a
// `util.promisify.custom` implementation; a bare `vi.fn()` has none, so it
// falls back to treating the mock as callback-style and hangs forever
// waiting for a callback that never comes. The custom hook must therefore
// exist on the mock BEFORE review.ts is ever imported — set inside the
// factory itself, not assigned onto the mock later from within a test.
//
// V1 fix-round tests need `secondOpinion`'s `gitState`/`exportReviewSnapshot`
// calls to run against a REAL git repository (so before/after tamper
// detection and the exported-snapshot's missing `.git` are genuinely
// observable), while the verifier engine's own `claude` invocation stays
// mocked (no real LLM CLI in a unit test). The custom hook branches on the
// binary: `git` passes straight through to the real `execFile`; everything
// else (the verifier binary, `gh`) goes through the trackable `vi.fn()`
// mock. `spawn` (used by `exportReviewSnapshot` for `git archive | tar`) is
// left entirely real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { vi: vitest } = await import('vitest')
  const { promisify: nodePromisify } = await import('node:util')
  const realExecFileAsync = nodePromisify(actual.execFile)
  const mockFn = vitest.fn()
  ;(mockFn as unknown as Record<symbol, unknown>)[nodePromisify.custom] =
    (file: string, args?: readonly string[], options?: unknown) => {
      if (file === 'git') return realExecFileAsync(file, args as string[], options as never)
      return mockFn(file, args, options)
    }
  return { ...actual, execFile: mockFn }
})

import { execFile } from 'node:child_process'

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>

function mockExecFileResolves(stdout: string): void {
  mockExecFile.mockResolvedValue({ stdout, stderr: '' })
}

function mockExecFileRejects(err: unknown): void {
  mockExecFile.mockRejectedValue(err)
}

beforeEach(() => {
  mockExecFile.mockReset()
})

// --- Real temp git repos, standing in for an author's worktree ---

const createdWorktrees: string[] = []

function makeAuthorWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'llamenos-fleet-review-test-'))
  createdWorktrees.push(dir)
  execSync('git init -q', { cwd: dir })
  execSync('git config user.email test@example.com', { cwd: dir })
  execSync('git config user.name "Test"', { cwd: dir })
  writeFileSync(join(dir, 'file.txt'), 'hello\n')
  execSync('git add file.txt', { cwd: dir })
  execSync('git commit -q -m initial', { cwd: dir })
  return dir
}

afterEach(() => {
  while (createdWorktrees.length > 0) {
    const dir = createdWorktrees.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('secondOpinion', () => {
  it('refuses to review a report that did not pass mechanical verification', async () => {
    const { secondOpinion } = await import('../../orchestrator/src/review.js')
    const failedReport = {
      passed: false, reasons: ['strayed'], changedFiles: [], addedLines: 0,
      impact: 'low' as const, impactReasons: [],
    }
    await expect(secondOpinion({
      authorEngine: 'claude', pr: '1', worktree: '/tmp/x', diff: '', report: failedReport,
    })).rejects.toThrow(/did not pass mechanical verification/)
    // And never even attempts to reach an engine for a report that failed.
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  // #812: the reviewer is always `claude` now, for EITHER author engine —
  // proven against both `claude` and `opencode` authors, so a regression
  // that reintroduces the old "other engine" bijection (which would make an
  // `opencode`-authored lane's review invoke `claude` differently from a
  // `claude`-authored one, or resurrect an `opencode` binary call) fails
  // this test either way.
  it.each(['claude', 'opencode'] as const)('runs the reviewer on claude regardless of the author engine (%s)', async (authorEngine) => {
    mockExecFileResolves('VERDICT: PASS')
    const { secondOpinion } = await import('../../orchestrator/src/review.js')
    const worktree = makeAuthorWorktree()
    const passedReport = {
      passed: true, reasons: [], changedFiles: ['apps/worker/x.ts'], addedLines: 1,
      impact: 'low' as const, impactReasons: [],
    }
    const result = await secondOpinion({
      authorEngine, pr: '1', worktree, diff: 'diff', report: passedReport,
    })
    expect(result.verdict).toBe('PASS')
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const [binary] = mockExecFile.mock.calls[0] as [string, ...unknown[]]
    expect(binary).toBe('claude')
  })

  it('invokes claude in print mode, plan permission, with a max-turns budget and read access to the export', async () => {
    mockExecFileResolves('VERDICT: PASS')
    const { secondOpinion } = await import('../../orchestrator/src/review.js')
    const worktree = makeAuthorWorktree()
    await secondOpinion({
      authorEngine: 'claude', pr: '1', worktree, diff: 'diff',
      report: {
        passed: true, reasons: [], changedFiles: ['apps/worker/x.ts'], addedLines: 1,
        impact: 'low' as const, impactReasons: [],
      },
    })
    const args = mockExecFile.mock.calls[0]?.[1] as string[]
    expect(args).toContain('--print')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(args).toContain('--max-turns')
    expect(args).toContain('--add-dir')
    // Read-only, non-interactive posture: never the flag that lets a worker
    // write without being asked.
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('treats an unreachable reviewer as UNREADABLE, not a pass', async () => {
    mockExecFileRejects(new Error('spawn ENOENT'))
    const { secondOpinion } = await import('../../orchestrator/src/review.js')
    const worktree = makeAuthorWorktree()
    const passedReport = {
      passed: true, reasons: [], changedFiles: [], addedLines: 0,
      impact: 'low' as const, impactReasons: [],
    }
    const result = await secondOpinion({
      authorEngine: 'opencode', pr: '1', worktree, diff: '', report: passedReport,
    })
    expect(result.verdict).toBe('UNREADABLE')
    // A plain crash (no model-id complaint in the text) classifies as
    // engine-unavailable — see `classifyEngineFailure` for the other branch.
    expect(result.failureKind).toBe('engine-unavailable')
  })

  // #866: an unresolvable `--model` id is a MISCONFIGURATION, not an
  // unavailability — this is what let #866's own live incident (a bare
  // model shorthand handed to the wrong engine) surface as an opaque
  // "review unavailable" instead of naming the actual, fixable defect.
  it('treats a claude "unrecognized model" rejection as UNREADABLE with failureKind engine-misconfigured', async () => {
    const err = Object.assign(new Error('Command failed'), {
      stdout: "There's an issue with the selected model (bogus). It may not exist or you may not have access to it.",
      stderr: '"bogus" isn\'t described by this version\'s model catalog; [claude-code:unrecognized_model]',
    })
    mockExecFileRejects(err)
    const { secondOpinion } = await import('../../orchestrator/src/review.js')
    const worktree = makeAuthorWorktree()
    const passedReport = {
      passed: true, reasons: [], changedFiles: [], addedLines: 0,
      impact: 'low' as const, impactReasons: [],
    }
    const result = await secondOpinion({
      authorEngine: 'claude', pr: '1', worktree, diff: '', report: passedReport,
    })
    expect(result.verdict).toBe('UNREADABLE')
    expect(result.failureKind).toBe('engine-misconfigured')
  })

  it('requests more turns for a high-impact diff than a low-impact one', async () => {
    mockExecFileResolves('VERDICT: PASS')
    const { secondOpinion } = await import('../../orchestrator/src/review.js')
    const worktree = makeAuthorWorktree()
    const highImpactReport = {
      passed: true, reasons: [], changedFiles: ['packages/crypto/x.rs'], addedLines: 1,
      impact: 'high' as const, impactReasons: ['packages/crypto/x.rs is under high-impact path packages/crypto/'],
    }
    await secondOpinion({ authorEngine: 'claude', pr: '1', worktree, diff: '', report: highImpactReport })
    const args = mockExecFile.mock.calls[0]?.[1] as string[]
    const idx = args.indexOf('--max-turns')
    expect(idx).toBeGreaterThanOrEqual(0)
    const highImpactTurns = Number(args[idx + 1])

    mockExecFile.mockClear()
    mockExecFileResolves('VERDICT: PASS')
    const lowImpactReport = { ...highImpactReport, impact: 'low' as const, impactReasons: [] }
    await secondOpinion({ authorEngine: 'claude', pr: '1', worktree, diff: '', report: lowImpactReport })
    const args2 = mockExecFile.mock.calls[0]?.[1] as string[]
    const idx2 = args2.indexOf('--max-turns')
    const lowImpactTurns = Number(args2[idx2 + 1])

    expect(highImpactTurns).toBeGreaterThan(lowImpactTurns)
  })

  // --- V1 fix-round tests: the verifier must be isolated from the author ---

  const okReport = {
    passed: true as const, reasons: [], changedFiles: ['apps/worker/x.ts'], addedLines: 1,
    impact: 'low' as const, impactReasons: [],
  }

  it('never runs the verifier with the author\'s own worktree as cwd', async () => {
    const worktree = makeAuthorWorktree()
    let capturedCwd: string | undefined
    mockExecFile.mockImplementation((_file: string, _args: string[], options: { cwd?: string }) => {
      capturedCwd = options.cwd
      return { stdout: 'VERDICT: PASS', stderr: '' }
    })
    const { secondOpinion } = await import('../../orchestrator/src/review.js')
    await secondOpinion({ authorEngine: 'claude', pr: '1', worktree, diff: '', report: okReport })

    expect(capturedCwd).toBeDefined()
    expect(capturedCwd).not.toBe(worktree)
  })

  it('exports a scratch directory containing the source files but no .git, and grants the reviewer exactly that via --add-dir', async () => {
    const worktree = makeAuthorWorktree()
    let sawFile = false
    let sawGitDir = false
    let exportDir: string | undefined
    mockExecFile.mockImplementation((_file: string, args: string[], _options: { cwd?: string }) => {
      // Inspected DURING the call, before secondOpinion's `finally` cleans
      // the scratch directory up — by the time the promise resolves back
      // in this test, the directory is already gone.
      exportDir = args[args.indexOf('--add-dir') + 1]
      if (exportDir !== undefined) {
        sawFile = existsSync(join(exportDir, 'file.txt'))
        sawGitDir = existsSync(join(exportDir, '.git'))
      }
      return { stdout: 'VERDICT: PASS', stderr: '' }
    })
    const { secondOpinion } = await import('../../orchestrator/src/review.js')
    await secondOpinion({ authorEngine: 'claude', pr: '1', worktree, diff: '', report: okReport })

    expect(exportDir).toBeDefined()
    expect(sawFile).toBe(true)
    expect(sawGitDir).toBe(false)
  })

  it('runs claude from an empty project root that is not the export', async () => {
    const worktree = makeAuthorWorktree()
    let rootListing: string[] | undefined
    let args: string[] = []
    let cwd: string | undefined
    let addedDir: string | undefined
    mockExecFile.mockImplementation((_file: string, a: string[], options: { cwd?: string }) => {
      args = a
      cwd = options.cwd
      rootListing = cwd === undefined ? undefined : readdirSync(cwd)
      addedDir = a[a.indexOf('--add-dir') + 1]
      return { stdout: 'VERDICT: PASS', stderr: '' }
    })
    const { secondOpinion } = await import('../../orchestrator/src/review.js')
    await secondOpinion({ authorEngine: 'claude', pr: '1', worktree, diff: '', report: okReport })

    expect(rootListing).toEqual([])
    expect(args).toContain('--add-dir')
    expect(cwd).not.toBe(addedDir)
  })

  it('runs claude from an empty project root too, granting the export with --add-dir', async () => {
    const worktree = makeAuthorWorktree()
    let rootListing: string[] | undefined
    let added: string | undefined
    let sawFile = false
    mockExecFile.mockImplementation((_file: string, a: string[], options: { cwd?: string }) => {
      rootListing = options.cwd === undefined ? undefined : readdirSync(options.cwd)
      added = a[a.indexOf('--add-dir') + 1]
      sawFile = added !== undefined && existsSync(join(added, 'file.txt'))
      return { stdout: 'looks fine\nVERDICT: PASS', stderr: '' }
    })
    const { secondOpinion } = await import('../../orchestrator/src/review.js')
    const result = await secondOpinion({ authorEngine: 'opencode', pr: '1', worktree, diff: '', report: okReport })

    expect(result.verdict).toBe('PASS')
    expect(rootListing).toEqual([])
    expect(sawFile).toBe(true)
  })

  it('strips credential-bearing variables from the verifier\'s environment', async () => {
    const worktree = makeAuthorWorktree()
    const originalGhToken = process.env['GH_TOKEN']
    const originalSshSock = process.env['SSH_AUTH_SOCK']
    process.env['GH_TOKEN'] = 'super-secret-token'
    process.env['SSH_AUTH_SOCK'] = '/tmp/agent.sock'
    let capturedEnv: NodeJS.ProcessEnv | undefined
    mockExecFile.mockImplementation((_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = options.env
      return { stdout: 'VERDICT: PASS', stderr: '' }
    })
    try {
      const { secondOpinion } = await import('../../orchestrator/src/review.js')
      await secondOpinion({ authorEngine: 'claude', pr: '1', worktree, diff: '', report: okReport })
    } finally {
      if (originalGhToken === undefined) delete process.env['GH_TOKEN']
      else process.env['GH_TOKEN'] = originalGhToken
      if (originalSshSock === undefined) delete process.env['SSH_AUTH_SOCK']
      else process.env['SSH_AUTH_SOCK'] = originalSshSock
    }

    expect(capturedEnv).toBeDefined()
    expect(capturedEnv?.['GH_TOKEN']).toBeUndefined()
    expect(capturedEnv?.['SSH_AUTH_SOCK']).toBeUndefined()
    expect(Object.values(capturedEnv ?? {})).not.toContain('super-secret-token')
  })

  // `FLEET_REVIEW_API_KEY`/`ANTHROPIC_API_KEY` must never be forwarded into
  // the reviewer's own environment either — the self-hosted runner's
  // already-authenticated `claude` login (under `HOME`) is the entire
  // authentication mechanism (see `VERIFIER_ENV_ALLOWLIST`'s doc comment).
  // Setting `ANTHROPIC_API_KEY` here would make `claude` prefer metered
  // billing over the operator's subscription — exactly the cost the
  // self-hosted runner exists to avoid.
  it('never forwards a repo review-key secret into the reviewer\'s own environment', async () => {
    const worktree = makeAuthorWorktree()
    const original = process.env['FLEET_REVIEW_API_KEY']
    process.env['FLEET_REVIEW_API_KEY'] = 'super-secret-anthropic-key'
    let capturedEnv: NodeJS.ProcessEnv | undefined
    mockExecFile.mockImplementation((_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = options.env
      return { stdout: 'VERDICT: PASS', stderr: '' }
    })
    try {
      const { secondOpinion } = await import('../../orchestrator/src/review.js')
      await secondOpinion({ authorEngine: 'claude', pr: '1', worktree, diff: '', report: okReport })
    } finally {
      if (original === undefined) delete process.env['FLEET_REVIEW_API_KEY']
      else process.env['FLEET_REVIEW_API_KEY'] = original
    }

    expect(capturedEnv).toBeDefined()
    expect(capturedEnv?.['FLEET_REVIEW_API_KEY']).toBeUndefined()
    expect(capturedEnv?.['ANTHROPIC_API_KEY']).toBeUndefined()
  })

  it('removes the scratch project-root directory on the success path', async () => {
    const worktree = makeAuthorWorktree()
    let capturedCwd: string | undefined
    mockExecFile.mockImplementation((_file: string, _args: string[], options: { cwd?: string }) => {
      capturedCwd = options.cwd
      return { stdout: 'VERDICT: PASS', stderr: '' }
    })
    const { secondOpinion } = await import('../../orchestrator/src/review.js')
    await secondOpinion({ authorEngine: 'claude', pr: '1', worktree, diff: '', report: okReport })

    expect(capturedCwd).toBeDefined()
    expect(existsSync(capturedCwd ?? '')).toBe(false)
  })

  it('removes the scratch directory on the throw path, and fails verification, when the author worktree is tampered with mid-review', async () => {
    const worktree = makeAuthorWorktree()
    let capturedCwd: string | undefined
    mockExecFile.mockImplementation((_file: string, _args: string[], options: { cwd?: string }) => {
      capturedCwd = options.cwd
      // Simulate a verifier (or anything else) mutating the AUTHOR's real
      // worktree while "reviewing" — this must never go undetected, and
      // must never leave the scratch directory behind either.
      appendFileSync(join(worktree, 'file.txt'), 'tampered-by-verifier\n')
      return { stdout: 'VERDICT: PASS', stderr: '' }
    })
    const { secondOpinion } = await import('../../orchestrator/src/review.js')

    // W3 (fix round 2): the message must say plainly that the VERIFIER did
    // this, and that it is a fleet-level problem worth halting for — not
    // just "something changed," which would read like an ordinary flake.
    // A single call/catch, not two separate invocations: a second call
    // against the same (already-tampered) worktree would see identical
    // before/after `git status --porcelain` output and falsely appear
    // untampered on that second call alone.
    let caught: unknown
    try {
      await secondOpinion({ authorEngine: 'claude', pr: '1', worktree, diff: '', report: okReport })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    const message = caught instanceof Error ? caught.message : ''
    expect(message).toMatch(/modified the AUTHOR'S OWN worktree/)
    expect(message).toMatch(/fleet-level trust failure/)

    expect(capturedCwd).toBeDefined()
    expect(existsSync(capturedCwd ?? '')).toBe(false)
  })

})

describe('postReview', () => {
  // The verdict of record is `fleet/review`, a commit status posted by CI.
  // This one is advisory, so it must never be a GitHub REVIEW: an --approve
  // from the fleet is a review GitHub counts, and is one ruleset edit away
  // from being an approval the fleet grants itself.
  it.each(['PASS', 'FAIL', 'UNREADABLE'] as const)('posts %s as a comment, never a review', async (verdict) => {
    mockExecFileResolves('')
    const { postReview } = await import('../../orchestrator/src/review.js')
    await postReview('123', verdict, 'body text')
    const args = mockExecFile.mock.calls[0]?.[1] as string[]
    expect(args.slice(0, 3)).toEqual(['pr', 'comment', '123'])
    expect(args).not.toContain('--approve')
    expect(args).not.toContain('--request-changes')
    expect(args.join(' ')).toContain(verdict)
  })
})
