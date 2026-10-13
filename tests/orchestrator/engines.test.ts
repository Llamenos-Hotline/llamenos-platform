import { describe, it, expect } from 'vitest'
import {
  statusToOutcome, parseStatusFile, buildArgs, isTerminalStatus, resolveDispatchModel,
  doctorRegistryIdForOpencodeModel, modelResolutionProblem,
  parseWorkerLogSignal, detectQuotaFromLog, extractResetHint, parseResetAt, QUOTA_MESSAGE_RE,
  resolveLaunchOutcome,
} from '../../orchestrator/src/engines.js'
import { itemIdFromBranch, laneIdFromBranch } from '../../orchestrator/src/ci.js'
import type { Lane } from '../../orchestrator/src/config.js'

describe('parseStatusFile', () => {
  it('parses the key: value protocol', () => {
    const r = parseStatusFile('session: x\nstatus: SUCCESS\npr: 42\nduration_sec: 10\nnotes: did the thing\n')
    expect(r['status']).toBe('SUCCESS')
    expect(r['pr']).toBe('42')
    expect(r['notes']).toBe('did the thing')
  })
  it('keeps colons inside a value', () => {
    expect(parseStatusFile('notes: fixed a: b mapping')['notes']).toBe('fixed a: b mapping')
  })
  it('tolerates a truncated final line', () => {
    expect(parseStatusFile('status: SUCCESS\npr')['status']).toBe('SUCCESS')
  })
})

describe('statusToOutcome', () => {
  it.each([
    ['SUCCESS', 'SUCCESS'], ['BLOCKED', 'BLOCKED'], ['FAILED', 'FAILED'],
    ['NEEDS_CONTEXT', 'BLOCKED'], ['PARTIAL', 'BLOCKED'],
  ])('maps %s to %s', (s, o) => expect(statusToOutcome(s)).toBe(o))

  it('maps a non-terminal status to FAILED rather than guessing success', () => {
    expect(statusToOutcome('IN_PROGRESS')).toBe('FAILED')
    expect(statusToOutcome('DISPATCHED')).toBe('FAILED')
  })

  it('maps an unknown status to FAILED', () => {
    expect(statusToOutcome('WAT')).toBe('FAILED')
  })

  // The launcher footer in dispatch-one.sh writes UNCONFIRMED when the
  // runtime exits cleanly but the worker never wrote a terminal status
  // itself. It must map to FAILED, not SUCCESS.
  it('maps UNCONFIRMED to FAILED', () => {
    expect(statusToOutcome('UNCONFIRMED')).toBe('FAILED')
  })
})

// dispatch-one.sh's full status vocabulary (audited directly against the
// script — see the comment on TERMINAL_STATUSES in engines.ts). Every value
// the script can write to a .status file's `status:` key must be classified
// here explicitly, so a value the poll loop fails to recognize as terminal
// — which costs a capped lane its full dispatch timeout waiting on a worker
// that already finished — is a unit-test failure, not a production incident.
describe('isTerminalStatus', () => {
  it.each(['SUCCESS', 'BLOCKED', 'FAILED', 'PARTIAL', 'NEEDS_CONTEXT', 'UNCONFIRMED'])(
    'treats %s as terminal', (s) => expect(isTerminalStatus(s)).toBe(true))

  it.each(['DISPATCHED', 'IN_PROGRESS', 'WAT'])(
    'does not treat %s as terminal', (s) => expect(isTerminalStatus(s)).toBe(false))
})

