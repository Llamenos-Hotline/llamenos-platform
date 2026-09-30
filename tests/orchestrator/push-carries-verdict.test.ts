import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  lastEarnedVerdict, cacheArtifactName, reviewSetTag, LAST_VERDICT_RUN_WINDOW,
  type LastVerdictDeps,
} from '../../orchestrator/src/review-cache.js'
import { REPO } from '../../orchestrator/src/gh.js'

/**
 * #1394: a push must never start a review, and must never turn `fleet/review`
 * red on its own account. The verdict a PR last EARNED stands until somebody
 * requests another; a PR nobody has asked about concludes green, saying so.
 *
 * Two layers, both driving real code:
 *
 *  1. `lastEarnedVerdict` over a fake Actions API — which run's record wins,
 *     and that every way the history can be unreadable is `unreadable`,
 *     never `none` (a green).
 *  2. The REAL `review-gate` CLI, as `fleet-review.yml` runs it, in a
 *     subprocess against a real git repo and a fake `gh` on PATH that logs
 *     every call. Each operator-named scenario is constructed and the gate's
 *     `outcome`, exit code and every `gh` call it made are asserted. The
 *     engine is only ever reached through `outcome=run-engine` (every
 *     engine step in fleet-review.yml is gated on it — pinned in
 *     guards.test.ts), so "the engine is not called on a push" is: no push
 *     scenario ever writes `outcome=run-engine`, and the one scenario that
 *     does is an explicit review request.
 */

const PR = '1394'
const BRANCH = 'fix/fleet-review-not-requested'
const CURRENT_RUN = 900
const WORKFLOW_PATH = '.github/workflows/fleet-review.yml'
const HASH = 'ab'.repeat(32)

interface FakeRun { id: number; head_sha: string; html_url: string; path?: string }
interface FakeArtifact { id: number; name: string; expired: boolean }

const run = (id: number, sha = `sha${id}`): FakeRun => ({ id, head_sha: sha, html_url: `https://github.com/${REPO}/actions/runs/${id}`, path: WORKFLOW_PATH })
const record = (id: number, verdict: 'PASS' | 'FAIL', opts: { pr?: string; scope?: string; expired?: boolean } = {}): FakeArtifact => ({
  id, name: cacheArtifactName(opts.pr ?? PR, HASH, opts.scope, verdict), expired: opts.expired ?? false,
})

function fakeApi(runs: FakeRun[] | undefined, artifacts: Record<number, FakeArtifact[] | undefined>, failText?: string) {
  const calls: string[] = []
  const deps: LastVerdictDeps = {
    pr: PR, branch: BRANCH, currentRunId: String(CURRENT_RUN), log: () => {},
    async api<T>(path: string): Promise<T | undefined> {
      calls.push(path)
      if (path.includes('/actions/workflows/')) return runs === undefined ? undefined : ({ workflow_runs: runs } as T)
      const m = /\/actions\/runs\/(\d+)\/artifacts/.exec(path)
      if (m) {
        const list = artifacts[Number(m[1])]
        return list === undefined ? undefined : ({ artifacts: list } as T)
      }
      return undefined
    },
    async failText() { return failText },
  }
  return { deps, calls }
}

