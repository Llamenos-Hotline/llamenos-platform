import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #3102 — #3074 made a trust sign-off a hard precondition for producing a client artifact, and no
 * runbook said so: the first release after the trust snapshot moved would have been refused by an
 * undocumented step, at the moment pressure to work around it is highest.
 *
 * The gate is enforced elsewhere (`packages/protocol/tools/trust-release.test.ts`, and exit 3 from
 * `sign-artifacts.sh` / `promote-release.sh`). What this pins is the PROSE: that every runbook which
 * produces a client artifact names the step, and that what the shared runbook QUOTES is what the
 * tool actually prints — a runbook quoting a message the tool no longer emits is how an operator
 * learns, at 2am, that the page cannot be trusted.
 */
const ROOT = join(import.meta.dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const ARTIFACT_RUNBOOKS = ['docs/runbooks/android-release.md', 'docs/runbooks/desktop-update-release.md', 'docs/deployment/ios-distribution.md']
const RUNBOOK = 'docs/runbooks/trust-signoff.md'

describe('the trust sign-off is documented where a client artifact is produced', () => {
  it.each(ARTIFACT_RUNBOOKS)('%s names the step and points at the shared runbook', (path) => {
    const text = read(path)
    expect(text).toContain('bun run trust:release-check')
    expect(text).toContain('trust-signoff.md')
    expect(text).toContain('bun run trust:signoff')
  })

  it('every `bun run trust:*` command the runbook gives is a real package script', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
    const used = new Set([...read(RUNBOOK).matchAll(/bun run (trust:[a-z-]+)/g)].map((m) => m[1] as string))
    expect(used.size).toBeGreaterThan(0)
    for (const name of used) expect(scripts[name], `${name} is not a package.json script`).toBeDefined()
  })

  it('quotes the refusals the tool actually prints', () => {
    const doc = read(RUNBOOK)
    // The verdict sentence is built from concatenated literals; join them so a phrase spanning a line break is found.
    const lib = read('packages/protocol/tools/trust-snapshot.ts').replace(/['`]\s*\+\s*\n\s*[`']/g, '')
    const cli = read('packages/protocol/tools/trust-snapshot-cli.ts')
    // The verdict sentence, verbatim from releaseVerdict().
    for (const phrase of [
      'the trust snapshot changed since the last release and no sign-off names its digest',
      'A wrong trust value disconnects every installed client and only an app-store release undoes it',
      'is unchanged since the last release',
      '(no previous release to compare against: every value is new)',
    ]) {
      expect(lib, `releaseVerdict no longer says: ${phrase}`).toContain(phrase)
      expect(doc, `the runbook no longer quotes: ${phrase}`).toContain(phrase)
    }
    for (const phrase of [
      'refusing: set TRUST_SIGNOFF_AS to an approver',
      'signing is a human act',
      'refusing: the digest must name THIS tree',
      'review it with trust:diff first',
      'this is a shallow clone with no release tags, so the previous release cannot be found',
    ]) {
      expect(`${lib}\n${cli}`, `the tool no longer says: ${phrase}`).toContain(phrase)
      expect(doc, `the runbook no longer quotes: ${phrase}`).toContain(phrase)
    }
    for (const script of ['sign', 'promote']) {
      const file = read(`scripts/release/${script}-${script === 'sign' ? 'artifacts' : 'release'}.sh`)
      const line = `FATAL: refusing to ${script} — the TLS trust snapshot changed since the last release and no sign-off names it.`
      expect(file, `${script} script no longer says its refusal`).toContain(line)
      expect(doc).toContain(line)
    }
  })

  it('names the whole approver the tool names, and offers no bypass', () => {
    const doc = read(RUNBOOK)
    expect(read('packages/protocol/tools/trust-snapshot.ts')).toContain("TRUST_SIGNOFF_APPROVERS: readonly string[] = ['rhonda-rodododo']")
    expect(doc).toContain('TRUST_SIGNOFF_AS=rhonda-rodododo')
    // The only mention of an override is the sentence that says there is none.
    for (const m of doc.matchAll(/--force|--skip|--no-verify|skip if/gi)) {
      const around = doc.slice(Math.max(0, m.index - 40), m.index + 40)
      expect(around, `the runbook offers a bypass near: ${around}`).toMatch(/no `--force`/)
    }
  })
})