describe('buildArgs', () => {
  const lane: Lane = {
    id: 'backend', mode: 'live', cap: 1, engine: 'claude',
    requireLabel: 'agent-dispatchable', vetoLabels: [],
    scope: { owned: ['apps/worker/', 'sip-bridge/'], notOwned: [] },
  }
  it('passes the lane supervisor as --agent', () => {
    expect(buildArgs({ name: 'n', itemId: '704', briefPath: '/b', lane, timeoutSec: 60, model: 'sonnet', effort: 'medium' }))
      .toContain('--agent')
    expect(buildArgs({ name: 'n', itemId: '704', briefPath: '/b', lane, timeoutSec: 60, model: 'sonnet', effort: 'medium' }))
      .toContain('backend-supervisor')
  })
  it('passes the lane scope as --owns, comma separated', () => {
    const a = buildArgs({ name: 'n', itemId: '704', briefPath: '/b', lane, timeoutSec: 60, model: 'sonnet', effort: 'medium' })
    expect(a[a.indexOf('--owns') + 1]).toBe('apps/worker/,sip-bridge/')
  })
  it('refuses to build args for a lane with an empty scope', () => {
    const bare = { ...lane, scope: { owned: [], notOwned: [] } }
    expect(() => buildArgs({ name: 'n', itemId: '704', briefPath: '/b', lane: bare, timeoutSec: 60, model: 'sonnet', effort: 'medium' }))
      .toThrow(/scope/i)
  })
  it('always injects the llamenos project rules', () => {
    const a = buildArgs({ name: 'n', itemId: '704', briefPath: '/b', lane, timeoutSec: 60, model: 'sonnet', effort: 'medium' })
    expect(a[a.indexOf('--rules') + 1]).toBe('llamenos')
  })
  // Issue #812: without --branch, dispatch-one.sh cuts the worktree on the
  // worker NAME (`fleet-backend-704`), which the fleet's own branch grammar
  // does not recognise — verify is skipped and CI treats the PR as unscoped.
  // Dropping the flag (mutation) fails this test: indexOf misses and the
  // branch assertions below never see the grammar.
  it('passes --branch fleet/<lane>/<item> on every dispatch', () => {
    const a = buildArgs({ name: 'fleet-backend-704', itemId: '704', briefPath: '/b', lane, timeoutSec: 60, model: 'sonnet', effort: 'medium' })
    expect(a).toContain('--branch')
    const branch = a[a.indexOf('--branch') + 1] ?? ''
    expect(branch).toBe('fleet/backend/704')
    expect(laneIdFromBranch(branch)).toBe('backend')
    expect(itemIdFromBranch(branch)).toBe('704')
  })
  it('refuses to build a branch the fleet grammar cannot read back', () => {
    expect(() => buildArgs({ name: 'n', itemId: '7/04', briefPath: '/b', lane, timeoutSec: 60, model: 'sonnet', effort: 'medium' }))
      .toThrow(/fleet branch/)
  })
  it('passes name, brief path, timeout and model as positionals after the flags', () => {
    const a = buildArgs({ name: 'n', itemId: '704', briefPath: '/b', lane, timeoutSec: 60, model: 'sonnet', effort: 'medium' })
    expect(a.slice(-4)).toEqual(['n', '/b', '60', 'sonnet'])
  })
})

describe('buildArgs with an opencode lane', () => {
  const ocLane: Lane = {
    id: 'backend', mode: 'live', cap: 1, engine: 'opencode',
    requireLabel: 'agent-dispatchable', vetoLabels: [],
    scope: { owned: ['apps/worker/'], notOwned: [] },
  }
  const req = { name: 'n', itemId: '704', briefPath: '/b', timeoutSec: 60, effort: 'high' as const }

  it('omits --effort entirely (dispatch-one.sh only warns and ignores it for opencode)', () => {
    const a = buildArgs({ ...req, lane: ocLane, model: 'kimi' })
    expect(a).not.toContain('--effort')
  })

  it('still passes --effort for a claude lane', () => {
    const a = buildArgs({ ...req, lane: { ...ocLane, engine: 'claude' }, model: 'sonnet' })
    expect(a[a.indexOf('--effort') + 1]).toBe('high')
  })

  it('passes the lane model through as the final positional argument', () => {
    const a = buildArgs({ ...req, lane: ocLane, model: 'kimi-thinking' })
    expect(a[a.length - 1]).toBe('kimi-thinking')
    expect(a.slice(-4)).toEqual(['n', '/b', '60', 'kimi-thinking'])
  })

  it('maps the raw kimi registry model id to the dispatcher\'s kimi token', () => {
    const a = buildArgs({ ...req, lane: ocLane, model: 'kimi-code-plan-global/k3-256k' })
    expect(a[a.length - 1]).toBe('kimi')
  })

  it('still maps the RETIRED kimi provider id to the kimi token (lane files on disk may carry it)', () => {
    const a = buildArgs({ ...req, lane: ocLane, model: 'kimi-for-coding/k3-256k' })
    expect(a[a.length - 1]).toBe('kimi')
  })

  it('wraps any other raw provider/model id as opencode:<model>', () => {
    const a = buildArgs({ ...req, lane: ocLane, model: 'zai-coding-plan/glm-4.6' })
    expect(a[a.length - 1]).toBe('opencode:zai-coding-plan/glm-4.6')
  })

  it('passes existing dispatcher tokens through untouched', () => {
    for (const token of ['kimi', 'kimi-thinking', 'opencode:foo/bar', 'glm', 'glm:glm-5.3-flash', 'copilot', 'copilot:gpt-5.4', 'kimi-cli', 'kimi-cli:kimi-code/kimi-for-coding']) {
      const a = buildArgs({ ...req, lane: ocLane, model: token })
      expect(a[a.length - 1]).toBe(token)
    }
  })
})

