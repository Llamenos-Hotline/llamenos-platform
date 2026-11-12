// Every browser spec must run under the console-error guard (#1858).
//
// The guard (tests/console-guard.ts) only watches the specs that take their
// `test` from it. A spec that still imports `test` from '@playwright/test' and
// drives a `page` is a hole in that floor: a page error there is invisible again.
// This is the check that the next spec someone writes cannot quietly be one.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const TESTS = import.meta.dir

/** Specs that drive a page without the shared guard, and why that is not a hole. */
const EXEMPT: Readonly<Record<string, string>> = {
  'messaging-decryption.spec.ts':
    'opens its own admin/volunteer browser contexts and fails on any console error through a watcher of its own',
  'screenshots.spec.ts': 'on-demand capture (`bun run test:screenshots`); never part of a test run',
}

function specFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      return ['node_modules', 'live', 'desktop', 'integration', 'orchestrator', 'steps', 'storage'].includes(entry.name)
        ? []
        : specFiles(full)
    }
    return entry.name.endsWith('.spec.ts') ? [full] : []
  })
}

const GUARDED_IMPORT = /from '(\.\.?\/)(console-guard|fixtures\/auth)'/
const DRIVES_A_PAGE = /async \(\{[^}]*\b(page|adminPage|volunteerPage|hubAdminPage|reviewerPage|reporterPage)\b[^}]*\}/

describe('console-error guard coverage', () => {
  test('every spec that drives a page takes its `test` from the guard', () => {
    const unguarded = specFiles(TESTS)
      .map((file) => ({ file, rel: relative(TESTS, file), source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => DRIVES_A_PAGE.test(source))
      .filter(({ rel, source }) => !GUARDED_IMPORT.test(source) && !(rel.split('/').pop()! in EXEMPT))
      .map(({ rel }) => rel)
    expect(
      unguarded,
      `import { test, expect } from './console-guard' (or '../console-guard') instead of '@playwright/test'`,
    ).toEqual([])
  })

  test('the exemptions still name files that exist and still avoid the guard', () => {
    const present = new Set(specFiles(TESTS).map((f) => f.split('/').pop()!))
    for (const name of Object.keys(EXEMPT)) {
      expect(present.has(name), `${name} no longer exists — drop its exemption`).toBe(true)
    }
  })
})
