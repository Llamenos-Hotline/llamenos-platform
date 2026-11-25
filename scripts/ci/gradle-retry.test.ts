// @suite: repo
// scripts/ci/gradle-retry.sh (#2864) against a stub gradle launcher.
//
// The stub's behaviour per run is read from a script file: run N takes line N
// (the last line repeats). A line is `ok`, `resolve-miss` (the exact failure of
// merge group 44432600870), `timeout`, `test-fail` or `compile-fail`; `utp-miss` is the #2969
// failure, and `connected-test-fail` / `probe-fail` are test results whose own text looks like
// a transport error.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'gradle-retry.sh')

const STUB_GRADLE = `#!/usr/bin/env bash
echo "gradle $*" >> "$STUB_CALLS"
n=$(wc -l < "$STUB_CALLS")
mode=$(sed -n "\${n}p" "$STUB_PLAN"); [ -n "$mode" ] || mode=$(tail -n 1 "$STUB_PLAN")
case "$mode" in
  ok) echo "BUILD SUCCESSFUL in 3s"; exit 0 ;;
  resolve-miss)
    echo "> Task :app:processDebugUnitTestManifest FAILED"
    echo "> Could not resolve all files for configuration ':app:debugUnitTestRuntimeClasspath'."
    echo "   > Could not find junit:junit:4.13.2."
    echo "     Searched in the following locations:"
    echo "       - https://repo.maven.apache.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom"
    echo "BUILD FAILED in 37s"; exit 1 ;;
  jar-miss)
    case " $* " in *" --refresh-dependencies "*) echo "BUILD SUCCESSFUL in 3s"; exit 0 ;; esac
    echo "> Task :app:checkDebugDuplicateClasses FAILED"
    echo "> Could not resolve all files for configuration ':app:debugRuntimeClasspath'."
    echo "   > Failed to transform gson-2.8.9.jar (com.google.code.gson:gson:2.8.9) to match attributes {artifactType=enumerated-runtime-classes}."
    echo "      > Could not find gson-2.8.9.jar (com.google.code.gson:gson:2.8.9)."
    echo "        Searched in the following locations:"
    echo "            https://repo.maven.apache.org/maven2/com/google/code/gson/gson/2.8.9/gson-2.8.9.jar"
    echo "BUILD FAILED in 11s"; exit 1 ;;
  rate-limit)
    echo "> Could not resolve all files for configuration ':app:debugUnitTestRuntimeClasspath'."
    echo "   > Could not GET 'https://repo.maven.apache.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom'. Received status code 429 from server: Too Many Requests"
    echo "BUILD FAILED in 46s"; exit 1 ;;
  plugin-miss)
    echo "* What went wrong:"
    echo "Plugin [id: 'com.google.dagger.hilt.android', version: '2.59.2', apply: false] was not found in any of the following sources:"
    echo "- Plugin Repositories (could not resolve plugin artifact 'com.google.dagger.hilt.android:com.google.dagger.hilt.android.gradle.plugin:2.59.2')"
    echo "BUILD FAILED in 840ms"; exit 1 ;;
  timeout) echo "> Could not GET 'https://repo.maven.apache.org/x.pom'. Read timed out"; echo "BUILD FAILED"; exit 1 ;;
  utp-miss)
    echo "> Task :app:connectedDebugAndroidTest FAILED"
    echo "M1 probe gate: all 6 required flows pass"
    echo "* What went wrong:"
    echo "Execution failed for task ':app:connectedDebugAndroidTest'."
    echo "> Could not resolve all files for configuration ':app:_internal-unified-test-platform-android-test-plugin-host-additional-test-output'."
    echo "   > Could not find com.google.protobuf:protobuf-java:4.28.3."
    echo "BUILD FAILED in 1m"; exit 1 ;;
  connected-test-fail)
    echo ".Admin Sidebar Navigation > t0[emulator-5554 - 14] FAILED"
    echo "    java.lang.AssertionError: createTestHub FAILED after 3 attempts (hubUrl=http://10.0.2.2:3000)"
    echo "    Caused by: java.net.ConnectException: Failed to connect to /10.0.2.2:3000"
    echo "    Caused by: java.net.ConnectException: Connection refused"
    echo "> Task :app:connectedDebugAndroidTest FAILED"
    echo "> There were failing tests. See the report at: file:///x"
    echo "BUILD FAILED in 4m"; exit 1 ;;
  probe-fail)
    echo "> Task :app:m1ProbeGate FAILED"
    echo "M1 probe FAIL auth"
    echo "> Could not GET 'https://repo.maven.apache.org/x.pom'. Received status code 503 from server: Service Unavailable"
    echo "BUILD FAILED"; exit 1 ;;
  test-fail) echo "> Task :app:testDebugUnitTest FAILED"; echo "FooTest > bar FAILED"; echo "BUILD FAILED in 2m"; exit 1 ;;
  compile-fail) echo "e: file:///x/Foo.kt:3:5 Could not compile: unresolved reference: bar"; echo "BUILD FAILED"; exit 1 ;;
esac
`

