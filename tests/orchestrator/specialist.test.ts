import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveSpecialistLabel, isSpecialistLabel, specialistCheckName, buildSpecialistPrompt,
  runSpecialistReviewCi, specialistRequirement, specialistMergeBlockers, hasSpecialistBlockers,
  AGENT_REGISTRY_DIR, SPECIALIST_CHECK_PREFIX,
  type SpecialistCiDeps, type SpecialistResolution,
} from '../../orchestrator/src/specialist.js'
import { decideReviewGate, REVIEW_JOB, type CiContext } from '../../orchestrator/src/ci.js'
import { VERDICT_CONTRACT, READ_ONLY_CONTRACT, type SecondOpinionResult } from '../../orchestrator/src/review.js'
import {
  cacheArtifactName, diffHash, type CachedVerdict, type ReviewCache, type ReviewCacheKey,
} from '../../orchestrator/src/review-cache.js'
import { COMMANDS } from '../../orchestrator/src/cli.js'
import { parse as parseYaml } from 'yaml'

const REAL_REGISTRY = join(process.cwd(), AGENT_REGISTRY_DIR)
const CRYPTO = 'crypto-security-reviewer'

// ---------------------------------------------------------------------------
// Label → agent resolution. The label selects code to run; every rule is a
// fail-closed refusal with its own reason.
// ---------------------------------------------------------------------------

describe('resolveSpecialistLabel against the real agent registry', () => {
  it('resolves crypto-security-reviewer to its agent definition body', async () => {
    const r = await resolveSpecialistLabel(CRYPTO, REAL_REGISTRY)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.specialist.agent).toBe(CRYPTO)
    expect(r.specialist.instructions).toContain('cryptography security expert')
    // Frontmatter is stripped — the engine gets instructions, not YAML.
    expect(r.specialist.instructions.startsWith('---')).toBe(false)
  })

  it('FAILS an unknown -reviewer label instead of skipping it', async () => {
    const r = await resolveSpecialistLabel('bogus-reviewer', REAL_REGISTRY)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/unknown specialist "bogus-reviewer"/)
  })

  it('never resolves a non-reviewer agent (a supervisor) from a label', async () => {
    const r = await resolveSpecialistLabel('infra-supervisor', REAL_REGISTRY)
    expect(r.ok).toBe(false)
  })

  it.each([
    ['path traversal', '../crypto-security-reviewer'],
    ['a path separator', 'agents/crypto-security-reviewer'],
    ['a nested traversal', 'x/../../../etc/passwd-reviewer'],
    ['uppercase (Actions endsWith is case-insensitive, the registry is not)', 'Crypto-Security-Reviewer'],
    ['shell metacharacters', '$(id)-reviewer'],
    ['a backtick', '`id`-reviewer'],
    ['whitespace', 'crypto security-reviewer'],
    ['a dot', 'crypto.security-reviewer'],
    ['an empty stem', '-reviewer'],
    ['a doubled hyphen', 'crypto--reviewer'],
    ['a trailing newline', 'crypto-security-reviewer\n'],
    ['an over-long name', `${'a'.repeat(60)}-reviewer`],
  ])('refuses a label with %s', async (_why, label) => {
    const r = await resolveSpecialistLabel(label, REAL_REGISTRY)
    expect(r.ok).toBe(false)
  })

  it('treats a -REVIEWER suffix as a request exactly like the workflow does, then refuses it', async () => {
    expect(isSpecialistLabel('Crypto-Security-REVIEWER')).toBe(true)
    expect((await resolveSpecialistLabel('Crypto-Security-REVIEWER', REAL_REGISTRY)).ok).toBe(false)
  })

  it('does not treat ordinary labels as specialist requests', () => {
    for (const l of ['review', 'agent-dispatchable', 'lane:infra', 'reviewer', 'needs-review']) {
      expect(isSpecialistLabel(l), l).toBe(false)
    }
  })
})

