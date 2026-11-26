import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gh, ghJson } from './gh.js'
import { DIGEST_ISSUE_FILE, FLEET_DIR, LAST_DIGEST_AT_FILE } from './paths.js'
import type { WorkSink } from './sink.js'
import type { RunRecord } from './ledger.js'
import {
  AGENT_PROPOSED_LABEL, DISPATCH_LABEL, HOLD_LABELS, NEEDS_HUMAN_LABEL, isContradicted,
} from './hold-labels.js'

/**
 * Issue #838: "the 18:00 digest ran on schedule and printed to the systemd
 * journal only. The operator learned nothing from it." §5.9's notification
 * channel (webhook/command via `notify.ts`) is the operator's own client and
 * is opt-in/best-effort by design; this module is the DETERMINISTIC,
 * always-visible channel — a GitHub issue every digest/halt/resume posts to,
 * whether or not the operator ever configured a webhook.
 */

export const DIGEST_ISSUE_TITLE = 'Fleet digest'

const DIGEST_ISSUE_BODY =
  'Automated home for this fleet\'s twice-daily digest and blocked/resume pings ' +
  '(issue #838). Created once and pinned — do not close; the fleet will re-create ' +
  'a fresh one if this is closed, which orphans the running history. ' +
  'See docs/superpowers/specs/2026-09-11-llamenos-fleet-orchestrator-design.md §5.9.'

// ---------------------------------------------------------------------------
// Idempotent digest posting — one NEW comment per pass, except a genuine
// re-run of the SAME pass, which edits instead of duplicating.
// ---------------------------------------------------------------------------

const DIGEST_MARKER = 'llamenos-fleet-digest'
const RUN_ID_RE = new RegExp(`<!-- ${DIGEST_MARKER} run=(\\S+) -->`)

/**
 * Pure: derives a per-pass id from a timestamp so a retried invocation
 * within the SAME digest window (the twice-daily 07:00/18:00 cadence from
 * §5.9 — bucketed here as before/after UTC noon on a given date, since the
 * exact schedule is a systemd timer detail this module does not read) edits
 * its own comment rather than piling up a duplicate. A pass in a different
 * window — the next scheduled digest, or a human running `digest` by hand
 * hours later — is a different id and gets its own new comment.
 */
export function digestRunId(now: number): string {
  const d = new Date(now)
  const date = d.toISOString().slice(0, 10)
  return `${date}-${d.getUTCHours() < 12 ? 'am' : 'pm'}`
}

function digestCommentHeader(runId: string): string {
  return `<!-- ${DIGEST_MARKER} run=${runId} -->`
}

/** `undefined` for any comment this module did not itself write — a human
 *  reply or a BLOCKED/RESUMED ping never carries this header and so is never
 *  a candidate for `planDigestPost` to edit. */
export function extractDigestRunId(body: string): string | undefined {
  return RUN_ID_RE.exec(body)?.[1]
}

export type DigestPostPlan = { action: 'create' } | { action: 'edit'; commentId: string }

/**
 * Pure decision, split out from `postDigestComment` so the one property that
 * matters ("only a matching run id edits; anything else creates") is
 * unit-testable without a fake sink recording calls. `comments` is exactly
 * `WorkSink.listComments`'s own return shape (oldest first). Only the most
 * RECENT digest comment is ever a candidate — an id match on an older one
 * must never resurrect it, and a non-digest comment (BLOCKED/RESUMED, or a
 * human reply) posted after the last digest comment must never be mistaken
 * for the thing to edit.
 */
export function planDigestPost(comments: { id: string; body: string }[], runId: string): DigestPostPlan {
  const digestComments = comments.filter((c) => extractDigestRunId(c.body) !== undefined)
  const last = digestComments[digestComments.length - 1]
  return last !== undefined && extractDigestRunId(last.body) === runId
    ? { action: 'edit', commentId: last.id }
    : { action: 'create' }
}

/** The one write path a digest pass uses. `issueId` is whatever
 *  `ensureDigestIssue` resolved; `runId` is normally `digestRunId(Date.now())`
 *  but is a parameter so a caller-supplied clock is fully deterministic in
 *  tests. */
export async function postDigestComment(sink: WorkSink, issueId: string, runId: string, body: string): Promise<void> {
  const fullBody = `${digestCommentHeader(runId)}\n${body}`
  const comments = await sink.listComments(issueId)
  const plan = planDigestPost(comments, runId)
  if (plan.action === 'edit') {
    await sink.editComment(plan.commentId, fullBody)
  } else {
    await sink.comment(issueId, fullBody)
  }
}