describe('resolveDispatchModel', () => {
  it('leaves claude-engine models untouched', () => {
    expect(resolveDispatchModel('claude', 'sonnet')).toBe('sonnet')
    expect(resolveDispatchModel('claude', 'opus')).toBe('opus')
  })

  it('maps the kimi registry id to the kimi token for the opencode engine', () => {
    expect(resolveDispatchModel('opencode', 'kimi-code-plan-global/k3-256k')).toBe('kimi')
  })

  it('maps the retired kimi-for-coding registry id to the kimi token (issue #1738)', () => {
    expect(resolveDispatchModel('opencode', 'kimi-for-coding/k3-256k')).toBe('kimi')
  })

  it('wraps unknown raw ids as opencode:<model>', () => {
    expect(resolveDispatchModel('opencode', 'some-provider/some-model')).toBe('opencode:some-provider/some-model')
  })

  it('does not double-wrap a model that is already a dispatcher token', () => {
    expect(resolveDispatchModel('opencode', 'opencode:some-provider/some-model')).toBe('opencode:some-provider/some-model')
    expect(resolveDispatchModel('opencode', 'kimi-thinking')).toBe('kimi-thinking')
  })
})

// Issue #1738: doctor's model-resolution rail. A provider id that was renamed
// (kimi-for-coding → kimi-code-plan-global) fails at dispatch time as a
// generic "server error" while a binary-only doctor reports ok — these cover
// the pure core of the check that closes that gap.
describe('doctorRegistryIdForOpencodeModel', () => {
  it('passes a raw provider/model id through for checking', () => {
    expect(doctorRegistryIdForOpencodeModel('some-provider/some-model')).toBe('some-provider/some-model')
  })

  it('resolves the bare kimi token to the registry id dispatch-one.sh maps it to', () => {
    expect(doctorRegistryIdForOpencodeModel('kimi')).toBe('kimi-code-plan-global/k3-256k')
  })

  it('resolves both the current and the retired raw kimi ids to the mirrored registry id', () => {
    expect(doctorRegistryIdForOpencodeModel('kimi-code-plan-global/k3-256k')).toBe('kimi-code-plan-global/k3-256k')
    expect(doctorRegistryIdForOpencodeModel('kimi-for-coding/k3-256k')).toBe('kimi-code-plan-global/k3-256k')
  })

  it('returns undefined for dispatcher tokens whose mapping only dispatch-one.sh knows', () => {
    expect(doctorRegistryIdForOpencodeModel('glm')).toBeUndefined()
    expect(doctorRegistryIdForOpencodeModel('copilot')).toBeUndefined()
    expect(doctorRegistryIdForOpencodeModel('kimi-thinking')).toBeUndefined()
  })
})