describe('lastEarnedVerdict — the verdict a push carries forward', () => {
  it('finds the NEWEST run that recorded a verdict, skipping runs that recorded none', async () => {
    const { deps } = fakeApi([run(5), run(4), run(3)], { 5: [], 4: [record(41, 'PASS')], 3: [record(31, 'FAIL')] })
    const last = await lastEarnedVerdict(deps)
    expect(last.kind).toBe('found')
    if (last.kind !== 'found') throw new Error('unreachable')
    expect(last.earned.verdict).toBe('PASS')
    expect(last.earned.headSha).toBe('sha4')
    expect(last.earned.text).toContain('sha4')
    expect(last.earned.text).toContain(run(4).html_url)
  })

  it('a later FAIL outranks an earlier PASS — the last review said FAIL, so FAIL stands', async () => {
    const { deps } = fakeApi([run(5), run(4)], { 5: [record(51, 'FAIL')], 4: [record(41, 'PASS')] }, 'VERDICT: FAIL — unsafe unwrap')
    const last = await lastEarnedVerdict(deps)
    if (last.kind !== 'found') throw new Error(`expected found, got ${last.kind}`)
    expect(last.earned.verdict).toBe('FAIL')
    expect(last.earned.headSha).toBe('sha5')
    expect(last.earned.text).toMatch(/^VERDICT: FAIL \(carried\)/)
    expect(last.earned.text).toContain('VERDICT: FAIL — unsafe unwrap')
  })

  it('an EXPIRED FAIL is still a FAIL — its verdict is in the name — carried without its text', async () => {
    const { deps } = fakeApi([run(5)], { 5: [record(51, 'FAIL', { expired: true })] }, 'never read')
    const last = await lastEarnedVerdict(deps)
    if (last.kind !== 'found') throw new Error(`expected found, got ${last.kind}`)
    expect(last.earned.verdict).toBe('FAIL')
    expect(last.earned.text).not.toContain('never read')
    expect(last.earned.text).toContain('no longer readable')
  })

  it('counts a record under a review-set namespace (a crypto-content PR)', async () => {
    const scope = reviewSetTag(['crypto-security-reviewer'])
    const { deps } = fakeApi([run(5)], { 5: [record(51, 'PASS', { scope })] })
    expect((await lastEarnedVerdict(deps)).kind).toBe('found')
  })

  it('ignores another PR\'s records, this run, and runs from any other workflow', async () => {
    const foreign = { ...run(7), path: '.github/workflows/evil.yml' }
    const { deps, calls } = fakeApi([run(CURRENT_RUN), foreign, run(6)], {
      [CURRENT_RUN]: [record(1, 'PASS')], 7: [record(71, 'PASS')], 6: [record(61, 'PASS', { pr: '999' })],
    })
    const last = await lastEarnedVerdict(deps)
    expect(last).toEqual({ kind: 'none', runsSearched: 1 })
    expect(calls.some((c) => c.includes(`/runs/${CURRENT_RUN}/`))).toBe(false)
    expect(calls.some((c) => c.includes('/runs/7/'))).toBe(false)
  })

  it('none — a PR no review was ever earned on', async () => {
    const { deps, calls } = fakeApi([run(3), run(2)], { 3: [], 2: [] })
    expect(await lastEarnedVerdict(deps)).toEqual({ kind: 'none', runsSearched: 2 })
    expect(calls[0]).toContain(`branch=${encodeURIComponent(BRANCH)}`)
    expect(calls[0]).toContain(`per_page=${LAST_VERDICT_RUN_WINDOW}`)
    expect(calls[0]).toContain('status=completed')
  })

  // The fail-open this type exists to stop: a history that could not be
  // read must never be "nothing was earned", which a push concludes GREEN.
  it.each([
    ['the runs list fails', fakeApi(undefined, {})],
    ['a run\'s artifact list fails — it may hold the FAIL', fakeApi([run(5), run(4)], { 5: undefined, 4: [record(41, 'PASS')] })],
    ['one run recorded both a PASS and a FAIL', fakeApi([run(5)], { 5: [record(51, 'PASS'), record(52, 'FAIL')] })],
  ])('unreadable, never none — %s', async (_label, { deps }) => {
    expect((await lastEarnedVerdict(deps)).kind).toBe('unreadable')
  })

  it('unreadable for a PR that is not a number — never a regex over attacker text', async () => {
    const { deps } = fakeApi([run(5)], { 5: [record(51, 'PASS')] })
    expect((await lastEarnedVerdict({ ...deps, pr: '.*' })).kind).toBe('unreadable')
  })
})

// ---------------------------------------------------------------------------
// The real `review-gate` CLI, driven by injection.
// ---------------------------------------------------------------------------

/** A fake `gh`: answers from a route table, logs every argv, and fails for
 *  anything unrouted so an unexpected call cannot pass silently. */
const FAKE_GH = `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n')
const routes = JSON.parse(readFileSync(process.env.FAKE_GH_ROUTES, 'utf8'))
const line = args.join(' ')
for (const r of routes) {
  if (!new RegExp(r.match).test(line)) continue
  if (r.download !== undefined) {
    const dir = args[args.indexOf('-D') + 1]
    const name = args[args.indexOf('-n') + 1]
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name + '.json'), JSON.stringify(r.download))
  }
  if (r.stdout !== undefined) process.stdout.write(typeof r.stdout === 'string' ? r.stdout : JSON.stringify(r.stdout))
  process.exit(r.status ?? 0)
}
process.stderr.write('fake gh: no route for ' + line + '\\n')
process.exit(1)
`