// ---------------------------------------------------------------------------
// Blocked / resumed pings — always a NEW comment (each halt is its own
// event worth its own line in the issue's history), never edited.
// ---------------------------------------------------------------------------

export async function postBlockedPing(sink: WorkSink, issueId: string, reason: string, resumeCmd: string): Promise<void> {
  await sink.comment(issueId, [`BLOCKED: ${reason}`, '', 'Resume with:', `\`${resumeCmd}\``].join('\n'))
}

export async function postResumedPing(sink: WorkSink, issueId: string): Promise<void> {
  await sink.comment(issueId, 'RESUMED: the fleet has resumed dispatching.')
}

// ---------------------------------------------------------------------------
// Resolving (and, once, creating + pinning) the dedicated digest issue.
// ---------------------------------------------------------------------------

export interface DigestIssueDeps {
  readCache(): string | undefined
  writeCache(id: string): void
  findOpenIssueByTitle(title: string): Promise<string | undefined>
  createIssue(title: string, body: string): Promise<string>
  pinIssue(id: string): Promise<void>
  isOpen(id: string): Promise<boolean | undefined>
}

/**
 * DI core, mirroring this codebase's established shape (`StatusItemDeps`,
 * `RevertDeps`, ...) so the resolve/create/pin decision is testable without
 * a real `gh`. Cache-hit is the fast, common path (every pass after the
 * first); a cached id that no longer resolves to an OPEN issue (closed by
 * hand, or the state file predates this box's current `$HOME`) falls back to
 * a live search by title, and only creates a new issue if that also comes up
 * empty — never two issues for one fleet.
 */
export async function ensureDigestIssueWith(deps: DigestIssueDeps): Promise<string> {
  const cached = deps.readCache()
  if (cached !== undefined) {
    const open = await deps.isOpen(cached)
    if (open === true) return cached
  }
  const found = await deps.findOpenIssueByTitle(DIGEST_ISSUE_TITLE)
  if (found !== undefined) {
    deps.writeCache(found)
    return found
  }
  const created = await deps.createIssue(DIGEST_ISSUE_TITLE, DIGEST_ISSUE_BODY)
  await deps.pinIssue(created)
  deps.writeCache(created)
  return created
}

function readDigestIssueCache(): string | undefined {
  if (!existsSync(DIGEST_ISSUE_FILE)) return undefined
  const v = readFileSync(DIGEST_ISSUE_FILE, 'utf8').trim()
  return v.length > 0 ? v : undefined
}

function writeDigestIssueCache(id: string): void {
  mkdirSync(FLEET_DIR, { recursive: true })
  writeFileSync(DIGEST_ISSUE_FILE, id)
}

async function findOpenDigestIssueByTitle(title: string): Promise<string | undefined> {
  const found = await ghJson<{ number: number; title: string }[]>([
    'issue', 'list', '--state', 'open', '--search', `"${title}" in:title`, '--json', 'number,title',
  ])
  const exact = found?.find((i) => i.title === title)
  return exact !== undefined ? String(exact.number) : undefined
}

/** `gh issue create` prints the new issue's URL to stdout — the number is
 *  its own trailing path segment. Throws (rather than returning `undefined`)
 *  on anything unexpected: unlike a read, a caller that thinks it created an
 *  issue but has no number for it cannot proceed safely at all. */
async function createDigestIssue(title: string, body: string): Promise<string> {
  const out = (await gh(['issue', 'create', '--title', title, '--body', body])).trim()
  const match = /\/issues\/(\d+)$/.exec(out)
  if (match === null) throw new Error(`could not parse an issue number from "gh issue create" output: ${out}`)
  return match[1]
}

async function pinDigestIssue(id: string): Promise<void> {
  await gh(['issue', 'pin', id])
}

async function digestIssueIsOpen(id: string): Promise<boolean | undefined> {
  const view = await ghJson<{ state: string }>(['issue', 'view', id, '--json', 'state'])
  return view === undefined ? undefined : view.state === 'OPEN'
}

export function defaultDigestIssueDeps(): DigestIssueDeps {
  return {
    readCache: readDigestIssueCache,
    writeCache: writeDigestIssueCache,
    findOpenIssueByTitle: findOpenDigestIssueByTitle,
    createIssue: createDigestIssue,
    pinIssue: pinDigestIssue,
    isOpen: digestIssueIsOpen,
  }
}

/**
 * Best-effort by construction, matching `notify.ts`'s own contract: GitHub
 * being unreachable must never fail (or throw out of) a `digest`/`halt`/
 * `resume` invocation. Returns `undefined` — never a rejection — on ANY
 * failure to resolve or create the issue; callers already treat `undefined`
 * as "skip the GitHub post this pass."
 */