describe('modelResolutionProblem', () => {
  const available = [
    'kimi-code-plan-global/k3',
    'kimi-code-plan-global/k3-256k',
    'kimi-code-plan-global/kimi-for-coding',
    'other-provider/other-model',
  ]

  it('returns undefined when the id resolves', () => {
    expect(modelResolutionProblem('kimi-code-plan-global/k3-256k', available)).toBeUndefined()
  })

  it('names the dead id and calls it a misconfiguration, not an outage', () => {
    const problem = modelResolutionProblem('kimi-for-coding/k3-256k', available)
    expect(problem).toContain('"kimi-for-coding/k3-256k"')
    expect(problem).toContain('misconfiguration, not an outage')
  })

  it('lists same-provider ids that DO resolve, not the whole registry', () => {
    const problem = modelResolutionProblem('kimi-for-coding/k3-256k', available)
    expect(problem).toContain('kimi-code-plan-global/k3-256k')
    expect(problem).not.toContain('other-provider/other-model')
  })

  it('falls back to a name-substring match when no id shares the provider', () => {
    const problem = modelResolutionProblem('gone-provider/k3-256k', available)
    expect(problem).toContain('kimi-code-plan-global/k3-256k')
  })

  it('caps the suggestion list so a large registry stays readable', () => {
    const many = Array.from({ length: 50 }, (_, i) => `p/m${i}`)
    const problem = modelResolutionProblem('p/dead', many)
    if (problem === undefined) throw new Error('expected a problem for a dead id')
    expect(problem.split('p/m').length - 1).toBeLessThanOrEqual(10)
  })
})

// Real fixture: ~/fleet-android-765.log (2026-09-18/19, issue #817) —
// a Kimi/opencode worker that died on its very first API call with a bare
// `{"type":"error",...}` event, no `{"type":"result",...}` wrapper at all.
// dispatch-one.sh's own launcher-footer summary for this exact run recorded
// an EMPTY final message ("...Final message:") in the .status file, because
// its parser only recognizes Claude's stream-json shapes — this raw log is
// the only place the real quota text survives. String.raw so the fixture's
// own backslash-escaped nested JSON (inside "responseBody") round-trips
// byte-for-byte, exactly as dispatch-one.sh wrote it.
const FLEET_ANDROID_765_LOG = String.raw`{"type":"error","timestamp":1789704553442,"sessionID":"ses_f4d4bd277ffewA2CN7Z0gVOgL7","error":{"name":"APIError","data":{"message":"You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota","statusCode":403,"isRetryable":false,"responseHeaders":{"cf-cache-status":"DYNAMIC","cf-ray":"a3cd7e6ab978bd6a-QRO","connection":"keep-alive","content-encoding":"gzip","content-type":"application/json; charset=utf-8","date":"Fri, 18 Sep 2026 04:09:13 GMT","server":"cloudflare","strict-transport-security":"max-age=31536000; includeSubDomains","transfer-encoding":"chunked","x-internal-adhoc-canary":"3431959428","x-trace-id":"d7a58c3def72c1be5728acb87c417788","set-cookie":"__cf_bm=P18HHTRCfQih1cx27KSodP4WmeqtikW21kk1xBTiTKU-1789704552.1185217-1.0.1.1-5bQxsJZ2V59if_X1vK7tN1K65yBOzJRDesL5v4S_fHJzbc_Sv4xnUZ63xCtfSvQb_vq7NLxQwftp39cT6rjL_04aLlHOouT2cIcoHICBRHQc6a5ovAKebiqW8XbsPZPL; HttpOnly; SameSite=None; Secure; Path=/; Domain=kimi.com; Expires=Fri, 18 Sep 2026 04:39:13 GMT"},"responseBody":"{\"error\":{\"type\":\"permission_error\",\"message\":\"You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota\"},\"type\":\"error\"}","metadata":{"url":"https://api.kimi.com/coding/v1/messages"}}}}
`

