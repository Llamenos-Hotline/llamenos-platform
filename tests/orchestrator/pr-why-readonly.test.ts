import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * #2469: `pr-why` is read-only, proven at the lowest layer there is. Every
 * process this command's DEFAULT dependencies spawn — its own reads AND the
 * `missing-checks` reads it composes with — is captured here at
 * `execFile`, and each argv must pass `assertReadOnlyGhArgs`. A future edit
 * that gives the command a write (a `pr merge`, a label, a GraphQL mutation,
 * a `run cancel`) fails this test even if it bypasses `ghRead`, because the
 * capture is underneath `gh.ts` itself.
 */

interface Spawn { file: string; args: string[] }
const spawned: Spawn[] = []
let respond: (args: string[]) => string = () => { throw new Error('no responder') }

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { vi: vitest } = await import('vitest')
  const { promisify } = await import('node:util')
  const mockFn = vitest.fn()
  ;(mockFn as unknown as Record<symbol, unknown>)[promisify.custom] = async (file: string, args: readonly string[]) => {
    spawned.push({ file, args: [...args] })
    return { stdout: respond([...args]), stderr: '' }
  }
  return { ...actual, execFile: mockFn }
})

const { assertReadOnlyGhArgs, runPrWhy } = await import('../../orchestrator/src/pr-why.js')

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pr-why')
const PR = JSON.parse(readFileSync(join(FIXTURES, 'pr-2470.json'), 'utf8')) as { data: { repository: { pullRequest: { headRefOid: string; changedFiles: number } } } }
const REVIEW_RUNS = readFileSync(join(FIXTURES, 'review-runs-2467-77962f5.json'), 'utf8')
const HEAD = PR.data.repository.pullRequest.headRefOid

/** A canned GitHub, keyed on what each read asks for. Anything it does not
 *  recognise THROWS — an unexpected call is a test failure, not a default. */
function cannedGitHub(args: string[]): string {
  const joined = args.join(' ')
  if (args[0] === 'api' && args[1] === 'graphql') {
    if (joined.includes('pullRequest(number')) return JSON.stringify(PR)
    if (joined.includes('checkSuites')) return REVIEW_RUNS
    if (joined.includes('object(expression')) return JSON.stringify({ data: { repository: { github: null, root: { text: 'apps/worker/lib/ @rhonda-rodododo\n' }, docs: null } } })
  }
  if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: HEAD })
  if (joined.includes('/rules/branches/main')) {
    return JSON.stringify([[
      { type: 'pull_request', parameters: { required_approving_review_count: 0, require_code_owner_review: true } },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci-status' }, { context: 'fleet/review' }] } },
    ]])
  }
  if (joined.includes(`/pulls/2470/files`)) {
    return JSON.stringify([Array.from({ length: PR.data.repository.pullRequest.changedFiles }, (_, i) => ({ filename: `apps/worker/lib/f${i}.ts` }))])
  }
  if (joined.includes(`/commits/${HEAD}/check-runs`)) {
    return JSON.stringify([{ check_runs: [
      { id: 1, name: 'ci-status', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: '2026-11-05T10:00:00Z' },
      { id: 2, name: 'fleet/review', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: '2026-11-05T10:00:00Z' },
    ] }])
  }
  if (joined.includes(`/commits/${HEAD}/status`)) return JSON.stringify([{ statuses: [] }])
  if (joined.includes(`actions/runs?head_sha=${HEAD}`)) return JSON.stringify([{ workflow_runs: [] }])
  throw new Error(`unexpected gh call: ${joined.slice(0, 200)}`)
}