let root: string
let repo: string
let headDir: string
let binDir: string
let baseSha: string
let headSha: string

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'push-carries-verdict-'))
  repo = join(root, 'repo')
  mkdirSync(join(repo, 'apps', 'worker', 'services'), { recursive: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'user.name', 'test')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'apps', 'worker', 'services', 'shift.ts'), 'export const a = 1\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  baseSha = git('rev-parse', 'HEAD')
  // Tier 2 on purpose — executable backend code, no crypto content — so
  // the gate gets past `low-tier` and reaches the push/request decision.
  writeFileSync(join(repo, 'apps', 'worker', 'services', 'shift.ts'), 'export const a = 2\nexport const b = 3\n')
  git('commit', '-q', '-am', 'head')
  headSha = git('rev-parse', 'HEAD')
  headDir = join(root, 'head')
  mkdirSync(join(headDir, 'apps', 'worker', 'services'), { recursive: true })
  writeFileSync(join(headDir, 'apps', 'worker', 'services', 'shift.ts'), 'export const a = 2\nexport const b = 3\n')
  binDir = join(root, 'bin')
  mkdirSync(binDir)
  writeFileSync(join(binDir, 'gh'), FAKE_GH)
  chmodSync(join(binDir, 'gh'), 0o755)
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

interface Route { match: string; status?: number; stdout?: unknown; download?: unknown }

/** Routes every scenario shares: the live PR read, and a cache MISS for
 *  this diff — so the gate has to decide on the push/request itself. */
const common: Route[] = [
  { match: `^api repos/${REPO}/pulls/${PR}$`, stdout: { labels: [], title: 'fix: shift math', body: '' } },
  { match: `^api repos/${REPO}/actions/artifacts\\?name=`, stdout: { artifacts: [] } },
]

const runsRoute = (runs: FakeRun[] | 'fail'): Route => runs === 'fail'
  ? { match: '/actions/workflows/fleet-review\\.yml/runs', status: 1 }
  : { match: '/actions/workflows/fleet-review\\.yml/runs', stdout: { workflow_runs: runs } }
const artifactsRoute = (id: number, list: FakeArtifact[]): Route =>
  ({ match: `/actions/runs/${id}/artifacts`, stdout: { artifacts: list } })

interface Scenario {
  action: 'synchronize' | 'review_requested'
  requestedReviewer?: string
  author?: string
  branch?: string
  routes: Route[]
}

interface GateRun { status: number | null; out: string; outputs: Record<string, string>; ghCalls: string[][] }

