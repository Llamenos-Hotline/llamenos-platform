// @suite: repo
// A browser spec never deletes a hub, and never adopts one it did not create (#2524).
//
// The `chromium` Playwright project runs fullyParallel — four workers, one
// backend, ONE admin identity. Every hub a spec creates through the API puts
// that admin in it, and every admin client in every other worker then polls it
// (calls, conversations, incidents, hub keys — a member polls EVERY member hub,
// never just the active one). So deleting a hub is not local cleanup: it turns
// the next poll of every other live admin client into a `404 Hub not found`,
// which Chrome reports as a console error before any client code sees it. The
// console guard then fails whichever spec happened to be running, and a spec
// that watches its own console (messaging-decryption) fails on its own.
//
// That is messaging-decryption's flake: across 238 recent merge-group runs of
// the spec, 197 failed their first attempt, and the largest single group (97)
// was "admin console was not clean" — 404s from a hub another worker had just
// deleted. Another 45 (a conversation or its thread vanishing, the pre-claim
// plaintext never arriving, the claim button never hiding) are what the same
// hub disappearing one step earlier looks like; slow logins that never reach
// the PIN or dashboard are a separate class this guard does not claim to
// explain. Adopting `hubs[0]` is the defect from the other end: the spec borrows a hub whose creator deletes it at
// the end of ITS test, under the borrower.
//
// The rule that removes the class: create a hub of your own (unique name) and
// leave it. Hubs die with the database, which every run resets. This guard
// pins it, so the next spec that "cleans up after itself" fails here, on the
// first attempt, instead of costing a retry in a merge group a week later.
//
// Backend BDD (tests/steps/backend) is out of scope: it drives the API with no
// browser client polling anything, and it owns its hubs per scenario.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const TESTS = import.meta.dir

/** Mirrors the `chromium` project's `testIgnore` in playwright.config.ts, plus the trees that hold no browser spec. */
const SKIP_DIRS = new Set([
  'node_modules', 'live', 'desktop', 'integration', 'orchestrator', 'steps', 'storage', 'generated',
  'playwright-report', 'test-results',
])

/** On-demand capture (`bun run test:screenshots`); never part of a test run, so nothing else is polling beside it. */
const NOT_A_RUN: Readonly<Record<string, string>> = {
  'screenshots.spec.ts': 'on-demand capture; never runs beside another spec',
}

function browserSpecs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : browserSpecs(full)
    return entry.name.endsWith('.spec.ts') ? [full] : []
  })
}

/** `deleteHubViaApi(...)`, `deleteHubViaApiIfPresent(...)`, or a DELETE of a `/hubs/<id>` path through any request helper. */
const DELETES_A_HUB = /\bdeleteHubViaApi(?:IfPresent)?\b|\b(?:apiDelete|delete)\s*\(\s*[^)]*[`'"]\/(?:api\/)?hubs\//

/** Taking whatever hub the server lists first: `hubs[0]`, `hubs?.[0]`, `data.hubs?.[0]?.id`. */
const ADOPTS_A_HUB = /\bhubs\??\.?\[0\]/

export interface Hit {
  line: number
  text: string
}

function scan(source: string, pattern: RegExp): Hit[] {
  const hits: Hit[] = []
  source.split('\n').forEach((text, i) => {
    // A line comment explaining the rule is not a use of it.
    const code = text.replace(/^\s*(\/\/|\*|\/\*).*$/, '')
    if (pattern.test(code)) hits.push({ line: i + 1, text: text.trim() })
  })
  return hits
}

export const findHubDeletions = (source: string): Hit[] => scan(source, DELETES_A_HUB)
export const findHubAdoptions = (source: string): Hit[] => scan(source, ADOPTS_A_HUB)

function offenders(find: (source: string) => Hit[]): string[] {
  return browserSpecs(TESTS)
    .map((file) => ({ rel: relative(TESTS, file), source: readFileSync(file, 'utf8') }))
    .filter(({ rel }) => !(rel in NOT_A_RUN))
    .flatMap(({ rel, source }) => find(source).map((h) => `${rel}:${h.line}  ${h.text}`))
}

describe('hub lifecycle in browser specs (#2524)', () => {
  test('no browser spec deletes a hub', () => {
    expect(
      offenders(findHubDeletions),
      'a deleted hub is a 404 in every other worker\'s admin client — create a uniquely named hub and leave it',
    ).toEqual([])
  })

  test('no browser spec adopts the first hub the server lists', () => {
    expect(
      offenders(findHubAdoptions),
      'the hub belongs to whoever created it, and they may delete it — create your own with createOwnHubViaApi',
    ).toEqual([])
  })

  test('recognises the shapes the bug took', () => {
    expect(findHubDeletions('await deleteHubViaApi(request, hubId)')).toHaveLength(1)
    expect(findHubDeletions('if (!existing) await deleteHubViaApi(request, hubId)')).toHaveLength(1)
    expect(findHubDeletions('await deleteHubViaApiIfPresent(request, id)')).toHaveLength(1)
    expect(findHubDeletions('await apiDelete(request, `/hubs/${hubId}`)')).toHaveLength(1)
    expect(findHubDeletions("await request.delete('/api/hubs/' + id)")).toHaveLength(1)
    expect(findHubDeletions("await request.delete(`/api/hubs/${id}`)")).toHaveLength(1)
    expect(findHubAdoptions('const existing = data?.hubs?.[0]?.id')).toHaveLength(1)
    expect(findHubAdoptions('const id = hubList.hubs[0]?.id')).toHaveLength(1)
  })

  test('ignores prose and unrelated calls', () => {
    expect(findHubDeletions('// never call deleteHubViaApi from a spec')).toHaveLength(0)
    expect(findHubDeletions(' * deleteHubViaApi removes it')).toHaveLength(0)
    expect(findHubDeletions('await apiDelete(request, `/notes/${noteId}`)')).toHaveLength(0)
    expect(findHubDeletions('await createHubViaApi(request, name)')).toHaveLength(0)
    expect(findHubAdoptions('const volunteerHubs = hubs.filter(Boolean)')).toHaveLength(0)
    expect(findHubAdoptions('expect(serverOrder.indexOf(volunteerHubId)).toBeGreaterThan(0)')).toHaveLength(0)
  })
})
