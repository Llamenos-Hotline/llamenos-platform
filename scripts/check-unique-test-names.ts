#!/usr/bin/env bun
/**
 * Reject a test resource name whose only source of uniqueness is `Date.now()`.
 *
 * Why this rail exists
 * --------------------
 * `Date.now()` has millisecond resolution and the backend BDD suite runs
 * scenarios in parallel workers against one server. Two workers reaching the
 * same step in the same millisecond ask for the same hub, slug or type name,
 * and the second gets 409 Conflict. Issue #1632: that ejected PR #1626 from the
 * merge queue twice in one hour, from two different files
 * (`bdd-sec-other-${Date.now()}`, then `bdd-hub-key-${Date.now()}`). Because
 * backend-bdd only runs in the merge queue, the race never shows on the PR that
 * introduces it — it lands as an ejection of somebody else's PR.
 *
 * What it catches
 * ---------------
 * A template literal that interpolates `${Date.now()}` and contains nothing
 * random (`Math.random()` / `randomUUID()`), sitting on one line in one of the
 * three positions that hit a uniqueness constraint:
 *
 *   slug       a `slug` / `*Slug` property or variable. Hub, role and provider
 *              template slugs are unique server-wide.
 *   hub-name   the name argument of `createHubViaApi(`. The server derives the
 *              hub's (unique) slug from the name.
 *   type-name  a `name` property or variable whose literal is snake_case up to
 *              the timestamp (`foo_${Date.now()}`). Entity and report type
 *              names are unique per hub, and the server only accepts
 *              [A-Za-z0-9_] for them — that trailing `_` is what tells them
 *              apart from display names.
 *
 * What it deliberately does NOT catch
 * -----------------------------------
 *   - Display names (`name: \`Auth Test ${Date.now()}\``) for users, shifts and
 *     reports. Nothing constrains them, so two equal ones are harmless; flagging
 *     them would be noise.
 *   - Timestamps used as times — `timestamp: Date.now()`, deadlines, expiry
 *     arithmetic. They are not template literals in a name position.
 *   - Lookup keys with no database constraint (Signal contact numbers, hub
 *     phone numbers). A clash there is not a 409.
 *   - A value built in one statement and passed as a slug or type name through
 *     a variable that is not itself called `*slug` / `name`, or an expression
 *     split across lines. The scan is line-local on purpose: it has no type
 *     information, and guessing data flow would trade false negatives for false
 *     positives.
 *   - Files outside SCAN_ROOTS. The desktop E2E steps also run in parallel and
 *     carry the same pattern; they are not covered yet.
 *
 * The fix is always `uniqueName(prefix)` from tests/api-helpers.ts
 * (`uniqueName(prefix, '_')` for an entity or report type name).
 *
 * Verified by injection: every run first checks the matcher against CANARIES,
 * so the rail fails if its own patterns stop catching the defect. Re-introduce
 * `createHubViaApi(request, \`x-${Date.now()}\`)` in any scanned file and it
 * must exit non-zero, naming the line.
 *
 * Exit code: 0 = clean, 1 = violation(s) or a canary the matcher misjudged.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')
const SCAN_ROOTS = ['tests/steps/backend', 'tests/api-helpers.ts']

type Kind = 'slug' | 'hub-name' | 'type-name'

const TEMPLATE_LITERAL = /`(?:[^`\\]|\\.)*`/g
const TIMESTAMP = '${Date.now()}'
const RANDOMNESS = /Math\.random\(\)|randomUUID\(\)/
// What must immediately precede the literal for each position. `(?:...\?\?\s*)?`
// admits a default (`options?.slug ?? \`...\``).
const DEFAULT = String.raw`(?:[^,;]*\?\?\s*)?`
const SLUG_POSITION = new RegExp(String.raw`\b\w*[sS]lug\s*[:=]\s*${DEFAULT}$`)
const HUB_NAME_POSITION = /\bcreateHubViaApi\(\s*[^,()]+,\s*$/
const NAME_POSITION = new RegExp(String.raw`\bname\s*[:=]\s*${DEFAULT}$`)
const SNAKE_BEFORE_TIMESTAMP = /_\$\{Date\.now\(\)\}/

function classify(line: string): Kind | null {
  for (const match of line.matchAll(TEMPLATE_LITERAL)) {
    const literal = match[0]
    if (!literal.includes(TIMESTAMP) || RANDOMNESS.test(literal)) continue
    const before = line.slice(0, match.index)
    if (SLUG_POSITION.test(before)) return 'slug'
    if (HUB_NAME_POSITION.test(before)) return 'hub-name'
    if (NAME_POSITION.test(before) && SNAKE_BEFORE_TIMESTAMP.test(literal)) return 'type-name'
  }
  return null
}

// The defect, and the legitimate uses the rail must leave alone. Checked on
// every run: a matcher that stops recognising these fails here, not silently.
const CANARIES: Array<[line: string, expected: Kind | null]> = [
  ['const otherHubId = await createHubViaApi(request, `bdd-sec-other-${Date.now()}`)', 'hub-name'],
  ['  const slug = `bdd-hub-key-${Date.now()}`', 'slug'],
  ['    slug: `viewer-${Date.now()}`,', 'slug'],
  ['  const holderRoleSlug = `recovery-holder-${Date.now()}`', 'slug'],
  ['  const name = options?.name ?? `test_type_${Date.now()}`', 'type-name'],
  ['    name: `test_${category}_type_${Date.now()}`,', 'type-name'],
  ['const hubId = await createHubViaApi(request, `epic-e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)', null],
  ['    slug: uniqueName(\'viewer\'),', null],
  ['    name: `Auth Test ${Date.now()}`,', null],
  ['  const timestamp = Date.now()', null],
  ['    callId: `test-call-${Date.now()}`,', null],
  ['    timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(),', null],
]

function listFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path]
  return readdirSync(path)
    .sort()
    .flatMap((entry) => listFiles(join(path, entry)))
    .filter((file) => file.endsWith('.ts'))
}

function main(): number {
  const misjudged = CANARIES.filter(([line, expected]) => classify(line) !== expected)
  if (misjudged.length > 0) {
    console.error('FAIL: the matcher misjudges its own canaries — fix the patterns before trusting a pass:')
    for (const [line, expected] of misjudged) {
      console.error(`  expected ${expected ?? 'no match'}, got ${classify(line) ?? 'no match'}: ${line.trim()}`)
    }
    return 1
  }

  const violations: string[] = []
  let scanned = 0
  for (const root of SCAN_ROOTS) {
    for (const file of listFiles(join(REPO_ROOT, root))) {
      scanned++
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const kind = classify(line)
        if (kind) violations.push(`  ${relative(REPO_ROOT, file)}:${i + 1}: [${kind}] ${line.trim()}`)
      })
    }
  }

  if (violations.length === 0) {
    console.log(`OK: no Date.now()-only slug, hub name or type name in ${scanned} files.`)
    return 0
  }

  console.error('FAIL: resource name(s) unique only to the millisecond — parallel workers collide (#1632):\n')
  console.error(violations.join('\n'))
  console.error(
    "\nUse uniqueName(prefix) from tests/api-helpers.ts — uniqueName(prefix, '_') for an\n" +
      'entity or report type name. It adds a random suffix, so two workers in the same\n' +
      'millisecond still get different names.',
  )
  return 1
}

if (import.meta.main) process.exit(main())
