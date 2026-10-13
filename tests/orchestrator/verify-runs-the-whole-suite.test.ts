import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { testTargetsFor, routedConfigs, verifyMechanical } from '../../orchestrator/src/verify.js'
import type { Lane } from '../../orchestrator/src/config.js'

/**
 * Rail for #1587: when `fleet/verify` decides to run a suite, it runs the
 * WHOLE suite — the same files the same config runs in CI.
 *
 * The defect, measured. The `apps/worker/` route handed vitest the positional
 * argument `apps/worker`, which vitest treats as a filename filter. But
 * `vitest.unit.config.ts` — the config the required `backend-unit` job runs —
 * also includes `deploy/docker/tests/**`. So on a head whose only changed file
 * was under `apps/worker/`, the gate ran 5206 of that suite's 5280 tests,
 * found no failure among the ones it ran, and reported
 *
 *     scope=pass impact=… tests=apps/worker:pass   (5206 passed, 0 failed)
 *
 * while `backend-unit` on the very same commit was RED. The signal was not
 * wrong, it was NARROWER THAN IT CLAIMED, and the narrowing was invisible in
 * the output: `tests=apps/worker:pass` reads as "the backend's tests pass"
 * and meant "the tests whose path contains apps/worker pass".
 *
 * Two independent properties keep that closed, and both are asserted here
 * against the real artefacts rather than by reading the config:
 *
 *  1. The runner is given NO positional filter, so what runs is exactly the
 *     config's own `include` set. Checked by recording the argv the gate
 *     actually execs.
 *  2. Every `include` glob of every routed config is reachable through some
 *     route prefix, so a suite the gate can run is also a suite the gate can
 *     be TRIGGERED to run. Derived from the config files themselves — a glob
 *     added to a config with no route covering it fails this suite.
 */

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
}

const GREEN = JSON.stringify({
  numTotalTestSuites: 3, numPassedTestSuites: 3, numFailedTestSuites: 0, numPendingTestSuites: 0,
  numTotalTests: 12, numPassedTests: 12, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  startTime: 0, success: true, testResults: [],
})

/** A repo whose diff touches `orchestrator/`, with a stand-in `vitest` that
 *  records its own argv and then writes a green result. */