describe('parseWorkerLogSignal', () => {
  it('parses the real fleet-android-765 fixture: zero turns, the nested quota message', () => {
    const signal = parseWorkerLogSignal(FLEET_ANDROID_765_LOG)
    expect(signal.turns).toBe(0)
    expect(signal.finalMessage).toContain('5-hour usage limit')
  })

  it('tolerates a line that fails to parse as JSON, same as parseStatusFile does for a truncated line', () => {
    expect(() => parseWorkerLogSignal('not json at all\n{"type":"assistant"}\n')).not.toThrow()
  })

  it("prefers Claude stream-json's terminal result event for both turns and the final message", () => {
    const log = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'mid-run text, not the final word' }] } }),
      JSON.stringify({ type: 'result', num_turns: 1, total_cost_usd: 0, result: "You've hit your session limit \u00b7 resets 1:20pm (America/New_York)" }),
    ].join('\n')
    const signal = parseWorkerLogSignal(log)
    expect(signal.turns).toBe(1)
    expect(signal.finalMessage).toBe("You've hit your session limit \u00b7 resets 1:20pm (America/New_York)")
  })

  it('counts opencode step events as turns when there is no terminal result object', () => {
    const log = [
      JSON.stringify({ type: 'step_start' }),
      JSON.stringify({ type: 'step_finish' }),
      JSON.stringify({ type: 'step_start' }),
      JSON.stringify({ type: 'step_finish' }),
    ].join('\n')
    expect(parseWorkerLogSignal(log).turns).toBe(4)
  })
})

describe('QUOTA_MESSAGE_RE', () => {
  it.each([
    "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.",
    'weekly (7-day) usage limit',
    "You've hit your weekly limit \u00b7 resets 6pm (America/New_York)",
    'a generic usage limit message',
    'rate_limit',
  ])('matches %s', (msg) => expect(QUOTA_MESSAGE_RE.test(msg)).toBe(true))

  it('does not match an ordinary task failure', () => {
    expect(QUOTA_MESSAGE_RE.test('TypeError: cannot read properties of undefined (reading \'foo\')')).toBe(false)
  })
})

describe('extractResetHint', () => {
  it('extracts the real fleet-android-765 hint verbatim', () => {
    const { finalMessage } = parseWorkerLogSignal(FLEET_ANDROID_765_LOG)
    expect(extractResetHint(finalMessage)).toBe('when the current 5-hour window ends')
  })

  it('extracts a clock-time hint up to the next sentence boundary', () => {
    expect(extractResetHint("You've hit your weekly limit \u00b7 resets 6pm (America/New_York)")).toBe('6pm (America/New_York)')
  })

  it('returns undefined when the message never says "reset" at all', () => {
    expect(extractResetHint('a generic usage limit message')).toBeUndefined()
  })
})

describe('parseResetAt', () => {
  it('returns undefined for a relative window with no clock time — the real fleet-android-765 case', () => {
    expect(parseResetAt('when the current 5-hour window ends')).toBeUndefined()
  })

  it('resolves a bare clock time against the given now (local time, no tz given)', () => {
    const now = new Date('2026-09-19T10:00:00.000Z')
    const at = parseResetAt('6pm', now)
    expect(at).toBeDefined()
    expect(new Date(at as number).getHours()).toBe(18)
  })

  it('rolls over to tomorrow when the named clock time has already passed today', () => {
    const now = new Date()
    now.setHours(23, 0, 0, 0)
    const at = parseResetAt('1am', now)
    expect(at).toBeDefined()
    expect(at as number).toBeGreaterThan(now.getTime())
  })

  it('resolves an IANA-timezone-qualified hint to an absolute instant', () => {
    const now = new Date('2026-09-13T14:00:00.000Z') // 10:00 America/New_York, before 1:20pm
    const at = parseResetAt('1:20pm (America/New_York)', now)
    expect(at).toBeDefined()
    // 1:20pm EDT (UTC-4 in September) is 17:20 UTC.
    expect(new Date(at as number).toISOString()).toBe('2026-09-13T17:20:00.000Z')
  })
})