describe('resolveSpecialistLabel against a hostile registry', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'specialist-registry-'))
    writeFileSync(join(dir, 'good-reviewer.md'), '---\nname: good-reviewer\ndescription: x\n---\n\nReview well.\n')
    writeFileSync(join(dir, 'liar-reviewer.md'), '---\nname: crypto-security-reviewer\n---\n\nI claim to be someone else.\n')
    writeFileSync(join(dir, 'bare-reviewer.md'), 'no frontmatter at all\n')
    writeFileSync(join(dir, 'empty-reviewer.md'), '---\nname: empty-reviewer\n---\n\n   \n')
    writeFileSync(join(dir, 'secret.txt'), 'SECRET')
    symlinkSync(join(dir, 'secret.txt'), join(dir, 'link-reviewer.md'))
    mkdirSync(join(dir, 'dir-reviewer.md'))
    // Well-formed definitions under names the GRAMMAR must refuse on its own —
    // the registry exact-match alone would accept them.
    writeFileSync(join(dir, 'Upper-Reviewer.md'), '---\nname: Upper-Reviewer\n---\n\nx\n')
    writeFileSync(join(dir, 'dot.name-reviewer.md'), '---\nname: dot.name-reviewer\n---\n\nx\n')
    writeFileSync(join(dir, '$(id)-reviewer.md'), '---\nname: $(id)-reviewer\n---\n\nx\n')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('accepts a well-formed definition', async () => {
    const r = await resolveSpecialistLabel('good-reviewer', dir)
    expect(r.ok && r.specialist.instructions).toBe('Review well.')
  })
  it('refuses a symlinked definition — it could point anywhere on the runner', async () => {
    const r = await resolveSpecialistLabel('link-reviewer', dir)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/not a regular file/)
  })
  it('refuses a directory named like a definition', async () => {
    expect((await resolveSpecialistLabel('dir-reviewer', dir)).ok).toBe(false)
  })
  it('refuses a definition whose frontmatter name does not match its label', async () => {
    const r = await resolveSpecialistLabel('liar-reviewer', dir)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/declares name "crypto-security-reviewer"/)
  })
  it('refuses a file with no frontmatter, and one with an empty body', async () => {
    expect((await resolveSpecialistLabel('bare-reviewer', dir)).ok).toBe(false)
    expect((await resolveSpecialistLabel('empty-reviewer', dir)).ok).toBe(false)
  })
  it('refuses an ill-formed name even when the registry holds a matching, well-formed definition', async () => {
    for (const label of ['Upper-Reviewer', 'dot.name-reviewer', '$(id)-reviewer']) {
      const r = await resolveSpecialistLabel(label, dir)
      expect(r.ok, label).toBe(false)
      expect(!r.ok && r.reason, label).toMatch(/not a well-formed specialist name/)
    }
  })
  it('refuses when the registry itself cannot be read', async () => {
    const r = await resolveSpecialistLabel('good-reviewer', join(dir, 'does-not-exist'))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/could not be read/)
  })
})

// ---------------------------------------------------------------------------
// The specialist check itself.
// ---------------------------------------------------------------------------

const ctx = (): CiContext => ({
  branch: 'fleet/shared/1', repoDir: '/base', headDir: '/tmp/head', baseSha: 'b', headSha: 'h', pr: '42',
})
const DIFF = 'diff --git a/packages/crypto/src/x.rs b/packages/crypto/src/x.rs\n+let ctx = "raw-string-label";\n'

function memCache(seed: Record<string, CachedVerdict> = {}): ReviewCache & { recorded: string[] } {
  const store = new Map(Object.entries(seed))
  const recorded: string[] = []
  return {
    recorded,
    async lookup(k: ReviewCacheKey) { return store.get(`${k.pr}:${k.diffHash}`) },
    async record(k: ReviewCacheKey, v: CachedVerdict) { recorded.push(`${k.pr}:${k.diffHash}`); store.set(`${k.pr}:${k.diffHash}`, v) },
  }
}

function specialistDeps(over: Partial<SpecialistCiDeps> & { verdict?: SecondOpinionResult } = {}) {
  const cache = memCache()
  const runEngine = vi.fn(async (): Promise<SecondOpinionResult> =>
    over.verdict ?? { verdict: 'FAIL', text: 'raw string used as an HKDF info\n\nVERDICT: FAIL — raw-string crypto context' })
  const cacheFor = vi.fn((_agent: string) => cache)
  const deps: SpecialistCiDeps = {
    ctx: ctx(), label: CRYPTO, registryDir: REAL_REGISTRY,
    pathExists: () => false,
    prDiff: async () => DIFF,
    changedFiles: async () => ['packages/crypto/src/x.rs'],
    cacheFor, runEngine, log: () => {},
    ...over,
  }
  return { deps, cache, runEngine, cacheFor }
}