function reviewGate(s: Scenario): GateRun {
  const dir = mkdtempSync(join(root, 'run-'))
  const ghOutput = join(dir, 'github-output')
  const ghLog = join(dir, 'gh-log')
  writeFileSync(ghOutput, '')
  writeFileSync(ghLog, '')
  writeFileSync(join(dir, 'routes.json'), JSON.stringify([...common, ...s.routes]))
  const r = spawnSync('bun', [join(process.cwd(), 'orchestrator', 'src', 'cli.ts'), 'review-gate'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`,
      HOME: process.env['HOME'] ?? '',
      FLEET_REPO_ROOT: repo,
      FLEET_DIR: join(dir, 'fleet'),
      FLEET_CI_BRANCH: s.branch ?? BRANCH,
      FLEET_CI_PR: PR,
      FLEET_CI_HEAD_DIR: headDir,
      FLEET_CI_HEAD_SHA: headSha,
      FLEET_CI_BASE_SHA: baseSha,
      FLEET_REVIEW_EVENT_NAME: 'pull_request',
      FLEET_REVIEW_EVENT_ACTION: s.action,
      FLEET_REVIEW_REQUESTED_REVIEWER: s.requestedReviewer ?? '',
      FLEET_REVIEW_REQUESTED_TEAM: '',
      FLEET_REVIEW_PR_AUTHOR: s.author ?? 'rhonda-rodododo',
      FLEET_REVIEW_CACHE_DIR: join(dir, 'cache'),
      GITHUB_OUTPUT: ghOutput,
      GITHUB_RUN_ID: String(CURRENT_RUN),
      FAKE_GH_LOG: ghLog,
      FAKE_GH_ROUTES: join(dir, 'routes.json'),
    },
  })
  const outputs = Object.fromEntries(
    readFileSync(ghOutput, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
  const ghCalls = existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, outputs, ghCalls }
}

/** Every `gh` call a push made is a read: `api <GET path>` or `run download`. */
function onlyReads(calls: string[][]): void {
  for (const c of calls) {
    const read = (c[0] === 'api' && c.length === 2) || (c[0] === 'run' && c[1] === 'download')
    expect(read, `a push made a non-read gh call: ${c.join(' ')}`).toBe(true)
  }
}

describe('review-gate by injection — a push never starts a review, and is never red on its own account', () => {
  it('a push with a review still requested of llamenos-auto: carries the PASS it earned, no engine', () => {
    // A synchronize payload never carries `requested_reviewer`; it is set
    // here anyway, the worst case, to show a push naming a trigger login is
    // still not a request.
    const g = reviewGate({
      action: 'synchronize', requestedReviewer: 'llamenos-auto',
      routes: [runsRoute([run(8, 'earnedpass8')]), artifactsRoute(8, [record(81, 'PASS')])],
    })
    expect(g.status, g.out).toBe(0)
    expect(g.outputs['outcome']).toBe('carried')
    expect(g.outputs['earned_sha']).toBe('earnedpass8')
    expect(g.out).toContain('VERDICT: PASS (carried)')
    onlyReads(g.ghCalls)
  })

  it('a push with no review requested and none ever earned: green, saying nothing was reviewed', () => {
    const g = reviewGate({ action: 'synchronize', routes: [runsRoute([run(8), run(7)]), artifactsRoute(8, []), artifactsRoute(7, [])] })
    expect(g.status, g.out).toBe(0)
    expect(g.outputs['outcome']).toBe('unreviewed')
    expect(g.outputs['earned_sha']).toBe('')
    expect(g.out).toContain('nothing was reviewed')
    onlyReads(g.ghCalls)
  })

  it('a changed diff after a FAIL: the FAIL stands, with its text and the head it was earned on, no engine', () => {
    const g = reviewGate({
      action: 'synchronize',
      routes: [
        runsRoute([run(9), run(8, 'earnedfail8')]), artifactsRoute(9, []), artifactsRoute(8, [record(81, 'FAIL')]),
        { match: '^run download 8 ', download: { verdict: 'FAIL', text: 'VERDICT: FAIL — shift window off by one' } },
      ],
    })
    expect(g.status, g.out).toBe(1)
    expect(g.outputs['outcome']).toBe('carried')
    expect(g.outputs['earned_sha']).toBe('earnedfail8')
    expect(g.out).toContain('VERDICT: FAIL — shift window off by one')
    onlyReads(g.ghCalls)
  })

  it('a push whose history cannot be read fails closed — it never carries a FAIL into a green', () => {
    const g = reviewGate({ action: 'synchronize', routes: [runsRoute('fail')] })
    expect(g.status, g.out).toBe(1)
    expect(g.outputs['outcome']).toBe('carry-unreadable')
    onlyReads(g.ghCalls)
  })

  it('an explicit review request from llamenos-auto is the one path to the engine — and skips the history read', () => {
    const g = reviewGate({ action: 'review_requested', requestedReviewer: 'llamenos-auto', routes: [runsRoute('fail')] })
    expect(g.status, g.out).toBe(0)
    expect(g.outputs['outcome']).toBe('run-engine')
    expect(g.ghCalls.some((c) => c.join(' ').includes('/actions/workflows/'))).toBe(false)
  })

  describe('a PR authored by llamenos-auto (the release PR, fleet PRs)', () => {
    it('a push carries its verdict exactly as for any other author', () => {
      const g = reviewGate({
        action: 'synchronize', author: 'llamenos-auto',
        routes: [runsRoute([run(8, 'earnedpass8')]), artifactsRoute(8, [record(81, 'PASS')])],
      })
      expect(g.status, g.out).toBe(0)
      expect(g.outputs['outcome']).toBe('carried')
      // Whom to ask for another review is a login GitHub will accept (#1232).
      expect(g.out).toContain('`rhonda-rodododo`')
    })

    it('a review request from rhonda-rodododo reaches the engine', () => {
      const g = reviewGate({ action: 'review_requested', requestedReviewer: 'rhonda-rodododo', author: 'llamenos-auto', routes: [] })
      expect(g.status, g.out).toBe(0)
      expect(g.outputs['outcome']).toBe('run-engine')
    })

    it('a review request naming llamenos-auto is refused, naming rhonda-rodododo instead', () => {
      const g = reviewGate({ action: 'review_requested', requestedReviewer: 'llamenos-auto', author: 'llamenos-auto', routes: [] })
      expect(g.status, g.out).toBe(1)
      expect(g.outputs['outcome']).toBe('not-requested')
      expect(g.out).toContain('`rhonda-rodododo`')
    })
  })
})