describe('detectQuotaFromLog', () => {
  it('classifies the real fleet-android-765 fixture as QUOTA at turn 0, hint recorded, no absolute reset time', () => {
    const detection = detectQuotaFromLog(FLEET_ANDROID_765_LOG)
    expect(detection.isQuota).toBe(true)
    expect(detection.resetHint).toBe('when the current 5-hour window ends')
    // No clock time in this message at all — resetAt stays unparsed; the
    // 60-minute default lives in circuit.ts's quotaBreaker, not here.
    expect(detection.resetAt).toBeUndefined()
  })

  it('does not classify a worker that ran many turns before eventually hitting quota mid-task', () => {
    // The real fleet-android-765 SECOND attempt: "turns=53 cost=$1.93" then hit
    // the weekly limit mid-task — legitimate unfinished work, not "never got a
    // chance to try" (issue #817's own two-part test).
    const log = [
      ...Array.from({ length: 53 }, () => JSON.stringify({ type: 'step_finish' })),
      JSON.stringify({ type: 'error', error: { data: { message: "You've hit your weekly limit \u00b7 resets 6pm (America/New_York)" } } }),
    ].join('\n')
    expect(detectQuotaFromLog(log).isQuota).toBe(false)
  })

  it('does not classify an ordinary turn-1 failure (no quota wording) as quota', () => {
    const log = JSON.stringify({ type: 'error', error: { data: { message: 'ECONNREFUSED: could not reach the API' } } })
    expect(detectQuotaFromLog(log).isQuota).toBe(false)
  })

  it('classifies a Claude stream-json weekly-limit rejection the same way, with a resolved resetAt', () => {
    const log = [
      JSON.stringify({ type: 'result', num_turns: 1, total_cost_usd: 0, result: "You've hit your weekly limit \u00b7 resets 6pm (America/New_York)" }),
    ].join('\n')
    const now = new Date('2026-09-18T12:00:00.000Z') // before 6pm America/New_York (22:00 UTC)
    const detection = detectQuotaFromLog(log, now)
    expect(detection.isQuota).toBe(true)
    expect(detection.resetHint).toBe('6pm (America/New_York)')
    expect(detection.resetAt).toBeDefined()
    expect(new Date(detection.resetAt as number).toISOString()).toBe('2026-09-18T22:00:00.000Z')
  })
})

// Real fixtures, issue #870 (2026-09-19): `fleet-backend-705` and
// `fleet-desktop-775` were both dispatched (a redispatch, onto a branch that
// already had an open PR from a prior REJECTED round) within milliseconds of
// `fleet-infra-722` — three lanes launched in the same tick, all contending
// for one box. `dispatch()`'s own supervising `execFileAsync(DISPATCH_SCRIPT,
// ...)` call — bounded by a 60s timeout because dispatch-one.sh "returns
// almost immediately" under normal load — rejected for at least two of the
// three, with exactly this truncated `Command failed: …` text recorded on
// the ledger row. But the WORKER kept running in dispatch-one.sh's own
// detached tmux session regardless, and 90/50 minutes later wrote a real
// terminal SUCCESS with a real PR to its own `.status` file — this is that
// file's actual content, verbatim (long `notes:` line preserved in full: a
// truncated fixture here would not prove the fix survives the size of a real
// worker note).
const FLEET_BACKEND_705_STATUS_TEXT = [
  'session: fleet-backend-705',
  'status: SUCCESS',
  'pr: https://github.com/rhonda-rodododo/llamenos-platform/pull/860',
  'merged_sha: none',
  'duration_sec: 5400',
  'notes: hono ^4.12.21 -> ^4.13.8 (+overrides.hono >=4.12.25 to dedupe the transitive copy from ' +
    '@modelcontextprotocol/sdk via shadcn devDep); removed GHSA-88fw-hqm2-52qc from audit-allowlist.txt; ' +
    'added named CORS regression test; bun audit clean, simulated CI audit job exits 0. Also allowlisted ' +
    'GHSA-7q85-xj36-vmfc (adm-zip, unrelated new advisory published 2026-09-18, was blocking a clean audit ' +
    'run independent of hono; tracked under #649). typecheck clean; test:worker:unit 198/198 files, ' +
    '3996/3996 tests pass; test:backend:bdd 851 passed/182 skipped/2 failed (both pre-existing/environmental: ' +
    'sip-bridge sidecar not started, unrelated caller-ban state in analytics scenario).',
].join('\n')

// The real ledger `note` for the SAME run, truncated to 300 chars by
// `ledger.ts`'s `truncateNote` — the exact text `dispatch()`'s own launch
// call threw before this fix.
const FLEET_BACKEND_705_LAUNCH_ERROR =
  'Command failed: /home/operator/.claude/skills/supervising-dispatched-sessions/dispatch-one.sh --branch ' +
  'fleet/backend/705 --agent backend-supervisor --owns apps/worker/,sip-bridge/,signal-notifier/,tests/steps/ ' +
  '--effort high --rules llamenos fleet-backend-705 /home/operator/.llamenos-fleet/briefs/fleet-bac'