describe('runSpecialistReviewCi', () => {
  it('(a) a known specialist label runs the engine, and its FAIL fails the check', async () => {
    const { deps, runEngine, cache, cacheFor } = specialistDeps()
    const v = await runSpecialistReviewCi(deps)
    expect(v.ok).toBe(false)
    expect(v.summary).toMatch(/^VERDICT: FAIL — raw-string crypto context/)
    expect(runEngine).toHaveBeenCalledTimes(1)
    expect(cacheFor).toHaveBeenCalledWith(CRYPTO)
    expect(cache.recorded, 'a FAIL is never cached').toEqual([])
  })

  it('hands the engine the agent definition, the shared contract, the diff and the export path as data', async () => {
    const { deps, runEngine } = specialistDeps()
    await runSpecialistReviewCi(deps)
    const call = runEngine.mock.calls[0] as unknown as [{ prompt: string; exportDir: string }]
    const { prompt, exportDir } = call[0]
    expect(exportDir).toBe('/tmp/head')
    expect(prompt).toContain('cryptography security expert')
    expect(prompt).toContain(READ_ONLY_CONTRACT)
    expect(prompt).toContain(VERDICT_CONTRACT)
    expect(prompt).toContain(DIFF)
    expect(prompt).toContain('/tmp/head')
  })

  it('a PASS passes and is recorded in the specialist\'s own cache namespace', async () => {
    const { deps, cache } = specialistDeps({ verdict: { verdict: 'PASS', text: 'fine\n\nVERDICT: PASS' } })
    const v = await runSpecialistReviewCi(deps)
    expect(v.ok).toBe(true)
    expect(cache.recorded).toEqual([`42:${diffHash(DIFF)}`])
  })

  it('(b) an unknown -reviewer label FAILS closed without ever reaching the engine', async () => {
    const { deps, runEngine, cacheFor } = specialistDeps({ label: 'bogus-reviewer' })
    const v = await runSpecialistReviewCi(deps)
    expect(v.ok).toBe(false)
    expect(v.summary).toMatch(/^specialist refused: .*unknown specialist "bogus-reviewer"/)
    expect(runEngine).not.toHaveBeenCalled()
    expect(cacheFor, 'an unresolved label never selects a cache namespace').not.toHaveBeenCalled()
  })

  it('a traversal label FAILS closed without reaching the engine', async () => {
    const { deps, runEngine } = specialistDeps({ label: '../../etc/x-reviewer' })
    expect((await runSpecialistReviewCi(deps)).ok).toBe(false)
    expect(runEngine).not.toHaveBeenCalled()
  })

  it('reuses a cached PASS for this exact diff without an engine call', async () => {
    const cache = memCache({ [`42:${diffHash(DIFF)}`]: { verdict: 'PASS', text: 'VERDICT: PASS (cached)' } })
    const { deps, runEngine } = specialistDeps({ cacheFor: () => cache })
    const v = await runSpecialistReviewCi(deps)
    expect(v.ok).toBe(true)
    expect(runEngine).not.toHaveBeenCalled()
  })

  it('runs the engine when the cache lookup throws (fail safe toward a real review)', async () => {
    const throwing: ReviewCache = { async lookup() { throw new Error('boom') }, async record() {} }
    const { deps, runEngine } = specialistDeps({ cacheFor: () => throwing })
    await runSpecialistReviewCi(deps)
    expect(runEngine).toHaveBeenCalledTimes(1)
  })

  it('an UNREADABLE engine run fails, named as unavailable rather than as a finding', async () => {
    const { deps } = specialistDeps({ verdict: { verdict: 'UNREADABLE', text: 'engine died', failureKind: 'engine-unavailable' } })
    const v = await runSpecialistReviewCi(deps)
    expect(v.ok).toBe(false)
    expect(v.summary).toMatch(/^crypto-security-reviewer unavailable:/)
  })

  it('refuses to judge an export that carries a .git (the git-export invariant)', async () => {
    const { deps, runEngine } = specialistDeps({ pathExists: (p: string) => p.endsWith('.git') })
    const v = await runSpecialistReviewCi(deps)
    expect(v.ok).toBe(false)
    expect(v.summary).toMatch(/refusing to judge/)
    expect(runEngine).not.toHaveBeenCalled()
  })

  it('is exposed as the specialist-review-ci CLI command', () => {
    expect(COMMANDS).toContain('specialist-review-ci')
  })
})

