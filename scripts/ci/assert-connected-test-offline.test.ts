// @suite: repo
// scripts/ci/assert-connected-test-offline.sh (#2971) against a stub gradle launcher.
//
// The stub plays the three things `gradlew --offline connectedDebugAndroidTest` can do with no
// device attached: stop at "No connected devices!" (everything resolved from the cache), fail
// resolving an unprimed configuration (the #2971 failure, in Gradle's offline wording), or fail
// for a reason this check cannot attribute.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'assert-connected-test-offline.sh')

const STUB_GRADLE = `#!/usr/bin/env bash
echo "gradle $*" >> "$STUB_CALLS"
mkdir -p "$ANDROID_BUILD_DIR/outputs/androidTest-results/connected" "$ANDROID_BUILD_DIR/reports/androidTests"
case "$STUB_MODE" in
  primed)
    echo "> Task :app:connectedDebugAndroidTest FAILED"
    echo "* What went wrong:"
    echo "Execution failed for task ':app:connectedDebugAndroidTest'."
    echo "> com.android.builder.testing.api.DeviceException: No connected devices!"
    echo "BUILD FAILED in 4s"; exit 1 ;;
  device-attached) echo "BUILD SUCCESSFUL in 4s"; exit 0 ;;
  utp-unprimed)
    echo "> Task :app:connectedDebugAndroidTest FAILED"
    echo "Execution failed for task ':app:connectedDebugAndroidTest'."
    echo "> Could not resolve all files for configuration ':app:_internal-unified-test-platform-android-test-plugin-host-additional-test-output'."
    echo "   > Could not resolve com.android.tools.utp:android-test-plugin-host-additional-test-output:32.1.0."
    echo "      > No cached version of com.android.tools.utp:android-test-plugin-host-additional-test-output:32.1.0 available for offline mode."
    echo "BUILD FAILED in 3s"; exit 1 ;;
  offline-wording-only)
    echo "> No cached version of com.google.protobuf:protobuf-java:4.28.3 available for offline mode."
    echo "BUILD FAILED"; exit 1 ;;
  unrelated) echo "e: Foo.kt:3:5 unresolved reference: bar"; echo "BUILD FAILED"; exit 1 ;;
esac
`

let dir: string
let calls: string
let buildDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'assert-offline-test-'))
  calls = join(dir, 'calls.log')
  buildDir = join(dir, 'build')
  writeFileSync(calls, '')
  writeFileSync(join(dir, 'gradlew'), STUB_GRADLE)
  chmodSync(join(dir, 'gradlew'), 0o755)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(mode: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(['bash', SCRIPT], {
    env: {
      PATH: process.env.PATH ?? '',
      GRADLE_BIN: join(dir, 'gradlew'),
      ANDROID_BUILD_DIR: buildDir,
      RUNNER_TEMP: dir,
      STUB_CALLS: calls,
      STUB_MODE: mode,
      ...env,
    },
  })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString(), invocations: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) }
}

describe('assert-connected-test-offline.sh', () => {
  test('runs connectedDebugAndroidTest with --offline, once, and nothing else', () => {
    const r = run('primed')
    expect(r.invocations).toEqual(['gradle --offline connectedDebugAndroidTest --console=plain'])
  })

  test('passes when everything resolved from the cache and Gradle stopped at "No connected devices!"', () => {
    const r = run('primed')
    expect(r.code).toBe(0)
    expect(r.out).toContain('no network')
  })

  test('passes when a device is attached and the task simply succeeded', () => {
    expect(run('device-attached').code).toBe(0)
  })

  // The #2971 failure: the Unified Test Platform classpath was never put in the cache.
  test('FAILS on an unprimed configuration, and names it', () => {
    const r = run('utp-unprimed')
    expect(r.code).toBe(1)
    expect(r.out).toContain('::error title=connectedDebugAndroidTest needs the network')
    expect(r.out).toContain('_internal-unified-test-platform-android-test-plugin-host-additional-test-output')
  })

  test("FAILS on Gradle's offline-mode wording alone, without relying on the shared resolution patterns", () => {
    const none = join(dir, 'none.patterns')
    writeFileSync(none, 'zzz-never-matches\n')
    expect(run('offline-wording-only', { GRADLE_RESOLUTION_PATTERNS: none }).code).toBe(1)
  })

  test('FAILS, rather than passes, when Gradle failed for a reason it cannot attribute', () => {
    const r = run('unrelated')
    expect(r.code).toBe(1)
    expect(r.out).toContain('offline check inconclusive')
  })

  test('a missing pattern file is a hard error, and Gradle is not run', () => {
    const r = run('primed', { GRADLE_RESOLUTION_PATTERNS: join(dir, 'absent.patterns') })
    expect(r.code).toBe(2)
    expect(r.invocations).toHaveLength(0)
  })

  test('removes the empty result directories it caused, so the classifier reads nothing of its own', () => {
    run('primed')
    expect(existsSync(join(buildDir, 'outputs', 'androidTest-results'))).toBe(false)
    expect(existsSync(join(buildDir, 'reports', 'androidTests'))).toBe(false)
  })

  test('leaves result directories that were there before it ran', () => {
    mkdirSync(join(buildDir, 'outputs', 'androidTest-results'), { recursive: true })
    run('primed')
    expect(existsSync(join(buildDir, 'outputs', 'androidTest-results'))).toBe(true)
  })
})
