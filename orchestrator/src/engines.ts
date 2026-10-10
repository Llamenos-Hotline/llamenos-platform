import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DISPATCH_SCRIPT } from './paths.js'
import { checkDispatchDependency, gitFactsFor } from './dependency.js'
import { fleetRuntimeRoot } from './provenance.js'
import { fleetBranchFor } from './ci.js'
import type { Lane, EngineId } from './config.js'
import type { WorkItem } from './source.js'
import type { Outcome } from './ledger.js'

const execFileAsync = promisify(execFile)

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface DispatchRequest {
  name: string
  item: WorkItem
  lane: Lane
  briefPath: string
  timeoutSec: number
  model: string
  effort: EffortLevel
}

export interface DispatchResult {
  outcome: Outcome
  branch?: string
  pr?: string
  note?: string
  worktree?: string
  /** See `RunRecord.quotaResetHint`/`quotaResetAt` (ledger.ts) — set only
   *  when `outcome === 'QUOTA'`. */
  quotaResetHint?: string
  quotaResetAt?: number
}

/**
 * `~/tier-overnight-status/<name>.status`, written by dispatch-one.sh. Not in
 * paths.ts because it is a property of the dispatch dependency's contract
 * (STATUS_DIR, overridable in the shell via `STATUS_DIR=`), not of this
 * fleet's own state — same reasoning that keeps DISPATCH_SCRIPT out of
 * FLEET_DIR.
 */
const STATUS_DIR = join(homedir(), 'tier-overnight-status')

function statusFilePath(name: string): string {
  return join(STATUS_DIR, `${name}.status`)
}

/**
 * dispatch-one.sh writes `key: value\n` lines. Values can themselves contain
 * a colon (e.g. `notes: fixed a: b mapping`), so only the FIRST colon on a
 * line splits key from value — splitting on every colon would truncate any
 * note that mentions a ratio, a URL, or a time. A line with no colon at all
 * (a truncated final write, mid-flush) is skipped rather than throwing: a
 * concurrently-written status file must never crash the poller reading it.
 */
export function parseStatusFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

/**
 * The full status vocabulary `dispatch-one.sh` can produce, audited directly
 * against the script (re-check there if this ever needs revisiting):
 *   - `DISPATCHED` — the initial seed written at launch, before the worker
 *     (or the launcher footer) has written anything of its own. Non-terminal.
 *   - `IN_PROGRESS` — the worker's own first write, per its prompt
 *     instructions ("write status: IN_PROGRESS as one of your first
 *     actions"). Non-terminal.
 *   - `SUCCESS` / `BLOCKED` / `FAILED` / `PARTIAL` / `NEEDS_CONTEXT` — the
 *     worker's own terminal statuses, per its prompt instructions.
 *   - `UNCONFIRMED` — written by the launcher footer (`_launcher_footer`,
 *     around dispatch-one.sh:1063-1072) when the runtime process exits
 *     without the worker ever having written a terminal status itself, but
 *     its last recorded turn looks like a clean, non-error finish. The
 *     footer's own comment calls this "a machine-readable UNCONFIRMED/FAILED
 *     row instead of silence" — it is written ONCE, after the process has
 *     already exited, so nothing can come after it. Terminal: leaving it out
 *     of this set is what let a lane with cap=1 sit idle for a full
 *     `timeoutSec + 30s` behind a worker that had already died, believing it
 *     was still being polled for progress that would never arrive.
 *   - `FAILED` is also written by that same footer when the last turn looks
 *     like an error or there is no result at all — already covered above.
 */
const TERMINAL_STATUSES: ReadonlySet<string> =
  new Set(['SUCCESS', 'BLOCKED', 'FAILED', 'NEEDS_CONTEXT', 'PARTIAL', 'UNCONFIRMED'])

