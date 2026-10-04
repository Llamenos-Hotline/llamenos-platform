import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * Guard for the fold done in `.claude/agents/fragments/_worker-rules.md`:
 * the determinism rules that bind every dispatched worker (never-merge,
 * foreground-only execution, etc.) live in exactly ONE fragment, shared by
 * every lane via `build-agents.sh`. Before this fold, "never merge" and
 * "run in the foreground" text accumulated independently across per-lane
 * fragments and the assembled skill files — the same instruction stated N
 * times is N places that can silently drift out of sync with each other.
 *
 * This test pins the fold two ways: the shared fragment must actually carry
 * both rules, and no per-lane fragment may restate either one. Re-adding a
 * duplicate to a lane fragment (the regression this guards against) fails
 * the second assertion immediately, before it ever reaches a generated
 * agent definition.
 */

const FRAGMENTS_DIR = join(process.cwd(), '.claude', 'agents', 'fragments')
const SHARED_FRAGMENT = '_worker-rules.md'

const NEVER_MERGE_RE = /never merge/i
const FOREGROUND_RE = /foreground/i

async function laneFragmentFiles(): Promise<string[]> {
  const files = await readdir(FRAGMENTS_DIR)
  return files.filter((f) => f.endsWith('-supervisor.md'))
}

describe('shared worker-rules fragment', () => {
  it('exists and carries the never-merge rule', async () => {
    const text = await readFile(join(FRAGMENTS_DIR, SHARED_FRAGMENT), 'utf8')
    expect(text).toMatch(NEVER_MERGE_RE)
  })

  it('exists and carries the foreground-only rule', async () => {
    const text = await readFile(join(FRAGMENTS_DIR, SHARED_FRAGMENT), 'utf8')
    expect(text).toMatch(FOREGROUND_RE)
  })

  it('is the ONLY fragment stating the never-merge rule — no lane fragment restates it', async () => {
    const lanes = await laneFragmentFiles()
    expect(lanes.length).toBeGreaterThan(0)
    for (const lane of lanes) {
      const text = await readFile(join(FRAGMENTS_DIR, lane), 'utf8')
      expect(text, `${lane} must not restate the never-merge rule — it lives only in ${SHARED_FRAGMENT}`)
        .not.toMatch(NEVER_MERGE_RE)
    }
  })

  it('is the ONLY fragment stating the foreground-only rule — no lane fragment restates it', async () => {
    const lanes = await laneFragmentFiles()
    expect(lanes.length).toBeGreaterThan(0)
    for (const lane of lanes) {
      const text = await readFile(join(FRAGMENTS_DIR, lane), 'utf8')
      expect(text, `${lane} must not restate the foreground-only rule — it lives only in ${SHARED_FRAGMENT}`)
        .not.toMatch(FOREGROUND_RE)
    }
  })
})

/**
 * The scope gate reads `.claude/agents/fragments/*.md`; the supervisor that
 * briefs the worker reads the ASSEMBLED `.claude/agents/<lane>-supervisor.md`
 * that `build-agents.sh` writes from it. Nothing rebuilt the assembled files
 * when a fragment changed, and five of the six had drifted: desktop's
 * assembled definition still said "Does NOT own: `tests/steps/`" long after
 * its fragment granted every non-backend directory under it, and none of them
 * had heard of the `packages/test-specs/features/` shared-write from #847/#908.
 *
 * That drift is a scope-DEFINITION error, and it fails in the direction that
 * does not show up as a red check: the gate lets the diff through while the
 * supervisor tells its worker the path is out of lane, so the worker
 * volunteers the partial fix. Pinning the assembled prefix to the fragment
 * catches it at the fragment edit, which is the only moment anyone is looking.
 */
describe('assembled agent definitions stay in sync with their fragments', () => {
  it.each(['desktop', 'ios', 'android', 'backend', 'shared', 'infra'] as const)(
    '%s-supervisor.md begins with its fragment verbatim',
    async (lane) => {
      const fragment = await readFile(join(FRAGMENTS_DIR, `${lane}-supervisor.md`), 'utf8')
      const assembled = await readFile(join(FRAGMENTS_DIR, '..', `${lane}-supervisor.md`), 'utf8')
      expect(
        assembled.startsWith(fragment),
        `.claude/agents/${lane}-supervisor.md is stale — rerun .claude/agents/build-agents.sh after editing its fragment`,
      ).toBe(true)
    },
  )
})
