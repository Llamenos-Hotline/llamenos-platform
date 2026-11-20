/**
 * Rails for scripts/lib/ios-simulator.sh (#2861): the local iOS scripts pin the
 * simulator by UDID and never let xcodebuild resolve a name.
 *
 *   bun test scripts/lib/ios-simulator.test.ts
 *
 * Each test drives the real library through bash with a fake `xcrun` first on
 * PATH, serving a device set from a JSON file and recording `simctl create`.
 * No simulator is touched, so this runs on Linux.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const LIBRARY = resolve(import.meta.dir, 'ios-simulator.sh')
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'

interface Device {
  name: string
  udid: string
  isAvailable?: boolean
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ios-simulator-rail-'))
  const fake = join(tmp, 'xcrun')
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
set -eu
[ "$1" = simctl ] || { echo "fake xcrun: unexpected $*" >&2; exit 2; }
case "$2 \${3:-}" in
  "list devices") cat "$FAKE_DIR/devices.json" ;;
  "list runtimes") cat "$FAKE_DIR/runtimes.json" ;;
  "list devicetypes") cat "$FAKE_DIR/devicetypes.json" ;;
  "create "*)
    echo "$*" >> "$FAKE_DIR/creates.log"
    # refuse the first type, as a real simctl does for a type newer than the runtime
    if [ "$4" = "com.apple.CoreSimulator.SimDeviceType.iPhone-Future" ]; then
      echo "Incompatible device" >&2; exit 1
    fi
    echo "CREATED-UDID"
    ;;
  *) echo "fake xcrun: unexpected $*" >&2; exit 2 ;;
esac
`,
  )
  chmodSync(fake, 0o755)
  writeFileSync(
    join(tmp, 'runtimes.json'),
    JSON.stringify({ runtimes: [{ identifier: RUNTIME, version: '26.5', isAvailable: true, platform: 'iOS' }] }),
  )
  writeFileSync(
    join(tmp, 'devicetypes.json'),
    JSON.stringify({
      devicetypes: [
        { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Future', name: 'iPhone Future' },
        { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', name: 'iPhone 17' },
      ],
    }),
  )
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function setDevices(devices: Device[]): void {
  writeFileSync(
    join(tmp, 'devices.json'),
    JSON.stringify({
      devices: { [RUNTIME]: devices.map((d) => ({ isAvailable: true, ...d })) },
    }),
  )
}

function run(call: string): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['bash', '-c', `set -euo pipefail; source '${LIBRARY}'; ${call}`], {
    env: { ...process.env, PATH: `${tmp}:${process.env.PATH ?? ''}`, FAKE_DIR: tmp, TMPDIR: tmp },
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString().trim(), stderr: proc.stderr.toString() }
}

const creates = (): string[] =>
  existsSync(join(tmp, 'creates.log')) ? readFileSync(join(tmp, 'creates.log'), 'utf8').trim().split('\n') : []

describe('ios_sim_resolve_dedicated', () => {
  test('reuses the one device that carries the name, and creates nothing', () => {
    setDevices([
      { name: 'iPhone 17', udid: 'DEFAULT-UDID' },
      { name: 'llamenos-dev-ios', udid: 'OWNED-UDID' },
    ])
    const r = run('ios_sim_resolve_dedicated llamenos-dev-ios')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('OWNED-UDID')
    expect(creates()).toEqual([])
  })

  test('creates it when absent, skipping a type simctl refuses, and returns the new UDID', () => {
    setDevices([{ name: 'iPhone 17', udid: 'DEFAULT-UDID' }])
    const r = run('ios_sim_resolve_dedicated llamenos-dev-ios')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('CREATED-UDID')
    expect(creates()).toHaveLength(2)
    expect(creates()[1]).toContain(`llamenos-dev-ios com.apple.CoreSimulator.SimDeviceType.iPhone-17 ${RUNTIME}`)
  })

  test('never adopts an Xcode-default device: an empty dedicated name does not fall back to "iPhone 17"', () => {
    setDevices([{ name: 'iPhone 17', udid: 'DEFAULT-UDID' }])
    const r = run('ios_sim_resolve_dedicated llamenos-dev-ios')
    expect(r.stdout).not.toBe('DEFAULT-UDID')
  })

  test('fails loudly when two devices share the name, rather than taking the first', () => {
    setDevices([
      { name: 'llamenos-dev-ios', udid: 'FIRST-UDID' },
      { name: 'llamenos-dev-ios', udid: 'SECOND-UDID' },
    ])
    const r = run('ios_sim_resolve_dedicated llamenos-dev-ios')
    expect(r.code).not.toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('2 simulators are named')
    expect(r.stderr).toContain('FIRST-UDID')
    expect(r.stderr).toContain('SECOND-UDID')
    expect(creates()).toEqual([])
  })

  test('ignores an unavailable device of the same name', () => {
    setDevices([
      { name: 'llamenos-dev-ios', udid: 'STALE-UDID', isAvailable: false },
      { name: 'llamenos-dev-ios', udid: 'LIVE-UDID' },
    ])
    expect(run('ios_sim_resolve_dedicated llamenos-dev-ios').stdout).toBe('LIVE-UDID')
  })

  test('fails when simctl refuses every iPhone type', () => {
    setDevices([])
    writeFileSync(
      join(tmp, 'devicetypes.json'),
      JSON.stringify({
        devicetypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Future', name: 'iPhone Future' }],
      }),
    )
    const r = run('ios_sim_resolve_dedicated llamenos-dev-ios')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('simctl refused every iPhone device type')
  })
})

describe('ios_sim_resolve_override', () => {
  test('resolves a name to its single UDID', () => {
    setDevices([{ name: 'iPhone 17 Pro', udid: 'PRO-UDID' }])
    expect(run("ios_sim_resolve_override 'iPhone 17 Pro'").stdout).toBe('PRO-UDID')
  })

  test('accepts a UDID, case-insensitively', () => {
    setDevices([{ name: 'iPhone 17 Pro', udid: 'ABCD-1234' }])
    expect(run('ios_sim_resolve_override abcd-1234').stdout).toBe('ABCD-1234')
  })

  test('fails on zero matches and never creates a device for a typo', () => {
    setDevices([{ name: 'iPhone 17', udid: 'DEFAULT-UDID' }])
    const r = run("ios_sim_resolve_override 'iPhone 99'")
    expect(r.code).not.toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain("no available iOS simulator has the name or UDID 'iPhone 99'")
    expect(creates()).toEqual([])
  })

  test('fails on several matches and names the UDIDs so the human can pick one', () => {
    setDevices([
      { name: 'iPhone 17', udid: 'A-UDID' },
      { name: 'iPhone 17', udid: 'B-UDID' },
    ])
    const r = run("ios_sim_resolve_override 'iPhone 17'")
    expect(r.code).not.toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('A-UDID')
    expect(r.stderr).toContain('B-UDID')
  })
})

describe('the local scripts never name-resolve a simulator', () => {
  const scripts = ['ios-build.sh', 'test-ios.sh', 'test-feature.sh', 'extract-ios-screenshots.sh']
  test.each(scripts)('%s has no name= destination', (file) => {
    const text = readFileSync(resolve(import.meta.dir, '..', file), 'utf8')
    expect(text).not.toMatch(/platform=iOS Simulator,\s*name=/)
  })
})
