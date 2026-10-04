import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveReviewerLabel, isReviewerLabel, buildProfileReviewPrompt, AGENT_REGISTRY_DIR,
  type ReviewerResolution,
} from '../../orchestrator/src/specialist.js'
import {
  decideReviewSet, reviewIsRequested, REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN,
} from '../../orchestrator/src/ci.js'
import { VERDICT_CONTRACT, READ_ONLY_CONTRACT } from '../../orchestrator/src/review.js'
import { cacheArtifactName, diffHash, reviewSetTag } from '../../orchestrator/src/review-cache.js'
import { COMMANDS } from '../../orchestrator/src/cli.js'
import { parse as parseYaml } from 'yaml'

const REAL_REGISTRY = join(process.cwd(), AGENT_REGISTRY_DIR)
const CRYPTO = 'crypto-security-reviewer'

// ---------------------------------------------------------------------------
// Profile-name → agent resolution. The name selects code to run; every rule
// is a fail-closed refusal with its own reason.
// ---------------------------------------------------------------------------

describe('resolveReviewerLabel against the real agent registry', () => {
  it('resolves crypto-security-reviewer to its agent definition body', async () => {
    const r = await resolveReviewerLabel(CRYPTO, REAL_REGISTRY)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.profile.agent).toBe(CRYPTO)
    expect(r.profile.instructions).toContain('cryptography security expert')
    // Frontmatter is stripped — the engine gets instructions, not YAML.
    expect(r.profile.instructions.startsWith('---')).toBe(false)
  })

  it('FAILS an unknown -reviewer name instead of skipping it', async () => {
    const r = await resolveReviewerLabel('bogus-reviewer', REAL_REGISTRY)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/unknown reviewer profile "bogus-reviewer"/)
  })

  it('never resolves a non-reviewer agent (a supervisor) from a label', async () => {
    const r = await resolveReviewerLabel('infra-supervisor', REAL_REGISTRY)
    expect(r.ok).toBe(false)
  })

  it.each([
    ['path traversal', '../crypto-security-reviewer'],
    ['a path separator', 'agents/crypto-security-reviewer'],
    ['a nested traversal', 'x/../../../etc/passwd-reviewer'],
    ['uppercase (the suffix check is case-insensitive, the registry is not)', 'Crypto-Security-Reviewer'],
    ['shell metacharacters', '$(id)-reviewer'],
    ['a backtick', '`id`-reviewer'],
    ['whitespace', 'crypto security-reviewer'],
    ['a dot', 'crypto.security-reviewer'],
    ['an empty stem', '-reviewer'],
    ['a doubled hyphen', 'crypto--reviewer'],
    ['a trailing newline', 'crypto-security-reviewer\n'],
    ['an over-long name', `${'a'.repeat(60)}-reviewer`],
  ])('refuses a name with %s', async (_why, label) => {
    const r = await resolveReviewerLabel(label, REAL_REGISTRY)
    expect(r.ok).toBe(false)
  })

  it('treats a -REVIEWER suffix as a request, then refuses it on the grammar', async () => {
    expect(isReviewerLabel('Crypto-Security-REVIEWER')).toBe(true)
    expect((await resolveReviewerLabel('Crypto-Security-REVIEWER', REAL_REGISTRY)).ok).toBe(false)
  })

  it('does not treat ordinary labels as reviewer requests', () => {
    for (const l of ['review', 'agent-dispatchable', 'lane:infra', 'reviewer', 'needs-review', 'crypto']) {
      expect(isReviewerLabel(l), l).toBe(false)
    }
  })
})