/**
 * Exported as its own pure predicate — rather than left as a private detail
 * of the poll loop below — specifically so the vocabulary itself is directly
 * unit-testable. A gap here (a real terminal status this fleet doesn't
 * recognize as terminal) is invisible to every other test: it only manifests
 * as a poll loop that keeps running for a worker that has already finished,
 * which no unit test in this suite can observe (dispatch()'s I/O is not
 * mocked). Testing this function directly is the only way a regression here
 * gets caught before it costs a lane its full timeout.
 */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

/**
 * NEEDS_CONTEXT and PARTIAL both fold into BLOCKED: both mean a human has to
 * look, and the ledger's breaker logic only distinguishes SUCCESS from
 * everything else that is terminal-but-not-success.
 *
 * A NON-terminal status (IN_PROGRESS, DISPATCHED) — and anything this fleet
 * does not recognize — maps to FAILED, never to SUCCESS. A worker that never
 * wrote a terminal status is a worker that died (crashed, was killed, ran out
 * of budget mid-flight); calling that success is how a fleet reports work it
 * never actually did. Silence must be indistinguishable from failure, never
 * from success.
 *
 * `UNCONFIRMED` gets its own case rather than falling through to `default`
 * even though both produce FAILED: it is a KNOWN bad status (the launcher
 * footer's fallback when a worker's runtime exited without writing one of
 * its own — see the comment on `TERMINAL_STATUSES`), and should read in the
 * code as a recognized, named failure mode, distinct from a genuinely
 * unrecognized string this fleet has never seen before.
 */
export function statusToOutcome(status: string): Outcome {
  switch (status) {
    case 'SUCCESS': return 'SUCCESS'
    case 'FAILED': return 'FAILED'
    case 'BLOCKED': return 'BLOCKED'
    case 'NEEDS_CONTEXT': return 'BLOCKED'
    case 'PARTIAL': return 'BLOCKED'
    case 'UNCONFIRMED': return 'FAILED'
    default: return 'FAILED'
  }
}