export async function ensureDigestIssue(): Promise<string | undefined> {
  try {
    return await ensureDigestIssueWith(defaultDigestIssueDeps())
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// "Fleet PRs opened since the last digest", with check state derived live —
// never from a label, per the acceptance criteria (a label is a cache, and a
// stale one is exactly the failure mode #660 already cost this fleet once).
// ---------------------------------------------------------------------------

export function readLastDigestAt(): number | undefined {
  if (!existsSync(LAST_DIGEST_AT_FILE)) return undefined
  const n = Number.parseInt(readFileSync(LAST_DIGEST_AT_FILE, 'utf8').trim(), 10)
  return Number.isFinite(n) ? n : undefined
}

export function writeLastDigestAt(now: number): void {
  mkdirSync(FLEET_DIR, { recursive: true })
  writeFileSync(LAST_DIGEST_AT_FILE, String(now))
}

export interface FleetPr {
  pr: string
  itemId: string
  itemName: string
}

/** Pure: the ledger's own `pr` field, deduped to the most recent row per PR
 *  number (an item can accumulate several ledger rows against the same PR —
 *  retries, a later BLOCKED after an earlier SUCCESS — this is one PR, not
 *  several), newest first. */
export function fleetPrsFromRuns(rows: RunRecord[]): FleetPr[] {
  const latestByPr = new Map<string, RunRecord>()
  for (const r of rows) {
    if (r.pr === undefined) continue
    const prev = latestByPr.get(r.pr)
    if (prev === undefined || r.ts > prev.ts) latestByPr.set(r.pr, r)
  }
  return [...latestByPr.values()]
    .sort((a, b) => b.ts - a.ts)
    .map((r) => ({ pr: r.pr as string, itemId: r.itemId, itemName: r.itemName }))
}

export type PrCheckState = 'passing' | 'failing' | 'pending' | 'unknown'

export interface PrCheck { status: string; conclusion: string }

const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'])

/** Pure. `FAILURE`/`CANCELLED`/`TIMED_OUT`/`ACTION_REQUIRED` on ANY check
 *  wins outright — a red check reported alongside nine green ones is still a
 *  red PR. Otherwise any check not yet `COMPLETED` makes the whole rollup
 *  `pending`. An empty check list (a PR with no CI configured, or a live read
 *  that came back empty) is `unknown`, not `passing` — silence is not the
 *  same fact as green. */
export function aggregatePrCheckState(checks: PrCheck[]): PrCheckState {
  if (checks.some((c) => FAILING_CONCLUSIONS.has(c.conclusion))) return 'failing'
  if (checks.some((c) => c.status !== 'COMPLETED')) return 'pending'
  if (checks.length === 0) return 'unknown'
  return 'passing'
}

export interface FleetPrWithState extends FleetPr {
  state: PrCheckState | undefined
}

async function defaultFetchPrChecks(pr: string): Promise<PrCheck[] | undefined> {
  const view = await ghJson<{ statusCheckRollup: PrCheck[] }>(['pr', 'view', pr, '--json', 'statusCheckRollup'])
  return view?.statusCheckRollup
}

/** `state: undefined` — never a guessed default — when the live read itself
 *  failed, so rendering can say "could not read" instead of silently
 *  reporting an unknown PR as green. */
export async function resolveFleetPrStates(
  prs: FleetPr[],
  fetchChecks: (pr: string) => Promise<PrCheck[] | undefined> = defaultFetchPrChecks,
): Promise<FleetPrWithState[]> {
  return Promise.all(prs.map(async (p): Promise<FleetPrWithState> => {
    const checks = await fetchChecks(p.pr)
    return { ...p, state: checks !== undefined ? aggregatePrCheckState(checks) : undefined }
  }))
}

export function renderFleetPrsSection(prs: FleetPrWithState[]): string {
  const lines = prs.length > 0
    ? prs.map((p) => `- #${p.pr} ${p.itemName} (${p.itemId}) — checks: ${p.state ?? 'unknown (live read failed)'}`)
    : ['  (none)']
  return ['## Fleet PRs since last digest', ...lines].join('\n')
}

// ---------------------------------------------------------------------------
// Human queue — every open issue carrying a needs-* label, live, not just
// the subset the fleet itself parked (issue #774 gives this section its
// fuller, permanent home inside renderDigest/WorkSource; this is the
// GitHub-post-only version that ships with #838 so the very first comment
// this fleet ever posts is not missing the queue the whole issue is about).
// ---------------------------------------------------------------------------

/** The hold labels that wait on a PERSON — every veto in hold-labels.ts
 *  except `blocked`, which waits on other work, not on anyone. #1815 added
 *  `agent-proposed`: a proposal waiting on a yes or no is the queue item a
 *  human can clear fastest, and it used to hide inside `needs-human`. */
export const HUMAN_QUEUE_LABELS = [AGENT_PROPOSED_LABEL, NEEDS_HUMAN_LABEL, 'needs-decision', 'needs-info'] as const

const HUMAN_QUEUE_FETCH_LIMIT = 100
const HUMAN_QUEUE_DISPLAY_LIMIT = 20
const DAY_MS = 24 * 60 * 60_000

export interface HumanQueueIssue {
  number: number
  title: string
  labels: string[]
  /** ISO timestamp. #1815: the signal that matters is AGE — eleven M1
   *  issues sat vetoed for six weeks because nothing said how long. */
  createdAt: string
}

/** Comma-separated inside a single `--search label:...` clause is GitHub
 *  search's OR — verified against the live repo while building this (30+
 *  results for `label:needs-human,needs-decision,needs-info`, vs. zero for
 *  the same three labels passed to `--label`, which is AND/REST semantics
 *  and requires every listed label at once). */
export async function defaultFetchHumanQueue(): Promise<HumanQueueIssue[] | undefined> {
  const raw = await ghJson<{ number: number; title: string; labels: { name: string }[]; createdAt: string }[]>([
    'issue', 'list', '--state', 'open',
    '--search', `label:${HUMAN_QUEUE_LABELS.join(',')}`,
    '--json', 'number,title,labels,createdAt',
    '--limit', String(HUMAN_QUEUE_FETCH_LIMIT),
  ])
  return raw?.map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((l) => l.name), createdAt: i.createdAt }))
}