function repoRecordingArgv(): { dir: string; argvFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'verify-whole-suite-'))
  cleanup.push(dir)
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir }) }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFiles(dir, { 'orchestrator/src/thing.ts': 'export const a = 1\n' })
  git('add', '.')
  git('commit', '-q', '-m', 'initial')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  writeFileSync(join(dir, 'orchestrator/src/thing.ts'), 'export const a = 2\n')
  git('commit', '-q', '-am', 'change')

  const argvFile = join(dir, 'argv.txt')
  const bin = join(dir, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  const runner = join(bin, 'vitest')
  writeFileSync(runner, [
    '#!/bin/sh',
    'OUT=""',
    `: > ${JSON.stringify(argvFile)}`,
    `for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvFile)}; case "$a" in --outputFile=*) OUT="\${a#--outputFile=}" ;; esac; done`,
    `printf '%s' '${GREEN}' > "$OUT"`,
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(runner, 0o755)
  return { dir, argvFile }
}

const fleetLane: Lane = {
  id: 'test', mode: 'live', cap: 1, engine: 'claude',
  requireLabel: 'agent-dispatchable', vetoLabels: [],
  scope: { owned: ['orchestrator/'], notOwned: [] },
}

describe('rail: a suite the gate runs, it runs whole (#1587)', () => {
  it('hands the runner no positional filter — the config decides which tests are the suite', async () => {
    const { dir, argvFile } = repoRecordingArgv()
    const report = await verifyMechanical({ worktree: dir, branch: 'main', lane: fleetLane })
    expect(report.testsPassed, report.reasons.join('\n')).toBe(true)

    const argv = readFileSync(argvFile, 'utf8').split('\n').filter((l) => l.length > 0)
    expect(argv[0]).toBe('run')
    // Flags and their values only. A positional argument here is a filename
    // filter, and a filter is exactly how #1587 ran 5206 of 5280 tests.
    const flagsTakingAValue = new Set(['--config', '--root'])
    const positionals: string[] = []
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i] as string
      if (arg.startsWith('--')) {
        if (flagsTakingAValue.has(arg)) i++
        continue
      }
      positionals.push(arg)
    }
    expect(positionals, `vitest was given a filename filter: ${positionals.join(', ')}`).toEqual([])
    // And the suite label never travels to the runner at all.
    expect(argv).not.toContain('orchestrator')
  })

  it('routes a change to a deploy/docker test into the suite that executes it', () => {
    // These files run inside `vitest.unit.config.ts`. Before #1587 no route
    // mentioned them, so editing one routed to NOTHING (`tests=none`) — the
    // inverse of the same hole.
    expect(testTargetsFor(['deploy/docker/tests/telephony/asterisk-bridge-contract.test.ts']))
      .toEqual(['worker-unit'])
  })

  it('names suites by the suite, never by a path that implies a narrower scope', () => {
    const everySuite = new Set([
      ...testTargetsFor(['apps/worker/lib/auth.ts']),
      ...testTargetsFor(['deploy/docker/tests/x.test.ts']),
      ...testTargetsFor(['orchestrator/src/tick.ts']),
      ...testTargetsFor(['tests/orchestrator/tick.test.ts']),
    ])
    expect(everySuite).toEqual(new Set(['worker-unit', 'orchestrator']))
    for (const suite of everySuite) {
      expect(suite, `"${suite}" looks like a path — a label that names a directory is what read as a scope`)
        .not.toMatch(/\//)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 2: every include glob of a routed config is reachable by a route.
// ---------------------------------------------------------------------------

/** The `include:` globs of a vitest config, read off the file. */
function includeGlobs(config: string): string[] {
  const src = readFileSync(join(process.cwd(), config), 'utf8')
  const m = /include:\s*\[([^\]]*)\]/.exec(src)
  if (!m) throw new Error(`no include: array in ${config} — the reader must not pass vacuously`)
  return [...(m[1] as string).matchAll(/["'`]([^"'`]+)["'`]/g)].map((g) => g[1] as string)
}

/** Globs no route prefix covers — the gate would run them without ever being
 *  triggered by a change to them. Pure, so the rail below can drive it with a
 *  glob the configs do not actually have. */
function unroutedGlobs(globs: readonly string[], prefixes: readonly string[]): string[] {
  return globs.filter((g) => !prefixes.some((p) => g.startsWith(p)))
}

describe('rail: the gate and the suite cannot disagree about which files a suite runs (#1587)', () => {
  it('covers every include glob of every routed config with a route prefix', () => {
    const configs = routedConfigs()
    expect(configs.length, 'no routed configs — the rail is vacuous').toBeGreaterThan(0)
    for (const { config, prefixes } of configs) {
      const globs = includeGlobs(config)
      expect(globs.length, `${config} declared no include globs`).toBeGreaterThan(0)
      expect(
        unroutedGlobs(globs, prefixes),
        `${config} runs files no TEST_ROUTES prefix covers, so a change to them triggers no suite`,
      ).toEqual([])
    }
  })

  it('reads deploy/docker/tests out of vitest.unit.config.ts rather than taking it on trust', () => {
    // The specific glob #1587 turned on: it is really in the backend's unit
    // config, which is why the backend lane is accountable for those files.
    expect(includeGlobs('vitest.unit.config.ts')).toContain('deploy/docker/tests/**/*.test.ts')
  })

  describe('the rail can fail', () => {
    it('catches a config glob that no route covers', () => {
      const prefixes = routedConfigs().find((c) => c.config === 'vitest.unit.config.ts')?.prefixes ?? []
      expect(prefixes.length).toBeGreaterThan(0)
      expect(unroutedGlobs(['sip-bridge/**/*.test.ts'], prefixes)).toEqual(['sip-bridge/**/*.test.ts'])
      // …and does not cry wolf over the globs that ARE covered.
      expect(unroutedGlobs(includeGlobs('vitest.unit.config.ts'), prefixes)).toEqual([])
    })
  })
})