describe('resolveLaunchOutcome (issue #870)', () => {
  it('records the worker\'s own real SUCCESS + PR even though the launch call itself errored', () => {
    const status = parseStatusFile(FLEET_BACKEND_705_STATUS_TEXT)
    const result = resolveLaunchOutcome({
      launchError: FLEET_BACKEND_705_LAUNCH_ERROR,
      status,
      seed: undefined,
      depCommit: 'abc123', rtCommit: 'def456',
      workerLog: undefined,
    })
    // This is the assertion a regression would flip: a launch-call error
    // must NEVER by itself downgrade a real terminal SUCCESS the worker
    // already wrote. Mutation check — replace this fix with "launchError
    // !== undefined ? FAILED : statusToOutcome(...)" and this fails.
    expect(result.outcome).toBe('SUCCESS')
    expect(result.pr).toBe('https://github.com/rhonda-rodododo/llamenos-platform/pull/860')
  })

  it('still records FAILED when the launch call errored AND no status file ever appeared', () => {
    // The genuinely-dead-launch case must be unaffected: this fixes the
    // FALSE failure, not failure detection itself.
    const result = resolveLaunchOutcome({
      launchError: FLEET_BACKEND_705_LAUNCH_ERROR,
      status: undefined,
      seed: undefined,
      depCommit: 'abc123', rtCommit: 'def456',
      workerLog: undefined,
    })
    expect(result.outcome).toBe('FAILED')
  })

  it('keeps the launch-call error visible in the note for a human, without it driving the outcome', () => {
    const status = parseStatusFile(FLEET_BACKEND_705_STATUS_TEXT)
    const result = resolveLaunchOutcome({
      launchError: FLEET_BACKEND_705_LAUNCH_ERROR, status, seed: undefined, depCommit: 'abc123', rtCommit: 'def456', workerLog: undefined,
    })
    expect(result.note).toContain('launch-call warning')
    expect(result.note).toContain('Command failed')
  })

  it('a launch error never overrides a real terminal BLOCKED either', () => {
    const status = parseStatusFile('status: BLOCKED\nnotes: scope conflict, needs a human\n')
    const result = resolveLaunchOutcome({
      launchError: 'Command failed: dispatch-one.sh timed out', status, seed: undefined, depCommit: 'abc', rtCommit: 'def', workerLog: undefined,
    })
    expect(result.outcome).toBe('BLOCKED')
  })

  it('with no launchError at all, behaves exactly as before (pure pass-through of the status file)', () => {
    const status = parseStatusFile(FLEET_BACKEND_705_STATUS_TEXT)
    const result = resolveLaunchOutcome({ launchError: undefined, status, seed: undefined, depCommit: 'abc', rtCommit: 'def', workerLog: undefined })
    expect(result.outcome).toBe('SUCCESS')
    expect(result.note).not.toContain('launch-call warning')
  })

  // Issue #1801: the ledger note carries BOTH provenance revisions — the
  // dispatch dependency's (dep:) and the fleet runtime's own (rt:) — so a
  // run's behaviour is attributable to exact code after the fact. The drift
  // incident's forensics failed precisely because the runtime half was
  // missing.
  it('the note records the fleet runtime commit alongside the dispatch dependency commit', () => {
    const status = parseStatusFile(FLEET_BACKEND_705_STATUS_TEXT)
    const result = resolveLaunchOutcome({ launchError: undefined, status, seed: undefined, depCommit: 'abc123', rtCommit: 'def456', workerLog: undefined })
    expect(result.note).toContain('dep:abc123')
    expect(result.note).toContain('rt:def456')
  })

  it('unknown revisions degrade to an explicit marker, never a silent omission', () => {
    const status = parseStatusFile(FLEET_BACKEND_705_STATUS_TEXT)
    const result = resolveLaunchOutcome({ launchError: undefined, status, seed: undefined, depCommit: undefined, rtCommit: undefined, workerLog: undefined })
    expect(result.note).toContain('dep:unknown')
    expect(result.note).toContain('rt:unknown')
  })
})