beforeEach(() => {
  spawned.length = 0
  respond = cannedGitHub
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

describe('pr-why\'s whole default path is read-only', () => {
  it('runs end to end on the default deps and reaches a verdict', async () => {
    // 2470 is a draft touching owned apps/worker/lib/ paths with no approval.
    expect(await runPrWhy(['2470'])).toBe(1)
    const out = (process.stdout.write as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('')
    expect(out).toContain('draft')
    expect(out).toContain('codeowner-approval-missing')
  })

  it('spawns nothing but gh, and every gh argv is a read', async () => {
    await runPrWhy(['2470'])
    // Vacuity guard: the capture must have seen the composed missing-checks
    // reads too, not only pr-why's own.
    const joined = spawned.map((s) => s.args.join(' '))
    expect(joined.some((a) => a.includes('/check-runs'))).toBe(true)
    expect(joined.some((a) => a.includes('actions/runs?head_sha='))).toBe(true)
    expect(joined.some((a) => a.includes('pullRequest(number'))).toBe(true)
    expect(spawned.length).toBeGreaterThanOrEqual(9)
    for (const s of spawned) {
      expect(s.file).toBe('gh')
      expect(() => assertReadOnlyGhArgs(s.args), s.args.join(' ').slice(0, 120)).not.toThrow()
    }
  })

  it('never asks GitHub for reviewDecision', async () => {
    await runPrWhy(['2470'])
    for (const s of spawned) expect(s.args.join(' ')).not.toContain('reviewDecision')
  })

  it('a 502 from GitHub on any one read makes the exit 2, never 0 or 1', async () => {
    for (const marker of ['pullRequest(number', 'checkSuites', '/check-runs', 'actions/runs?head_sha=', '/pulls/2470/files', '/rules/branches/main', 'object(expression']) {
      respond = (args) => {
        if (args.join(' ').includes(marker)) throw Object.assign(new Error('Command failed'), { code: 1, stderr: 'HTTP 502: Bad Gateway' })
        return cannedGitHub(args)
      }
      const code = await runPrWhy(['2470'])
      // The review-runs read is only CONSULTED when fleet/review is red; it
      // is green here, so its failure costs nothing and must not invent an
      // unknown. Every other read is load-bearing on this PR.
      expect(code, marker).toBe(marker === 'checkSuites' ? 1 : 2)
    }
  })
})

describe('assertReadOnlyGhArgs refuses what it exists to refuse', () => {
  it.each([
    [['pr', 'merge', '2450', '--auto', '--squash']],
    [['pr', 'merge', '2450', '--disable-auto']],
    [['pr', 'edit', '2450', '--add-label', 'queue-cleared']],
    [['pr', 'ready', '2450']],
    [['pr', 'review', '2450']],
    [['run', 'cancel', '123']],
    [['run', 'rerun', '123']],
    [['issue', 'comment', '1', '--body', 'x']],
    [['api', '-X', 'POST', 'repos/R/actions/runs/1/force-cancel']],
    [['api', '-XPOST', 'repos/R/actions/runs/1/force-cancel']],
    [['api', '--method', 'DELETE', 'repos/R/pulls/1/requested_reviewers']],
    [['api', '--method=PUT', 'repos/R/pulls/1/merge']],
    [['api', 'repos/R/issues/1/labels', '-f', 'labels[]=queue-cleared']],
    [['api', 'repos/R/pulls/1/requested_reviewers', '-F', 'reviewers[]=x']],
    [['api', 'repos/R/pulls/1/requested_reviewers', '--raw-field', 'reviewers[]=x']],
    [['api', 'repos/R/pulls/1/reviews', '--input', 'body.json']],
    [['api', 'graphql', '-f', 'query=mutation { dequeuePullRequest(input: {id: "x"}) { clientMutationId } }']],
    [['api', 'graphql', '-f', 'query=  # a comment\nmutation($id: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }']],
    [['api', 'graphql', '-f', 'query=MUTATION { x }']],
    [['api', 'graphql', '-X', 'GET', '-f', 'query=query { x }']],
    [['api', 'graphql', '-f', 'query=query { a }', '-f', 'query=mutation { b }']],
    [['api', 'graphql', '-f', 'owner=x']],
  ])('refuses %j', (args) => {
    expect(() => assertReadOnlyGhArgs(args)).toThrow('read-only')
  })

  it.each([
    [['api', '--paginate', '--slurp', 'repos/R/pulls/1/files?per_page=100']],
    [['api', 'graphql', '-f', 'query=query($n: Int!) { repository { pullRequest(number: $n) { number } } }', '-F', 'number=1']],
    [['pr', 'view', '1', '--json', 'headRefOid']],
  ])('admits %j', (args) => {
    expect(() => assertReadOnlyGhArgs(args)).not.toThrow()
  })
})