function ageDays(createdAt: string, now: number): number | undefined {
  const t = Date.parse(createdAt)
  return Number.isNaN(t) ? undefined : Math.max(0, Math.floor((now - t) / DAY_MS))
}

function renderQueueLine(i: HumanQueueIssue, now: number): string {
  const tags = i.labels.filter((l) => (HUMAN_QUEUE_LABELS as readonly string[]).includes(l))
  const age = ageDays(i.createdAt, now)
  const contradiction = isContradicted(i.labels)
    ? ` — also \`${DISPATCH_LABEL}\`: reads as claimable, but the hold wins and no lane will take it`
    : ''
  return `- #${i.number} [${tags.join(',')}] ${i.title} (${age === undefined ? 'age unknown' : `${age}d old`})${contradiction}`
}

/**
 * Pure. Two groups, because they ask different things (#1815): proposals
 * want a yes or no, everything else wants an act. Oldest first inside each
 * group, since an item parked for weeks is the finding. Capped at
 * `HUMAN_QUEUE_DISPLAY_LIMIT` lines overall with a trailing `… and N more`
 * — a digest comment that is mostly one long list is the same "stop reading
 * before the last line" failure `computeBanner`'s own module comment
 * (digest.ts) describes.
 */
export function renderHumanQueueSection(issues: HumanQueueIssue[], now: number = Date.now()): string {
  if (issues.length === 0) return ['## Human queue', '  (none)'].join('\n')
  const oldestFirst = (a: HumanQueueIssue, b: HumanQueueIssue): number =>
    (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || a.number - b.number
  const proposals = issues.filter((i) => i.labels.includes(AGENT_PROPOSED_LABEL)).sort(oldestFirst)
  const acts = issues.filter((i) => !i.labels.includes(AGENT_PROPOSED_LABEL)).sort(oldestFirst)
  const proposalAsk = HOLD_LABELS.find((h) => h.name === AGENT_PROPOSED_LABEL)?.asks ?? ''
  const groups: { heading: string; items: HumanQueueIssue[] }[] = [
    { heading: `### Proposals waiting on a yes or no (\`${AGENT_PROPOSED_LABEL}\`) — ${proposalAsk}`, items: proposals },
    { heading: '### Waiting on a person to act (`needs-*`) — each issue says which act', items: acts },
  ]
  const out = ['## Human queue']
  let shown = 0
  for (const g of groups) {
    if (g.items.length === 0) continue
    const room = Math.max(0, HUMAN_QUEUE_DISPLAY_LIMIT - shown)
    if (room === 0) break
    out.push(g.heading, ...g.items.slice(0, room).map((i) => renderQueueLine(i, now)))
    shown += Math.min(room, g.items.length)
  }
  const rest = issues.length - shown
  if (rest > 0) out.push(`… and ${rest} more`)
  return out.join('\n')
}
