import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  artifactReviewCache, cacheArtifactName, reviewSetTag,
  CACHE_ARTIFACT_OUTPUT, CACHE_ARTIFACT_OUTPUT_SCOPED,
} from '../../orchestrator/src/review-cache.js'

/**
 * A recorded verdict is only a cache if the NAME `lookup()` queries is an
 * artifact that was actually uploaded.
 *
 * THE BUG. `runReviewCi` records a verdict twice — under the exact review
 * set's namespace and under the general one — and both `record()` calls
 * appended to ONE step output, `cache_artifact_name`. GitHub keeps the last
 * value, so `fleet-review.yml` uploaded only the general name. A PR whose set
 * carries a profile looks up the SCOPED name first and never found it: on
 * 2026-09-30, 309 general PASS artifacts existed and not one under a
 * `set-…` namespace. #1170 (a crypto-content PR) was reviewed PASS by
 * `general + crypto-security-reviewer` at 11:35 and the only artifact
 * uploaded was `fleet-review-pass-pr1170-…`, which its own next lookup could
 * not use. That is one full multi-reviewer review per re-request after a
 * rebase.
 *
 * These rails drive the real `record()` into a real `$GITHUB_OUTPUT` file,
 * then check fleet-review.yml uploads every name it wrote.
 */

const FLEET_REVIEW_YML = join(process.cwd(), '.github', 'workflows', 'fleet-review.yml')

interface Step { name?: string; id?: string; if?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, unknown> }

function steps(): Step[] {
  const wf = parseYaml(readFileSync(FLEET_REVIEW_YML, 'utf8')) as { jobs: Record<string, { steps?: Step[] }> }
  const s = wf.jobs['fleet-review']?.steps
  if (s === undefined || s.length === 0) throw new Error('no fleet-review steps — this rail must not pass vacuously')
  return s
}

const dirs: string[] = []
const saved = process.env['GITHUB_OUTPUT']
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  if (saved === undefined) delete process.env['GITHUB_OUTPUT']
  else process.env['GITHUB_OUTPUT'] = saved
})

/** Record one PASS the way `runReviewCi` does for a set with a profile:
 *  exact namespace first, then general. Returns the step outputs written. */
async function recordBothNamespaces(scope: string): Promise<{ outputs: Map<string, string>; files: string[] }> {
  const root = mkdtempSync(join(tmpdir(), 'review-cache-upload-'))
  dirs.push(root)
  const out = join(root, 'github-output')
  const cacheDir = join(root, 'review-cache')
  process.env['GITHUB_OUTPUT'] = out
  const key = { pr: '1170', diffHash: 'b4cc12c676f607c3'.padEnd(64, '0') }
  for (const s of [scope, undefined]) {
    await artifactReviewCache(cacheDir, () => {}, s).record(key, { verdict: 'PASS', text: 'VERDICT: PASS' })
  }
  // GitHub's own reading of `$GITHUB_OUTPUT`: a later line for a key wins.
  const outputs = new Map<string, string>()
  for (const line of readFileSync(out, 'utf8').split('\n').filter((l) => l.length > 0)) {
    const eq = line.indexOf('=')
    outputs.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return { outputs, files: readdirSync(cacheDir) }
}

describe('rail: every namespace a verdict is recorded under is uploaded under the name lookup() queries', () => {
  const scope = reviewSetTag(['crypto-security-reviewer'])
  if (scope === undefined) throw new Error('reviewSetTag gave no scope for a profile — this rail must not pass vacuously')
  const hash = 'b4cc12c676f607c3'.padEnd(64, '0')

  it('record() names each namespace under its own output key — neither overwrites the other', async () => {
    const { outputs, files } = await recordBothNamespaces(scope)
    expect(outputs.get(CACHE_ARTIFACT_OUTPUT_SCOPED)).toBe(cacheArtifactName('1170', hash, scope, 'PASS'))
    expect(outputs.get(CACHE_ARTIFACT_OUTPUT)).toBe(cacheArtifactName('1170', hash, undefined, 'PASS'))
    expect(files.sort()).toEqual([
      `${cacheArtifactName('1170', hash, scope, 'PASS')}.json`,
      `${cacheArtifactName('1170', hash, undefined, 'PASS')}.json`,
    ].sort())
  })

  it.each([CACHE_ARTIFACT_OUTPUT, CACHE_ARTIFACT_OUTPUT_SCOPED])(
    'fleet-review.yml uploads the artifact named by steps.review.outputs.%s, even when the review step failed',
    (output) => {
      const review = steps().find((s) => s.id === 'review')
      const cacheDir = String(review?.env?.['FLEET_REVIEW_CACHE_DIR'] ?? '')
      expect(cacheDir, 'the Review step no longer sets FLEET_REVIEW_CACHE_DIR').not.toBe('')
      const uploads = steps().filter((s) =>
        (s.uses ?? '').startsWith('actions/upload-artifact@') &&
        String(s.with?.['name'] ?? '').replace(/\s+/g, '') === `\${{steps.review.outputs.${output}}}`)
      expect(uploads, `no upload step for steps.review.outputs.${output} — a verdict recorded under it is never a cache hit`).toHaveLength(1)
      const [upload] = uploads
      // A substantive FAIL exits the Review step non-zero, and is exactly
      // what the cache must keep.
      expect(upload?.if ?? '').toContain('always()')
      expect(upload?.if ?? '').toContain(`steps.review.outputs.${output} != ''`)
      // The artifact must contain the file `recordedText` reads back.
      expect(String(upload?.with?.['path'] ?? '')).toBe(cacheDir)
    },
  )
})