describe('buildSpecialistPrompt', () => {
  it('puts the specialist\'s own instructions first', () => {
    const p = buildSpecialistPrompt({ agent: 'x-reviewer', instructions: 'EXPERTISE' }, '7', 'DIFF', ['a.ts'], '/e')
    expect(p.startsWith('EXPERTISE')).toBe(true)
    expect(p).toContain('`x-reviewer`')
  })
})

// ---------------------------------------------------------------------------
// Cache namespacing — a generalist PASS must never be re-published as a
// specialist's.
// ---------------------------------------------------------------------------

describe('cacheArtifactName namespacing', () => {
  const h = diffHash('same diff')
  it('leaves the generalist\'s name exactly as it was', () => {
    expect(cacheArtifactName('42', h)).toBe(`fleet-review-pass-pr42-${h.slice(0, 24)}`)
  })
  it('gives each specialist its own name, distinct from the generalist\'s and each other\'s', () => {
    const names = new Set([cacheArtifactName('42', h), cacheArtifactName('42', h, CRYPTO), cacheArtifactName('42', h, 'protocol-reviewer')])
    expect(names.size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Binding, part 1 — the REQUIRED fleet/review gate.
// ---------------------------------------------------------------------------

describe('specialistRequirement', () => {
  const key: ReviewCacheKey = { pr: '42', diffHash: diffHash(DIFF) }
  const resolveReal = (l: string): Promise<SpecialistResolution> => resolveSpecialistLabel(l, REAL_REGISTRY)
  const passFor = (agents: string[]) => (agent: string): ReviewCache => memCache(
    agents.includes(agent) ? { [`42:${key.diffHash}`]: { verdict: 'PASS', text: 'ok' } } : {},
  )

  it('is met when the PR asked for no specialist', async () => {
    expect(await specialistRequirement(key, { labels: ['review', 'lane:infra'], resolve: resolveReal, cacheFor: passFor([]) })).toEqual([])
  })
  it('is unmet when a requested specialist has no PASS for this diff', async () => {
    const unmet = await specialistRequirement(key, { labels: [CRYPTO], resolve: resolveReal, cacheFor: passFor([]) })
    expect(unmet).toHaveLength(1)
    expect(unmet[0]).toContain(`${SPECIALIST_CHECK_PREFIX}${CRYPTO} has no PASS for this diff`)
  })
  it('is met once the requested specialist passed this diff', async () => {
    expect(await specialistRequirement(key, { labels: [CRYPTO], resolve: resolveReal, cacheFor: passFor([CRYPTO]) })).toEqual([])
  })
  it('is unmet for an unknown -reviewer label, even with no cache involved', async () => {
    const unmet = await specialistRequirement(key, { labels: ['bogus-reviewer'], resolve: resolveReal, cacheFor: passFor([]) })
    expect(unmet[0]).toMatch(/bogus-reviewer/)
  })
  it('fails CLOSED when the labels could not be read', async () => {
    expect(await specialistRequirement(key, { labels: undefined, resolve: resolveReal, cacheFor: passFor([]) })).toHaveLength(1)
  })
  it('fails CLOSED when the specialist cache lookup throws — unknown is never passed', async () => {
    const throwing = (): ReviewCache => ({ async lookup() { throw new Error('boom') }, async record() {} })
    expect(await specialistRequirement(key, { labels: [CRYPTO], resolve: resolveReal, cacheFor: throwing })).toHaveLength(1)
  })
})

describe('decideReviewGate: specialist-unmet outranks every other branch (any FAIL fails)', () => {
  const gateCtx = (): CiContext => ({ ...ctx(), pr: '42' })
  const seeded = (): ReviewCache => memCache({ [`42:${diffHash(DIFF)}`]: { verdict: 'PASS', text: 'VERDICT: PASS (cached)' } })
  const unmet = async (): Promise<string[]> => ['fleet/review/crypto-security-reviewer has no PASS for this diff']

  it('fails even when the GENERALIST has a cached PASS for this diff', async () => {
    const o = await decideReviewGate({
      ctx: gateCtx(), prDiff: async () => DIFF, changedFiles: async () => ['packages/crypto/src/x.rs'],
      cache: seeded(), requested: true, unmetSpecialists: unmet, log: () => {},
    })
    expect(o.kind).toBe('specialist-unmet')
  })
  it('fails even for a docs-only (low-tier) diff — a label is an explicit request', async () => {
    const o = await decideReviewGate({
      ctx: gateCtx(), prDiff: async () => DIFF, changedFiles: async () => ['docs/x.md'],
      cache: memCache(), requested: false, unmetSpecialists: unmet, log: () => {},
    })
    expect(o.kind).toBe('specialist-unmet')
  })
  it('never spends a generalist review while a specialist is unmet', async () => {
    const o = await decideReviewGate({
      ctx: gateCtx(), prDiff: async () => DIFF, changedFiles: async () => ['orchestrator/src/x.ts'],
      cache: memCache(), requested: true, unmetSpecialists: unmet, log: () => {},
    })
    expect(o.kind).not.toBe('run-engine')
  })
  it('is keyed on the same (pr, diffHash) the generalist cache uses', async () => {
    const seen: ReviewCacheKey[] = []
    await decideReviewGate({
      ctx: gateCtx(), prDiff: async () => DIFF, changedFiles: async () => ['x'],
      cache: memCache(), requested: true, unmetSpecialists: async (k) => { seen.push(k); return [] }, log: () => {},
    })
    expect(seen).toEqual([{ pr: '42', diffHash: diffHash(DIFF) }])
  })
})

// ---------------------------------------------------------------------------
// Binding, part 2 — the pure merge-decision blockers.
// ---------------------------------------------------------------------------

describe('specialistMergeBlockers', () => {
  const name = specialistCheckName(CRYPTO)
  it('ignores the generalist and every non-specialist check', () => {
    const b = specialistMergeBlockers([{ name: REVIEW_JOB, state: 'FAIL' }, { name: 'ci-status', state: 'FAIL' }], [])
    expect(hasSpecialistBlockers(b)).toBe(false)
  })
  it('reports failing, pending and missing separately', () => {
    const b = specialistMergeBlockers(
      [{ name, state: 'FAIL' }, { name: 'fleet/review/protocol-reviewer', state: 'PENDING' }],
      [CRYPTO, 'protocol-reviewer', 'i18n-reviewer'],
    )
    expect(b).toEqual({ failing: [name], pending: ['fleet/review/protocol-reviewer'], missing: ['fleet/review/i18n-reviewer'] })
  })
  it('resolves same-named runs to the worst', () => {
    expect(specialistMergeBlockers([{ name, state: 'PASS' }, { name, state: 'FAIL' }], [CRYPTO]).failing).toEqual([name])
  })
})

// ---------------------------------------------------------------------------
// Workflow rails — read the real file. (c) a push never triggers a run.
// ---------------------------------------------------------------------------

interface WfStep { name?: string; run?: string; uses?: string; env?: Record<string, string>; if?: string }
interface WfJob { name: string; if?: string; 'runs-on': string | string[]; permissions?: Record<string, string>; steps: WfStep[] }
interface Workflow { on: Record<string, { types?: string[] } | null>; jobs: Record<string, WfJob> }

describe('rail: fleet-specialist-review.yml', () => {
  const text = readFileSync(join(process.cwd(), '.github', 'workflows', 'fleet-specialist-review.yml'), 'utf8')
  const wf = parseYaml(text) as Workflow
  const specialist = (): WfJob => {
    const j = wf.jobs['specialist-review']
    expect(j, 'the specialist-review job exists').toBeDefined()
    return j as WfJob
  }
  const disarm = (): WfJob => {
    const j = wf.jobs['disarm-auto-merge']
    expect(j, 'the disarm-auto-merge job exists').toBeDefined()
    return j as WfJob
  }

  it('(c) triggers on pull_request `labeled` ONLY — so a push (synchronize) never runs a specialist', () => {
    expect(Object.keys(wf.on)).toEqual(['pull_request'])
    expect(wf.on['pull_request']?.types).toEqual(['labeled'])
  })

  it('runs the specialist on the self-hosted fleet-review runner, fork guard first, read-only', () => {
    const j = specialist()
    expect(j['runs-on']).toEqual(['self-hosted', 'fleet-review'])
    expect(j.steps[0]?.name).toMatch(/^Refuse to run on a fork PR/)
    expect(j.steps[0]?.if, 'the fork guard is never itself gated').toBeUndefined()
    expect(Object.values(j.permissions ?? {})).not.toContain('write')
    expect(JSON.stringify(j)).not.toContain('--dangerously-skip-permissions')
  })

  it('every job runs only for a -reviewer label, and every job\'s first step is the fork guard', () => {
    for (const [key, j] of Object.entries(wf.jobs)) {
      expect(j.if, key).toBe("endsWith(github.event.label.name, '-reviewer')")
      expect(j.steps[0]?.name, key).toMatch(/^Refuse to run on a fork PR/)
    }
  })

  it('posts under fleet/review/<label> — a distinct context from the required fleet/review', () => {
    expect(specialist().name).toContain("format('fleet/review/{0}', github.event.label.name)")
    expect(specialist().name).not.toBe(REVIEW_JOB)
  })

  it('a SKIPPED run\'s name (GitHub shows the raw expression) stays outside the fleet/review/ prefix', () => {
    const raw = specialist().name.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '')
    expect(raw.startsWith(SPECIALIST_CHECK_PREFIX)).toBe(false)
    expect(specialistMergeBlockers([{ name: raw, state: 'PASS' }], ['lane:infra'])).toEqual({ failing: [], pending: [], missing: [] })
  })

  it('never interpolates the raw label (or any other event text) into a shell script — env only', () => {
    for (const [key, j] of Object.entries(wf.jobs)) {
      for (const step of j.steps) {
        expect(step.run ?? '', `${key} / ${step.name ?? '?'}`).not.toMatch(/\$\{\{\s*github\.event/)
      }
    }
    const review = specialist().steps.find((st) => st.name === 'Review')
    expect(review?.env?.['FLEET_SPECIALIST_LABEL']).toBe('${{ github.event.label.name }}')
  })

  it('carries the base-checkout, git-export and agent-config-strip invariants of fleet-review.yml', () => {
    const steps = specialist().steps
    const checkout = steps.find((st) => st.uses?.startsWith('actions/checkout@'))
    expect(JSON.stringify(checkout)).toContain('steps.ctx.outputs.base_sha')
    const exp = steps.find((st) => st.name === 'Export the PR head as data')?.run ?? ''
    expect(exp).toContain('git archive "$HEAD_SHA" | tar -x -C "$RUNNER_TEMP/head"')
    expect(exp).toContain('git-export-invariant')
    expect(exp).toContain('-iname .claude')
    expect(exp).toContain('-type l')
    expect(steps.some((st) => st.run === 'bun install --frozen-lockfile --ignore-scripts')).toBe(true)
    expect(steps.find((st) => st.name === 'Review')?.run).toBe('bun orchestrator/src/cli.ts specialist-review-ci')
  })

  it('the base-provides-the-command guard runs before the review and names the command', () => {
    const names = specialist().steps.map((st) => st.name)
    const guard = names.indexOf('Check the base provides the specialist review command')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(names.indexOf('Review'))
  })

  it('disarms auto-merge on a GitHub-hosted runner that checks out and runs no repository code', () => {
    const j = disarm()
    expect(j['runs-on']).toBe('ubuntu-latest')
    const all = JSON.stringify(j.steps)
    expect(all).not.toContain('actions/checkout')
    expect(all).not.toMatch(/\bbun /)
    const merges = j.steps.flatMap((st) => (st.run ?? '').split('\n')).filter((l) => l.includes('gh pr merge'))
    expect(merges.length).toBeGreaterThan(0)
    for (const m of merges) expect(m, 'the only merge call un-arms').toContain('--disable-auto')
  })

  it('states in its header that the specialist check must never be a required context', () => {
    expect(text).toContain('IS NOT, AND MUST NEVER BE, A REQUIRED STATUS CHECK')
  })
})