describe('resolveReviewerLabel against a hostile registry', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'reviewer-registry-'))
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
    const r = await resolveReviewerLabel('good-reviewer', dir)
    expect(r.ok && r.profile.instructions).toBe('Review well.')
  })
  it('refuses a symlinked definition — it could point anywhere on the runner', async () => {
    const r = await resolveReviewerLabel('link-reviewer', dir)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/not a regular file/)
  })
  it('refuses a directory named like a definition', async () => {
    expect((await resolveReviewerLabel('dir-reviewer', dir)).ok).toBe(false)
  })
  it('refuses a definition whose frontmatter name does not match its label', async () => {
    const r = await resolveReviewerLabel('liar-reviewer', dir)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/declares name "crypto-security-reviewer"/)
  })
  it('refuses a file with no frontmatter, and one with an empty body', async () => {
    expect((await resolveReviewerLabel('bare-reviewer', dir)).ok).toBe(false)
    expect((await resolveReviewerLabel('empty-reviewer', dir)).ok).toBe(false)
  })
  it('refuses an ill-formed name even when the registry holds a matching, well-formed definition', async () => {
    for (const label of ['Upper-Reviewer', 'dot.name-reviewer', '$(id)-reviewer']) {
      const r = await resolveReviewerLabel(label, dir)
      expect(r.ok, label).toBe(false)
      expect(!r.ok && r.reason, label).toMatch(/not a well-formed reviewer profile name/)
    }
  })
  it('refuses when the registry itself cannot be read', async () => {
    const r = await resolveReviewerLabel('good-reviewer', join(dir, 'does-not-exist'))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/could not be read/)
  })
})

describe('buildProfileReviewPrompt', () => {
  it('puts the profile\'s own instructions first, then the shared contracts', () => {
    const p = buildProfileReviewPrompt({ agent: 'x-reviewer', instructions: 'EXPERTISE' }, '7', 'DIFF', ['a.ts'], '/e')
    expect(p.startsWith('EXPERTISE')).toBe(true)
    expect(p).toContain('`x-reviewer`')
    expect(p).toContain(READ_ONLY_CONTRACT)
    expect(p).toContain(VERDICT_CONTRACT)
    expect(p).toContain('/e')
    expect(p).toContain('DIFF')
  })
})

// ---------------------------------------------------------------------------
// The review SET — labels AND the PR itself (#1158).
// ---------------------------------------------------------------------------

const resolveReal = (name: string): Promise<ReviewerResolution> => resolveReviewerLabel(name, REAL_REGISTRY)

const set = (over: Partial<Parameters<typeof decideReviewSet>[0]> = {}) => decideReviewSet({
  labels: [], changedFiles: ['apps/worker/routes/notes.ts'], description: '', resolve: resolveReal, ...over,
})

