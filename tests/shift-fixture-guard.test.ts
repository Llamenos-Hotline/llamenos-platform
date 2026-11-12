// A shift fixture must never close at 23:59 (#2693, #2573).
//
// A shift window is half-open — `startTime <= now < endTime`
// (apps/worker/services/shifts.ts `isShiftActive`) — so `endTime: '23:59'` is
// off shift for the last minute of every UTC day. A fixture written that way
// passes at 14:00 and fails once in 1,440 runs, at 23:59, and the failure reads
// exactly like a routing or eligibility defect ("the app shows clocked in but
// the server would not ring this user"). Widening the window only moves the
// fuse; the always-on construct has no end.
//
// Build fixtures from `ALWAYS_ON_SHIFT` / `shiftWindowAroundHour`
// (packages/shared/shifts.ts). On a platform that cannot import them (Swift,
// Kotlin), `startTime == endTime` ("00:00" / "00:00") is the app's 24-hour shift.
//
// This guard scans every place a fixture lives for the two shapes the bug has
// taken: a quoted `23:59` literal, and a template-built `${…}:59` end time (the
// `Math.min(23, hour + 1)` clamp in the old dev routes).
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..')

/** Every tree that builds shifts for a test or seeds one for a dev environment. */
const FIXTURE_ROOTS = [
  'tests',
  'apps/ios/Tests',
  'apps/android/app/src/test',
  'apps/android/app/src/androidTest',
  'apps/worker/__tests__/integration',
  'apps/worker/__tests__/helpers',
  'apps/worker/routes/dev.ts',
]

const SOURCE_FILE = /\.(ts|tsx|mts|js|mjs|kt|swift|feature)$/
const SKIP_DIRS = new Set(['node_modules', 'generated', 'playwright-report', 'test-results', '.git'])

/** This file spells the forbidden shapes out in its own self-tests. */
const SELF = 'tests/shift-fixture-guard.test.ts'

/** A quoted 23:59 — `'23:59'`, `"23:59"` or a template literal. Timestamps (`T23:59:59Z`) are not matched. */
const QUOTED_2359 = /(['"`])23:59\1/
/** A template-built end time: `${hour + 1}:59`. */
const TEMPLATED_59 = /\}:59\s*[`'"]/

export interface Hit {
  line: number
  text: string
}

export function findHardCodedShiftEnds(source: string): Hit[] {
  const hits: Hit[] = []
  source.split('\n').forEach((text, i) => {
    const code = text.replace(/\s*(\/\/|\*|#).*$/, (m) => (/^\s*(\/\/|\*|#)/.test(m) ? '' : m))
    if (QUOTED_2359.test(code) || TEMPLATED_59.test(code)) hits.push({ line: i + 1, text: text.trim() })
  })
  return hits
}

function walk(path: string, out: string[]): void {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return
  if (st.isFile()) {
    if (SOURCE_FILE.test(path)) out.push(path)
    return
  }
  for (const name of readdirSync(path)) {
    if (SKIP_DIRS.has(name)) continue
    walk(join(path, name), out)
  }
}

function fixtureFiles(): string[] {
  const files: string[] = []
  for (const root of FIXTURE_ROOTS) walk(join(ROOT, root), files)
  return files.filter((f) => relative(ROOT, f) !== SELF)
}

describe('no shift fixture hard-codes a 23:59 end time', () => {
  test('scans the fixture trees (an empty scan would pass vacuously)', () => {
    const files = fixtureFiles().map((f) => relative(ROOT, f))
    expect(files.length).toBeGreaterThan(100)
    for (const needle of [
      'tests/steps/backend/common.steps.ts',
      'tests/steps/common/auth-steps.ts',
      'apps/worker/routes/dev.ts',
    ]) {
      expect(files).toContain(needle)
    }
    expect(files.some((f) => f.startsWith('apps/ios/Tests/'))).toBe(true)
  })

  test('none of them closes a shift at 23:59', () => {
    const offenders: string[] = []
    for (const file of fixtureFiles()) {
      for (const hit of findHardCodedShiftEnds(readFileSync(file, 'utf-8'))) {
        offenders.push(`${relative(ROOT, file)}:${hit.line}  ${hit.text}`)
      }
    }
    expect(
      offenders,
      'a shift ending at 23:59 is off shift for the last minute of every UTC day — use ALWAYS_ON_SHIFT / ' +
        'shiftWindowAroundHour from @shared/shifts (or startTime == endTime on a platform that cannot import it)',
    ).toEqual([])
  })
})

describe('the 23:59 check rejects the shapes the bug has taken', () => {
  const flagged = (src: string) => findHardCodedShiftEnds(src).length > 0

  test('a TypeScript object literal', () => {
    expect(flagged(`    endTime: '23:59',`)).toBe(true)
    expect(flagged(`    endTime: "23:59",`)).toBe(true)
  })
  test('a Swift JSON dictionary and a Kotlin named argument', () => {
    expect(flagged(`                "endTime": "23:59",`)).toBe(true)
    expect(flagged(`    endTime = "23:59",`)).toBe(true)
  })
  test('a clamped ternary', () => {
    expect(flagged("    endTime: hour + 2 > 23 ? '23:59' : `${pad(hour + 2)}:00`,")).toBe(true)
  })
  test('a template-built end time', () => {
    expect(flagged("const endTime = `${String(Math.min(23, hour + 1)).padStart(2, '0')}:59`")).toBe(true)
  })
  test('the always-on shapes and ISO timestamps pass', () => {
    expect(flagged(`    ...ALWAYS_ON_SHIFT,`)).toBe(false)
    expect(flagged(`    endTime: '00:00',`)).toBe(false)
    expect(flagged(`const to = \`\${year}-05-07T23:59:59.999Z\``)).toBe(false)
  })
  test('a comment that names the hazard is not a hit', () => {
    expect(flagged(`// a '23:59' end time is off shift for a minute`)).toBe(false)
    expect(flagged(` * window is clamped to "23:59" otherwise`)).toBe(false)
  })
})