export function readStatus(name: string): Record<string, string> | undefined {
  const path = statusFilePath(name)
  if (!existsSync(path)) return undefined
  try {
    return parseStatusFile(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Issue #817: `dispatch-one.sh`'s WORKER_LOG (`$HOME/<name>.log`) — raw
 * stream-json (Claude) or JSONL (opencode/kimi) events, independent of (and
 * more reliable than) the launcher footer's own summary written into the
 * `.status` file's `notes:` field. That footer only knows how to summarise
 * Claude's `{"type":"result",...}` terminal event; a real 2026-09 incident
 * (fleet-android-765) shows it writing an EMPTY final message for an
 * opencode/kimi worker that died on turn one with a bare
 * `{"type":"error",...}` event, because it never recognised that shape at
 * all. Reading the raw log directly is the only way this fleet can classify
 * that worker as anything other than a bare, unexplained `FAILED`.
 *
 * Deliberately NOT routed through `FLEET_HOME` (paths.ts): this is
 * `dispatch-one.sh`'s own file-location contract (like `STATUS_DIR` above),
 * not this fleet's state.
 */
function workerLogPath(name: string): string {
  return join(homedir(), `${name}.log`)
}

export function readWorkerLog(name: string): string | undefined {
  const path = workerLogPath(name)
  if (!existsSync(path)) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export interface WorkerLogSignal {
  /**
   * Prefers Claude's own `num_turns` from its terminal `result` event when
   * present (it is authoritative, including the case where the ONE turn that
   * happened was itself the quota rejection — see the fleet-infra-811
   * fixture). Otherwise counts `assistant` (Claude) and `step_start`/
   * `step_finish` (opencode) events actually observed — for a worker that
   * dies on its first request with a bare `{"type":"error",...}` line (the
   * fleet-android-765 fixture), that count is zero.
   */
  turns: number
  /** The last human-readable message this parse could find, from whichever
   *  shape produced one — empty string if none did. */
  finalMessage: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function extractAssistantText(rec: Record<string, unknown>): string | undefined {
  const message = rec['message']
  if (!isRecord(message)) return undefined
  const content = message['content']
  if (!Array.isArray(content)) return undefined
  const texts = content
    .filter((b): b is Record<string, unknown> => isRecord(b) && b['type'] === 'text')
    .map((b) => (typeof b['text'] === 'string' ? b['text'] : ''))
    .filter((t) => t.length > 0)
  return texts.length > 0 ? texts.join(' ') : undefined
}

/** opencode/kimi's own error shape: `{"type":"error","error":{"name":...,
 *  "data":{"message":"..."}}}` — the fleet-android-765 fixture — plus the
 *  more generic `{"error":{"message":"..."}}` a different provider might use. */
function extractErrorMessage(rec: Record<string, unknown>): string | undefined {
  const err = rec['error']
  if (!isRecord(err)) return undefined
  const data = err['data']
  if (isRecord(data) && typeof data['message'] === 'string' && data['message'].length > 0) {
    return data['message']
  }
  if (typeof err['message'] === 'string' && err['message'].length > 0) return err['message']
  return undefined
}

/**
 * Parses EITHER raw log shape line by line — never throws on a line that
 * fails `JSON.parse` (a truncated final write mid-flush must not crash this,
 * same reasoning as `parseStatusFile`).
 */
export function parseWorkerLogSignal(text: string): WorkerLogSignal {
  let explicitTurns: number | undefined
  let turnEvents = 0
  let finalMessage = ''

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(obj)) continue
    const type = obj['type']

    if (type === 'result') {
      if (typeof obj['num_turns'] === 'number') explicitTurns = obj['num_turns']
      if (typeof obj['result'] === 'string' && obj['result'].length > 0) finalMessage = obj['result']
      continue
    }
    if (type === 'assistant') {
      turnEvents++
      const text2 = extractAssistantText(obj)
      if (text2 !== undefined) finalMessage = text2
      continue
    }
    if (type === 'step_start' || type === 'step_finish') {
      turnEvents++
      continue
    }

    const extracted = extractErrorMessage(obj)
    if (extracted !== undefined) finalMessage = extracted
  }

  return { turns: explicitTurns ?? turnEvents, finalMessage }
}

/**
 * The exact provider-exhaustion phrasing this fleet has actually seen in
 * production (2026-09-18/19, see issue #817): Kimi's 5-hour and weekly
 * (7-day) usage-limit rejections, Claude's own "hit your weekly limit", the
 * generic "usage limit" wording, and a bare `rate_limit` marker some
 * providers surface as the error type/field rather than prose.
 */
export const QUOTA_MESSAGE_RE =
  /5-hour usage limit|weekly \(7-day\) usage limit|hit your weekly limit|usage limit|rate_limit/i

/** Captures the provider's own reset wording verbatim, stopping at the next
 *  sentence boundary — "reset when the current 5-hour window ends" or
 *  "resets 1:20pm (America/New_York)", never the trailing marketing text
 *  that usually follows it in the same message. */
const RESET_HINT_RE = /reset(?:s)?\s+([^.;]+)/i

export function extractResetHint(message: string): string | undefined {
  const hint = RESET_HINT_RE.exec(message)?.[1]?.trim()
  return hint !== undefined && hint.length > 0 ? hint : undefined
}

const CLOCK_HINT_RE = /^(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b(?:\s*\(([^)]+)\))?/i

/** `Intl`-based IANA offset lookup: formats the same instant through the
 *  target timezone and reads back the wall-clock fields, then compares
 *  against the UTC fields of that same instant. Standard technique — Node's
 *  `Intl` ships full ICU data, so every zone name a provider might send
 *  (`America/New_York`, `Europe/Berlin`, ...) resolves without a bundled
 *  tz database of our own. */
function tzOffsetMs(tz: string, atUtcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(atUtcMs))
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0')
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asIfUtc - atUtcMs
}

function wallClockToEpoch(hour: number, minute: number, tz: string | undefined, now: Date): number | undefined {
  if (tz === undefined) {
    const d = new Date(now.getTime())
    d.setHours(hour, minute, 0, 0)
    return d.getTime()
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now)
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '01'
    const naiveUtcMs = Date.parse(
      `${get('year')}-${get('month')}-${get('day')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
    )
    if (!Number.isFinite(naiveUtcMs)) return undefined
    return naiveUtcMs - tzOffsetMs(tz, naiveUtcMs)
  } catch {
    return undefined
  }
}

/**
 * Resolves a reset HINT (already extracted by `extractResetHint`) to an
 * absolute epoch ms, ONLY when it names an actual clock time — "1:20pm
 * (America/New_York)". A relative description with no clock time at all
 * ("when the current 5-hour window ends") returns `undefined` on purpose:
 * inventing a number here would be a guess wearing the clothes of a fact,
 * and `circuit.ts`'s `quotaBreaker` already has a documented 60-minute
 * fallback for exactly this case.
 */
export function parseResetAt(hint: string, now: Date = new Date()): number | undefined {
  const m = CLOCK_HINT_RE.exec(hint.trim())
  if (!m) return undefined
  let hour = Number.parseInt(m[1] ?? '', 10)
  const minute = m[2] !== undefined ? Number.parseInt(m[2], 10) : 0
  const meridiem = (m[3] ?? '').toLowerCase()
  const tz = m[4]
  if (!Number.isFinite(hour) || hour < 1 || hour > 12 || minute < 0 || minute > 59) return undefined
  if (meridiem === 'pm' && hour !== 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0

  const candidate = wallClockToEpoch(hour, minute, tz, now)
  if (candidate === undefined) return undefined
  // A clock time already past "now" today means the provider means tomorrow.
  return candidate > now.getTime() ? candidate : candidate + 24 * 3_600_000
}

export interface QuotaDetection {
  isQuota: boolean
  resetHint?: string
  resetAt?: number
}

/**
 * The two-part test from issue #817: the runtime barely started (turn <= 1)
 * AND the last thing it said is a provider quota rejection, not an ordinary
 * task failure. Both conditions matter — a worker that ran 53 turns and
 * *then* hit its weekly limit mid-task (the real fleet-android-765 SECOND
 * attempt, `turns=53 cost=$1.93`) is legitimately a run that got cut off
 * with real (if unfinished) work behind it, not a worker that never got a
 * chance to try.
 */
export function detectQuotaFromLog(logText: string, now: Date = new Date()): QuotaDetection {
  const { turns, finalMessage } = parseWorkerLogSignal(logText)
  if (turns > 1 || finalMessage.length === 0 || !QUOTA_MESSAGE_RE.test(finalMessage)) {
    return { isQuota: false }
  }
  const resetHint = extractResetHint(finalMessage)
  const resetAt = resetHint !== undefined ? parseResetAt(resetHint, now) : undefined
  return { isQuota: true, resetHint, resetAt }
}

interface BuildArgsInput {
  name: string
  /** The work item's id — with the lane, the only input to the branch name. */
  itemId: string
  briefPath: string
  lane: Lane
  timeoutSec: number
  model: string
  effort: EffortLevel
}

/**
 * The model selectors `dispatch-one.sh`'s `case "$model"` already understands
 * as whole tokens (audited against the script): the Claude CLI names, the
 * opencode shorthands, and the other runtimes' `name[:model]` forms. A model
 * string matching this passes through untouched; anything else under the
 * `opencode` engine is a raw provider/model id that must be wrapped as
 * `opencode:<id>` for the dispatcher to route it to the right runtime.
 */
const DISPATCHER_TOKEN = /^(?:opus|sonnet|haiku|fable|kimi|kimi-thinking|glm|copilot|kimi-cli)(?::.*)?$|^opencode:.+$/

/**
 * dispatch-one.sh maps the bare `kimi`/`kimi-thinking` tokens to exactly this
 * verified-working opencode registry model, so a lane configured with the raw
 * id maps back to the token rather than to `opencode:<id>` — same runtime,
 * same model, but via the dispatcher's maintained selector.
 *
 * This constant is also the fleet's own mirror of what the `kimi` token
 * resolves to — `llamenos-fleet doctor` checks it against `opencode models`
 * (see `doctorRegistryIdForOpencodeModel`), so a stale value here is exactly
 * the latent outage issue #1738 is about: the provider renamed
 * `kimi-for-coding` to `kimi-code-plan-global` and the old id started
 * failing with a generic "server error" that reads like an outage, while a
 * doctor that only checks the binary on PATH reported every lane ok.
 */
const KIMI_DISPATCHER_MODEL = 'kimi-code-plan-global/k3-256k'

/**
 * The retired provider id for the same subscription and model (renamed —
 * issue #1738). A lane file on disk may still carry it, so it keeps mapping
 * to the `kimi` token; removing this branch would silently re-route those
 * lanes to `opencode:kimi-for-coding/k3-256k`, an id that no longer resolves.
 */
const KIMI_DISPATCHER_MODEL_RETIRED = 'kimi-for-coding/k3-256k'

export function resolveDispatchModel(engine: EngineId, model: string): string {
  if (engine !== 'opencode') return model
  if (DISPATCHER_TOKEN.test(model)) return model
  if (model === KIMI_DISPATCHER_MODEL || model === KIMI_DISPATCHER_MODEL_RETIRED) return 'kimi'
  return `opencode:${model}`
}

/**
 * The registry id a live opencode lane's configured model will actually
 * resolve to once dispatch-one.sh has done its mapping — the value
 * `llamenos-fleet doctor` can check against `opencode models` (issue #1738).
 *
 * Returns `undefined` for dispatcher tokens whose target only dispatch-one.sh
 * itself knows (`glm`, `copilot`, `kimi-thinking`, ...): this repo has no
 * mirror of those mappings, and inventing one would be a guess wearing the
 * clothes of a check. The `kimi` token is the one exception — its mapping IS
 * mirrored here (`KIMI_DISPATCHER_MODEL` exists precisely to document what
 * dispatch-one.sh maps it to), so a kimi lane whose underlying id has been
 * renamed out from under the fleet is caught instead of reported ok.
 */
export function doctorRegistryIdForOpencodeModel(model: string): string | undefined {
  const resolved = resolveDispatchModel('opencode', model)
  if (resolved.startsWith('opencode:')) return resolved.slice('opencode:'.length)
  if (resolved === 'kimi') return KIMI_DISPATCHER_MODEL
  return undefined
}

/**
 * The pure core of doctor's model-resolution check (issue #1738): `rawId` is
 * a registry id a live opencode lane will be dispatched with, `available` is
 * `opencode models` output (one id per line, already split). Returns
 * `undefined` when the id resolves; otherwise a failure message that names
 * the dead id, says plainly that it is a MISCONFIGURATION (not an outage —
 * the renamed `kimi-for-coding` id failed as a generic "server error" and
 * cost the fleet real downtime being debugged as one), and lists a readable
 * subset of the ids that DO resolve — same-provider ids first, falling back
 * to a name-substring match, capped so a 100+ model registry doesn't drown
 * the one line that matters.
 */
export function modelResolutionProblem(rawId: string, available: string[]): string | undefined {
  if (available.includes(rawId)) return undefined
  const provider = rawId.split('/')[0] ?? ''
  const modelName = rawId.slice(rawId.indexOf('/') + 1)
  let suggestions = provider !== '' ? available.filter((m) => m.startsWith(`${provider}/`)) : []
  if (suggestions.length === 0 && modelName !== '') {
    suggestions = available.filter((m) => m.includes(modelName))
  }
  const shown = suggestions.slice(0, 10)
  const available_ = shown.length > 0 ? ` Available ids include: ${shown.join(', ')}` : ''
  return (
    `model "${rawId}" does not resolve — this is a misconfiguration, not an outage.` +
    `${available_} Fix the lane's model in ~/.llamenos-fleet/lanes.json (or drop the override to use the default).`
  )
}

/**
 * `--owns` is the ONLY thing standing between two concurrent workers and the
 * same file — it is rendered into the worker's prompt as the FILE OWNERSHIP
 * block that the scope checker later verifies the diff against. A lane with
 * an empty owned list has nothing to render, which is not "wide permissions",
 * it is "no permission check at all": the worker would receive no ownership
 * block and could write anywhere. Refusing to build args at all (rather than
 * passing `--owns ''` or omitting the flag) makes that failure loud instead
 * of quietly unscoped — the same reasoning `assertLiveLanesHaveScope` applies
 * at lane-load time, repeated here because a lane could in principle reach
 * this call with a scope that changed (or failed to load) since.
 */
export function buildArgs(req: BuildArgsInput): string[] {
  if (req.lane.scope.owned.length === 0) {
    throw new Error(
      `refusing to dispatch lane "${req.lane.id}" with an empty owned scope — ` +
      '--owns is the only thing standing between two workers and the same file',
    )
  }
  // `--branch` on EVERY dispatch: without it dispatch-one.sh cuts the
  // worktree on the worker NAME (`fleet-<lane>-<item>`), which is a tmux
  // session name, not the `fleet/<lane>/<item>` grammar everything
  // downstream derives lane, item and worktree from (issue #812).
  const args = [
    '--branch', fleetBranchFor(req.lane.id, req.itemId),
    '--agent', `${req.lane.id}-supervisor`,
    '--owns', req.lane.scope.owned.join(','),
  ]
  // Only the Claude CLI accepts --effort; dispatch-one.sh warns and ignores it
  // for every other runtime. Omit it outright for opencode lanes instead of
  // paying a spurious warning on every dispatch.
  if (req.lane.engine !== 'opencode') {
    args.push('--effort', req.effort)
  }
  args.push(
    '--rules', 'llamenos',
    req.name,
    req.briefPath,
    String(req.timeoutSec),
    resolveDispatchModel(req.lane.engine, req.model),
  )
  return args
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const POLL_INTERVAL_MS = 5_000
/** Grace beyond the worker's own timeout for dispatch-one.sh's launcher to
 *  notice the timeout, write a terminal status, and flush it to disk. */
const POLL_GRACE_MS = 30_000

export interface LaunchOutcomeInput {
  /**
   * Set when the initial `execFileAsync(DISPATCH_SCRIPT, ...)` call in
   * `dispatch()` itself threw or timed out. NEVER trusted as authoritative
   * on its own — see the long comment on `dispatch()` for why: dispatch-one.sh
   * starts the worker in a DETACHED tmux session and does only a little more
   * setup before this call returns, and under concurrent dispatches
   * contending for one box's CPU/disk that setup can outrun even this call's
   * own 60s timeout while the session it already started keeps running to
   * completion entirely independently of this process.
   *
   * Issue #870, live: `fleet-backend-705` and `fleet-desktop-775` were
   * dispatched within 3 seconds of each other and of `fleet-infra-722` (same
   * tick, three lanes at once) and both this call's own error text
   * (`"Command failed: …/dispatch-one.sh --branch fleet/backend/705 …"`) and
   * their worker's own `.status` file (`status: SUCCESS`, a real PR) exist
   * for the exact same run — the launch call, not the worker, was what timed
   * out.
   */
  launchError?: string
  /** The LAST status-file snapshot the poll loop in `dispatch()` observed,
   *  whatever it was — `undefined` only if a status file never appeared at
   *  all in the whole poll window. */
  status: Record<string, string> | undefined
  /** The launcher's DISPATCHED seed — see `dispatch()`'s own comment on why
   *  `branch`/`worktree` are read from here as a fallback. */
  seed: Record<string, string> | undefined
  depCommit: string | undefined
  /** The fleet runtime checkout's own HEAD commit (issue #1801) — without
   *  it a worker's behaviour cannot be attributed to a runtime revision
   *  after the fact, which is exactly the forensics the drift incident
   *  needed and lacked. Cheap to read (no fetch — this records what RAN,
   *  not what origin/main now holds; drift detection is doctor/tick's job). */
  rtCommit: string | undefined
  /** The worker's raw log text, if one exists — passed in rather than read
   *  here so this function stays a pure decision, not a file read. */
  workerLog: string | undefined
}

/**
 * The pure decision `dispatch()` (below) delegates to once it has finished
 * polling: what outcome, note, branch/worktree/pr, and (on a FAILED reclassified
 * to QUOTA) reset hint to report. Extracted specifically so issue #870's fix —
 * a `launchError` must NEVER by itself downgrade a real terminal status the
 * worker already wrote — is testable against the real fixture text of that
 * incident without spinning up a real `dispatch-one.sh`, tmux, or a 90-minute
 * poll loop.
 *
 * `launchError` is recorded in the note, for a human's benefit, but never
 * changes `outcome`: the status file (or its absence) is the only thing that
 * does. A launch call that failed AND left no status file still resolves to
 * FAILED exactly as it always did (`rawStatus` falls back to `'DISPATCHED'`,
 * which `statusToOutcome` maps to `FAILED`) — this function changes nothing
 * about that path, it only stops the launch error from overriding a real
 * terminal status when one exists.
 */
export function resolveLaunchOutcome(input: LaunchOutcomeInput): DispatchResult {
  const rawStatus = input.status?.['status'] ?? 'DISPATCHED' // never observed a status file: treat as never-started
  let outcome = statusToOutcome(rawStatus)

  // Record the dependency's HEAD commit AND the fleet runtime's own HEAD
  // commit in the note, so a run's behaviour can always be traced back to
  // the exact revisions of dispatch-one.sh and of the orchestrator that
  // produced it — the version pin this repo cannot otherwise express for a
  // dependency it does not vendor (see dependency.ts), and the forensics
  // issue #1801's drift incident needed and lacked.
  const workerNote = input.status?.['notes']
  let note = `dep:${input.depCommit ?? 'unknown'} rt:${input.rtCommit ?? 'unknown'}${workerNote ? ` ${workerNote}` : ''}`

  if (input.launchError !== undefined) {
    // Issue #870: logged for a human, NEVER used to override `outcome` — see
    // this function's own doc comment and `LaunchOutcomeInput.launchError`'s.
    note = `launch-call warning (worker may be running independently of this call): ${input.launchError} | ${note}`
  }

  // Issue #817: `dispatch-one.sh` has no quota-detection of its own, so a
  // real provider rate limit always shows up here as a plain FAILED — worse,
  // for an opencode/kimi worker (see `readWorkerLog`'s comment) the launcher
  // footer's own summary can be an EMPTY final message, discarding the one
  // piece of evidence a human would need to tell "the fleet is broken" from
  // "the account ran out of quota" apart. Read the worker's raw log directly
  // and reclassify — only ever FAILED -> QUOTA, never any other outcome: a
  // worker that reported BLOCKED or SUCCESS made a deliberate claim this
  // fleet must not silently override on a coincidental log match.
  let quotaResetHint: string | undefined
  let quotaResetAt: number | undefined
  if (outcome === 'FAILED' && input.workerLog !== undefined) {
    const detection = detectQuotaFromLog(input.workerLog)
    if (detection.isQuota) {
      outcome = 'QUOTA'
      quotaResetHint = detection.resetHint
      quotaResetAt = detection.resetAt
      note = `${note} | quota reset: ${quotaResetHint ?? 'unknown'}`
    }
  }

  const pr = input.status?.['pr']
  return {
    outcome,
    branch: input.status?.['branch'] ?? input.seed?.['branch'],
    pr: pr !== undefined && pr !== 'none' ? pr : undefined,
    note,
    worktree: input.status?.['worktree'] ?? input.seed?.['worktree'],
    quotaResetHint,
    quotaResetAt,
  }
}

/**
 * Spawns the worker via `dispatch-one.sh` and waits for it to reach a
 * terminal status.
 *
 * Spawned by argv via `execFile`, never through a shell: `req.name` and
 * `req.briefPath` both ultimately derive from worker-authored GitHub content
 * (an issue title, a branch name) by the time later tasks build them, and a
 * `bash -c` string assembled from that content is exactly how the reference
 * system's dispatcher could be made to execute arbitrary commands with every
 * credential the orchestrator process holds — e.g. a committed file named
 * `$(...)`.
 *
 * Deliberately does NOT tear down the worktree or stop the tmux session on
 * return, terminal outcome or not. A later review loop sends the reviewer's
 * verdict back to this SAME session with its worktree intact so the worker
 * can revise; if dispatch tore things down here, that loop would be
 * impossible and the fleet would silently degrade to one-shot dispatch — the
 * exact limitation this system exists to remove. Teardown is `tick`'s job,
 * once, after the review loop for an item has actually ended.
 */
export async function dispatch(req: DispatchRequest): Promise<DispatchResult> {
  const args = buildArgs({
    name: req.name, itemId: req.item.id, briefPath: req.briefPath, lane: req.lane,
    timeoutSec: req.timeoutSec, model: req.model, effort: req.effort,
  })

  // dispatch-one.sh itself returns almost immediately — it starts the worker
  // in a DETACHED tmux session (`tmux new-session -d`) and does not wait for
  // it. This execFile call is therefore bounded by a short timeout of its
  // own; the long wait below is for the worker's actual progress, tracked
  // through the status file, not through this child process.
  //
  // Issue #870: this call's OWN error — a timeout or a non-zero exit — is
  // caught here rather than left to propagate. The detached tmux session
  // `dispatch-one.sh` starts (or fails to start) is unaffected by whether
  // THIS wrapper call finishes inside its own 60s allowance, and under
  // concurrent dispatches (three lanes launched within milliseconds of each
  // other, all contending for the same box) it provably did not: two of
  // three workers dispatched at once in the live incident finished with a
  // real terminal SUCCESS and a real PR while this call's own promise had
  // already rejected. Rethrowing here turned "the fleet's own supervising
  // call was slow" into "record this successful worker as a hard FAILED" —
  // the poll loop immediately below is the exact same ground-truth check a
  // launch that genuinely never started already has to survive (no status
  // file ever appears -> `'DISPATCHED'` -> FAILED, via `resolveLaunchOutcome`,
  // unchanged), so there is nothing this catch needs to do beyond not
  // rethrowing.
  let launchError: string | undefined
  try {
    await execFileAsync(DISPATCH_SCRIPT, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  } catch (e) {
    launchError = e instanceof Error ? e.message : String(e)
  }

  // The launcher's DISPATCHED seed is the one status write that carries
  // `branch` and `worktree` — the worker's own terminal write never does
  // (issue #660). Read it NOW, before the worker overwrites it, so the
  // worktree dispatch-one.sh actually cut is known without reconstructing
  // its path convention. Best-effort: if the worker already overwrote it,
  // cli.ts's `resolveDispatchResult` falls back to asking git.
  const seed = readStatus(req.name)

  const deadline = Date.now() + req.timeoutSec * 1000 + POLL_GRACE_MS
  let status = readStatus(req.name)
  while (Date.now() < deadline) {
    status = readStatus(req.name)
    const raw = status?.['status']
    if (raw !== undefined && isTerminalStatus(raw)) break
    await sleep(POLL_INTERVAL_MS)
  }

  const dep = checkDispatchDependency()
  return resolveLaunchOutcome({
    launchError,
    status,
    seed,
    depCommit: dep.commit,
    rtCommit: gitFactsFor(fleetRuntimeRoot()).commit,
    workerLog: readWorkerLog(req.name),
  })
}