let dir: string
let calls: string
let plan: string
let summary: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gradle-retry-test-'))
  calls = join(dir, 'calls.log')
  plan = join(dir, 'plan.txt')
  summary = join(dir, 'summary.md')
  writeFileSync(calls, '')
  writeFileSync(join(dir, 'gradlew'), STUB_GRADLE)
  chmodSync(join(dir, 'gradlew'), 0o755)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(modes: string[], args: string[] = ['testDebugUnitTest', '--console=plain'], env: Record<string, string> = {}) {
  writeFileSync(plan, modes.join('\n') + '\n')
  const r = Bun.spawnSync(['bash', SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      GRADLE_BIN: join(dir, 'gradlew'),
      GRADLE_RETRY_BACKOFF_SEC: '0',
      GRADLE_RATE_LIMIT_BACKOFF_SEC: '0',
      RUNNER_TEMP: dir,
      GITHUB_STEP_SUMMARY: summary,
      STUB_CALLS: calls,
      STUB_PLAN: plan,
      ...env,
    },
  })
  const invocations = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean)
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString(), invocations }
}

describe('gradle-retry.sh', () => {
  test('a clean build runs Gradle once, unmodified, and says nothing', () => {
    const r = run(['ok'])
    expect(r.code).toBe(0)
    expect(r.invocations).toHaveLength(1)
    expect(r.invocations[0]).toContain('testDebugUnitTest --console=plain')
    expect(r.out).not.toContain('::warning')
  })

  test('the #2864 failure — one POM miss — is survived by a retry', () => {
    const r = run(['resolve-miss', 'ok'])
    expect(r.code).toBe(0)
    expect(r.invocations).toHaveLength(2)
    expect(r.invocations[1]).toContain('testDebugUnitTest --console=plain')
  })

  test('the #2866 failure — a remembered JAR miss — is cleared by --refresh-dependencies, never by a plain re-run', () => {
    const r = run(['jar-miss'])
    expect(r.code).toBe(0)
    expect(r.invocations).toHaveLength(2)
    expect(r.invocations[0]).not.toContain('--refresh-dependencies')
    expect(r.invocations[1]).toContain('--refresh-dependencies')
    expect(r.invocations[1]).toContain('testDebugUnitTest --console=plain')
    expect(r.out).toContain('gson-2.8.9.jar')
    expect(r.out).toMatch(/::warning title=[^:]*recovered on attempt 2/)
  })

  test('a transport error does NOT trigger --refresh-dependencies (Gradle forgets it; refresh would hammer the registry)', () => {
    const r = run(['timeout', 'ok'])
    expect(r.code).toBe(0)
    expect(r.invocations.every((c) => !c.includes('--refresh-dependencies'))).toBe(true)
  })

  test('the first attempt of a clean build never refreshes', () => {
    const r = run(['ok'])
    expect(r.invocations[0]).not.toContain('--refresh-dependencies')
  })

  test('a recovered retry is visible: a warning naming the dependency, and a step summary', () => {
    const r = run(['resolve-miss', 'ok'])
    expect(r.out).toMatch(/::warning title=[^:]*recovered on attempt 2/)
    expect(r.out).toContain('junit:junit:4.13.2')
    expect(readFileSync(summary, 'utf8')).toContain('transient failure survived')
  })

  // Run 44695746293 (android-compile-check): attempt 1 "Could not find <jar>", attempt 2 (refreshed) failed on a
  // PLUGIN fetch, which Gradle words differently. The script called it "no dependency-resolution error" and quit.
  test('a plugin that could not be resolved is a resolution failure, retried like any other', () => {
    const r = run(['plugin-miss', 'ok'])
    expect(r.code).toBe(0)
    expect(r.invocations).toHaveLength(2)
  })

  test('a transport timeout is retried too', () => {
    const r = run(['timeout', 'ok'])
    expect(r.code).toBe(0)
    expect(r.invocations).toHaveLength(2)
  })

  test('a persistent miss fails after every attempt, with Gradle exit status and an error annotation', () => {
    const r = run(['resolve-miss'], undefined, { GRADLE_RETRY_ATTEMPTS: '3' })
    expect(r.code).toBe(1)
    expect(r.invocations).toHaveLength(3)
    expect(r.out).toMatch(/::error title=[^:]*failed on all 3 attempts/)
  })

  test('a failing test is returned after exactly one run — never retried', () => {
    const r = run(['test-fail', 'ok'])
    expect(r.code).toBe(1)
    expect(r.invocations).toHaveLength(1)
    expect(r.out).toContain('not retrying')
  })

  // #2969: the one invocation that had no guard. The failure arrives at the START of connectedDebugAndroidTest,
  // so a retry costs a re-run, not a lost suite.
  test('the #2969 failure — the Unified Test Platform classpath missing a jar — is retried', () => {
    const r = run(['utp-miss', 'ok'], ['connectedDebugAndroidTest', '--console=plain'])
    expect(r.code).toBe(0)
    expect(r.invocations).toHaveLength(2)
    expect(r.invocations[1]).toContain('--refresh-dependencies')
    expect(r.invocations[1]).toContain('connectedDebugAndroidTest')
  })

  // #2971: the emulator run is `--offline` with ONE attempt. A retry would add --refresh-dependencies, which
  // asks Central for everything again: the wrong move against a throttled address, and meaningless offline.
  test('#2971: GRADLE_RETRY_ATTEMPTS=1 runs once and never sends --refresh-dependencies, --offline passes through', () => {
    const r = run(['utp-miss', 'ok'], ['connectedDebugAndroidTest', '--offline', '--console=plain'], { GRADLE_RETRY_ATTEMPTS: '1' })
    expect(r.code).toBe(1)
    expect(r.invocations).toHaveLength(1)
    expect(r.invocations[0]).toContain('--offline')
    expect(r.invocations[0]).not.toContain('--refresh-dependencies')
  })

  test('the retry stays bounded: a persistent #2969 miss runs exactly GRADLE_RETRY_ATTEMPTS times (default 3) and fails', () => {
    const r = run(['utp-miss'], ['connectedDebugAndroidTest'])
    expect(r.code).toBe(1)
    expect(r.invocations).toHaveLength(3)
  })

  // The half that matters more: a wrapper that retried every failure would re-run a red suite until it went green.
  test.each(['connected-test-fail', 'probe-fail'])('%s: a test result whose text looks like a transport error is returned after ONE run, never retried', (mode) => {
    const r = run([mode, 'ok'], ['connectedDebugAndroidTest'])
    expect(r.code).toBe(1)
    expect(r.invocations).toHaveLength(1)
    expect(r.out).toContain('after a test failure — not retrying')
  })

  test('what counts as "a test failed" is whatever gradle-test-failure.patterns says, and a missing file is a hard error', () => {
    const none = join(dir, 'none.patterns')
    writeFileSync(none, 'zzz-never-matches\n')
    expect(run(['connected-test-fail', 'ok'], ['connectedDebugAndroidTest'], { GRADLE_TEST_FAILURE_PATTERNS: none }).invocations).toHaveLength(2)
    writeFileSync(calls, '')
    const missing = run(['ok'], undefined, { GRADLE_TEST_FAILURE_PATTERNS: join(dir, 'absent.patterns') })
    expect(missing.code).toBe(2)
    expect(missing.invocations).toHaveLength(0)
  })

  test('a compile error that says "Could not compile" is not mistaken for a registry failure', () => {
    const r = run(['compile-fail', 'ok'])
    expect(r.code).toBe(1)
    expect(r.invocations).toHaveLength(1)
  })

  test("Gradle's own HTTP retry budget is raised on every run", () => {
    const r = run(['ok'])
    expect(r.invocations[0]).toContain('-Dorg.gradle.internal.repository.max.retries=6')
  })

  test('a 429 is retried, and cuts Gradle\'s own per-artifact retries instead of multiplying the request rate (#2879)', () => {
    const r = run(['rate-limit', 'ok'])
    expect(r.code).toBe(0)
    expect(r.invocations).toHaveLength(2)
    // attempt 1: the normal budget — the first attempt never knows about a 429.
    expect(r.invocations[0]).toContain('-Dorg.gradle.internal.repository.max.retries=6')
    expect(r.invocations[0]).toContain('-Dorg.gradle.internal.repository.initial.backoff=500 ')
    // attempt 2: the registry asked us to slow down — small budget, long initial backoff.
    expect(r.invocations[1]).toContain('-Dorg.gradle.internal.repository.max.retries=2')
    expect(r.invocations[1]).toContain('-Dorg.gradle.internal.repository.initial.backoff=5000')
    expect(r.invocations[1]).not.toContain('--refresh-dependencies')
    expect(r.out).toContain('429 Too Many Requests')
  })

  test('after a 429 the delay uses the rate-limit base, not the transport one (#2879)', () => {
    const r = run(['rate-limit', 'ok'], undefined, { GRADLE_RETRY_BACKOFF_SEC: '0', GRADLE_RATE_LIMIT_BACKOFF_SEC: '1' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('retrying in 1s')
  })

  test('a transport error alone keeps the normal Gradle retry budget and the short backoff', () => {
    const r = run(['timeout', 'ok'], undefined, { GRADLE_RETRY_BACKOFF_SEC: '1', GRADLE_RATE_LIMIT_BACKOFF_SEC: '600' })
    expect(r.code).toBe(0)
    expect(r.invocations[1]).toContain('-Dorg.gradle.internal.repository.max.retries=6')
    expect(r.out).toContain('retrying in 1s')
  })

  test('a persistent 429 fails after every attempt with Gradle\'s exit status', () => {
    const r = run(['rate-limit'], undefined, { GRADLE_RETRY_ATTEMPTS: '3' })
    expect(r.code).toBe(1)
    expect(r.invocations).toHaveLength(3)
    expect(r.out).toMatch(/::error title=[^:]*failed on all 3 attempts/)
  })

  // One definition of "a resolution failure" (#2870): the retry decision is read from the pattern
  // files, not from a regex inlined in the script. A pattern file that classifies nothing must make
  // the same Gradle output non-retryable; a missing one must be refused, never treated as "no match".
  test('what is retried is whatever gradle-resolution.patterns says, not an inline regex (#2870)', () => {
    const empty = join(dir, 'none.patterns')
    writeFileSync(empty, 'zzz-never-matches\n')
    const r = run(['resolve-miss'], undefined, { GRADLE_RESOLUTION_PATTERNS: empty })
    expect(r.code).toBe(1)
    expect(r.invocations).toHaveLength(1)
    expect(r.out).toContain('no dependency-resolution error — not retrying')
  })

  test('which failures need --refresh-dependencies is whatever gradle-cached-miss.patterns says (#2870)', () => {
    const none = join(dir, 'none.patterns')
    writeFileSync(none, 'zzz-never-matches\n')
    const r = run(['jar-miss', 'jar-miss', 'jar-miss'], undefined, { GRADLE_CACHED_MISS_PATTERNS: none, GRADLE_RETRY_ATTEMPTS: '3' })
    expect(r.invocations).toHaveLength(3)
    expect(r.invocations.some((c) => c.includes('--refresh-dependencies'))).toBe(false)
  })

  test('a missing or empty pattern file is a hard error, never "nothing matches" (#2870)', () => {
    const empty = join(dir, 'empty.patterns')
    writeFileSync(empty, '')
    for (const env of <Record<string, string>[]>[{ GRADLE_RESOLUTION_PATTERNS: join(dir, 'absent.patterns') }, { GRADLE_CACHED_MISS_PATTERNS: empty }]) {
      const r = run(['ok'], undefined, env)
      expect(r.code).toBe(2)
      expect(r.invocations).toHaveLength(0)
      expect(r.out).toContain('is missing or empty')
    }
  })

  test('no Gradle arguments is a usage error, not a bare ./gradlew', () => {
    const r = run(['ok'], [])
    expect(r.code).toBe(2)
    expect(r.invocations).toHaveLength(0)
  })
})