describe('decideReviewSet', () => {
  it('is the general reviewer alone for an ordinary diff with no labels', async () => {
    const r = await set()
    expect(r.ok && r.profiles).toEqual([])
    expect(r.ok && r.fromLabels).toEqual([])
  })

  it('adds a profile a LABEL names', async () => {
    const r = await set({ labels: [CRYPTO, 'lane:infra'] })
    expect(r.ok && r.profiles).toEqual([CRYPTO])
    expect(r.ok && r.fromLabels).toEqual([CRYPTO])
    expect(r.ok && r.reasons.join()).toContain('requested by label')
  })

  it('adds the crypto reviewer from the PR\'s own CHANGED PATHS with no label at all', async () => {
    const r = await set({ changedFiles: ['packages/crypto/src/hpke_envelope.rs'] })
    expect(r.ok && r.profiles).toEqual([CRYPTO])
    expect(r.ok && r.fromLabels).toEqual([])
    expect(r.ok && r.reasons.join()).toContain('required by the PR\'s own content')
  })

  it('adds the crypto reviewer from the PR\'s own DESCRIPTION with no label and no crypto path', async () => {
    const r = await set({ description: 'Rotate the HPKE envelope label for notes' })
    expect(r.ok && r.profiles).toEqual([CRYPTO])
    expect(r.ok && r.fromLabels).toEqual([])
  })

  it('does not invent a review from ordinary prose', async () => {
    const r = await set({ description: 'fix(ci): retry the flaky upload step; the session was reused' })
    expect(r.ok && r.profiles).toEqual([])
  })

  it('names a profile once when BOTH the label and the content ask for it, and still clears the label', async () => {
    const r = await set({ labels: [CRYPTO], changedFiles: ['packages/crypto/src/x.rs'] })
    expect(r.ok && r.profiles).toEqual([CRYPTO])
    expect(r.ok && r.fromLabels).toEqual([CRYPTO])
    expect(r.ok && r.reasons[0]).toContain('requested by label; required by the PR\'s own content')
  })

  it('fails CLOSED when the labels could not be read — never an empty set', async () => {
    const r = await set({ labels: undefined })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/labels could not be read/)
  })

  it('fails CLOSED on an unknown -reviewer label', async () => {
    const r = await set({ labels: ['bogus-reviewer'] })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/the "bogus-reviewer" label asks for a review that cannot be run/)
  })

  it('fails CLOSED on a malformed -reviewer label rather than ignoring it', async () => {
    for (const bad of ['../x-reviewer', 'Crypto-Security-REVIEWER', '$(id)-reviewer']) {
      const r = await set({ labels: [bad] })
      expect(r.ok, bad).toBe(false)
    }
  })

  it('fails CLOSED when the agent registry itself is unreadable', async () => {
    const r = await set({
      labels: [CRYPTO],
      resolve: (n) => resolveReviewerLabel(n, join(REAL_REGISTRY, 'nope')),
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/could not be read/)
  })

  it('fails CLOSED when a CONTENT-derived profile has no agent definition', async () => {
    const r = await set({
      changedFiles: ['packages/crypto/src/x.rs'],
      resolve: async () => ({ ok: false, reason: 'gone' }),
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/this PR's own content asks for the "crypto-security-reviewer" review/)
  })
})

// ---------------------------------------------------------------------------
// Who asked. The trigger gate — never a job-level `if:` (#848).
// ---------------------------------------------------------------------------

describe('reviewIsRequested', () => {
  const ev = (over: Partial<Parameters<typeof reviewIsRequested>[0]> = {}) => reviewIsRequested({
    eventName: 'pull_request', requestedReviewer: REVIEW_REQUEST_LOGIN, branch: 'fleet/infra/1', ...over,
  })

  it('accepts a review requested from llamenos-auto', () => {
    expect(ev()).toBe(true)
  })
  it('accepts it case-insensitively, as GitHub logins are', () => {
    expect(ev({ requestedReviewer: 'Llamenos-Auto' })).toBe(true)
  })
  it('accepts rhonda-rodododo ONLY on the release PR', () => {
    expect(ev({ requestedReviewer: RELEASE_REVIEW_REQUEST_LOGIN, branch: 'release' })).toBe(true)
    expect(ev({ requestedReviewer: RELEASE_REVIEW_REQUEST_LOGIN, branch: 'fleet/infra/1' })).toBe(false)
  })
  it('refuses a review requested from anybody else', () => {
    expect(ev({ requestedReviewer: 'some-colleague' })).toBe(false)
  })
  it('refuses a TEAM request, which carries no requested_reviewer at all', () => {
    expect(ev({ requestedReviewer: undefined })).toBe(false)
    expect(ev({ requestedReviewer: '' })).toBe(false)
  })
  it('accepts a manual workflow_dispatch, which has no reviewer of its own', () => {
    expect(ev({ eventName: 'workflow_dispatch', requestedReviewer: undefined })).toBe(true)
  })
  it('refuses every other event name — a push can never be a review request', () => {
    for (const name of ['push', 'merge_group', 'schedule', '']) {
      expect(ev({ eventName: name }), name).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Cache namespacing — a general-reviewer PASS must never stand in for a set
// that also included a profile that never ran.
// ---------------------------------------------------------------------------

describe('reviewSetTag / cacheArtifactName namespacing', () => {
  const h = diffHash('same diff')
  it('leaves the general reviewer\'s own name exactly as it was before #1158', () => {
    expect(reviewSetTag([])).toBeUndefined()
    expect(cacheArtifactName('42', h, reviewSetTag([]))).toBe(`fleet-review-pass-pr42-${h.slice(0, 24)}`)
  })
  it('gives a set with a profile a different name from the general reviewer\'s', () => {
    expect(cacheArtifactName('42', h, reviewSetTag([CRYPTO]))).not.toBe(cacheArtifactName('42', h))
  })
  it('gives different sets different names, and the same set one name regardless of order', () => {
    expect(reviewSetTag([CRYPTO, 'a-reviewer'])).toBe(reviewSetTag(['a-reviewer', CRYPTO]))
    expect(reviewSetTag([CRYPTO])).not.toBe(reviewSetTag([CRYPTO, 'a-reviewer']))
  })
  it('produces a name inside the safe subset (no separators, no escaping needed)', () => {
    const name = cacheArtifactName('42', h, reviewSetTag([CRYPTO, 'a-reviewer']))
    expect(name).toMatch(/^[A-Za-z0-9-]+$/)
  })

  // #1158: the VERDICT is in the name too, so a PASS lookup can never find a
  // FAIL record or the reverse — and `pass` is spelled exactly as it always
  // was, so every artifact recorded before FAILs were cached stays a hit.
  it('encodes the verdict, and leaves the PASS spelling untouched', () => {
    expect(cacheArtifactName('42', h)).toBe(`fleet-review-pass-pr42-${h.slice(0, 24)}`)
    expect(cacheArtifactName('42', h, undefined, 'PASS')).toBe(cacheArtifactName('42', h))
    expect(cacheArtifactName('42', h, undefined, 'FAIL')).toBe(`fleet-review-fail-pr42-${h.slice(0, 24)}`)
    expect(cacheArtifactName('42', h, undefined, 'FAIL')).not.toBe(cacheArtifactName('42', h, undefined, 'PASS'))
  })
})

// ---------------------------------------------------------------------------
// Rails: the per-specialist design is GONE, and cannot come back by accident.
// ---------------------------------------------------------------------------

describe('rail: #1092\'s per-specialist checks are deleted (#1158)', () => {
  const workflowDir = join(process.cwd(), '.github', 'workflows')
  const reviewYml = readFileSync(join(workflowDir, 'fleet-review.yml'), 'utf8')

  it('there is no fleet-specialist-review.yml any more', () => {
    expect(() => readFileSync(join(workflowDir, 'fleet-specialist-review.yml'), 'utf8')).toThrow()
  })

  it('no job in any workflow posts a fleet/review/<agent> check', () => {
    // The prose in the header may name the retired context; a `name:` value
    // must never produce one again.
    const jobs = (parseYaml(reviewYml) as { jobs: Record<string, { name?: string }> }).jobs
    for (const [key, job] of Object.entries(jobs)) {
      expect(job.name ?? key, key).not.toMatch(/^fleet\/review\/.+/)
    }
  })

  it('the specialist-review-ci command is gone from the CLI', () => {
    expect(COMMANDS).not.toContain('specialist-review-ci')
    expect(COMMANDS).toContain('review-ci')
    expect(COMMANDS).toContain('review-gate')
  })

  it('fleet-review.yml never triggers on a label, and only `synchronize` joins review_requested', () => {
    const on = (parseYaml(reviewYml) as { on: Record<string, unknown> }).on
    // What this rail is for: #1158 retired `labeled` as the trigger, and
    // `labeled` must never come back (see feedback: labels are nouns, not
    // verbs). Asserting the WHOLE types list, rather than just the absence
    // of `labeled`, is what makes that stick — a new type cannot be added
    // here without a deliberate edit to this line.
    //
    // #1284 added exactly one: `synchronize`, so the required `fleet/review`
    // context REAPPEARS on a head that moved. It can only republish what the
    // PR already earned for this exact diff, or go red; it can never start a
    // review, structurally (`republishOnly`, ci.ts). The rails that pin that
    // half live in tests/orchestrator/guards.test.ts — this one only pins
    // the trigger list itself.
    expect(on['pull_request']).toEqual({ types: ['review_requested', 'synchronize'] })
    for (const forbiddenType of ['labeled', 'unlabeled', 'opened', 'reopened', 'edited']) {
      expect((on['pull_request'] as { types: string[] }).types, forbiddenType).not.toContain(forbiddenType)
    }
    for (const forbidden of ['push', 'pull_request_target', 'schedule']) {
      expect(on[forbidden], forbidden).toBeUndefined()
    }
    // #1187: `merge_group` is required, not forbidden — `fleet/review` is a
    // required status context and one that cannot report on the queue's
    // synthetic commit stalls every entry at AWAITING_CHECKS forever. It
    // spends no model call there; see fleet-review-merge-group.test.ts.
    expect(on['merge_group']).toEqual({ types: ['checks_requested'] })
  })

  it('the publishing job is separate, GitHub-hosted, and the ONLY writer', () => {
    const jobs = (parseYaml(reviewYml) as { jobs: Record<string, { 'runs-on': unknown; permissions?: Record<string, string>; needs?: unknown }> }).jobs
    expect(Object.keys(jobs)).toEqual(['fleet-review', 'publish-reviews'])
    // The job that runs a model next to the review key stays read-only.
    // `checks: read` (#1187) is the merge-queue arm's only new grant: it
    // reads the `fleet/review` check run already recorded on the queued PR's
    // head. Still no `: write` anywhere — pinned separately in guards.test.ts.
    expect(jobs['fleet-review']?.permissions).toEqual({ contents: 'read', 'pull-requests': 'read', actions: 'read', checks: 'read' })
    const publish = jobs['publish-reviews']
    expect(publish?.['runs-on']).toBe('ubuntu-latest')
    expect(publish?.needs).toEqual(['fleet-review'])
    expect(publish?.permissions).toEqual({ 'pull-requests': 'write', actions: 'read' })
  })

  // A FAIL is the case whose reasoning the PR most needs, so publishing
  // must not be conditioned on the review having passed.
  it('publishes on a FAIL as well as a PASS — a red check whose reason is only in a log is not reviewable', () => {
    const jobs = (parseYaml(reviewYml) as { jobs: Record<string, { if?: string }> }).jobs
    const cond = jobs['publish-reviews']?.if ?? ''
    expect(cond).toContain("needs.fleet-review.result == 'success'")
    expect(cond).toContain("needs.fleet-review.result == 'failure'")
  })

  it('posts the findings as PR COMMENTS, never as a GitHub review the fleet could have counted', () => {
    expect(reviewYml).toContain('gh pr comment')
    expect(reviewYml).not.toContain('gh pr review')
  })

  it('clears labels only AFTER posting, and only on a PASS', () => {
    const publish = reviewYml.slice(reviewYml.indexOf('  publish-reviews:'))
    const postIdx = publish.indexOf('gh pr comment')
    const clearIdx = publish.indexOf('issues/$PR/labels/$label')
    expect(postIdx, 'no comment step').toBeGreaterThan(-1)
    expect(clearIdx, 'no label-clearing step').toBeGreaterThan(-1)
    expect(postIdx, 'labels must not be cleared before the reviews are posted').toBeLessThan(clearIdx)
    expect(publish).toContain('if [ "$REVIEW_RESULT" != "success" ] || [ -z "$CLEAR_LABELS" ]; then')
  })

  it('the label-clearing job re-checks the label grammar before acting on it', () => {
    expect(reviewYml).toContain('^[a-z0-9]+(-[a-z0-9]+)*-reviewer$')
  })

  it('no label value is ever interpolated into a shell script — env only', () => {
    const body = reviewYml.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
    for (const m of body.matchAll(/\$\{\{[^}]*\}\}/g)) {
      const expr = m[0]
      if (!expr.includes('label') && !expr.includes('requested_reviewer')) continue
      // Every such expression must appear on an `env:`/`outputs:` assignment
      // line, never inside a `run:` body.
      const line = body.slice(0, m.index).split('\n').pop() ?? ''
      expect(line, expr).toMatch(/^\s+[A-Za-z_][A-Za-z0-9_]*:\s*$|^\s+[A-Za-z_][A-Za-z0-9_-]*:\s/)
    }
  })
})
