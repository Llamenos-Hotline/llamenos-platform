import { LANE_IDS } from '../config.js'
import type { WorkItem } from '../source.js'
import type { RunRecord } from '../ledger.js'
import type { EffortLevel } from '../engines.js'

/**
 * The capability the reference system (atlas-orchestrator, in the
 * `translatemd` repo) lacks entirely: there, every task must be hand-written
 * by a human, and an oversized one simply fails three times (see
 * `MAX_ATTEMPTS_PER_ITEM` in config.ts, `failedAttemptsIn` in ledger.ts) and
 * is set aside with nobody any wiser. The Planner reads the goal document,
 * the open backlog, and recent run outcomes, and proposes new work — but it
 * PROPOSES ONLY. See the module-level boundary comment above `proposeIssues`.
 */
export type LaneId = (typeof LANE_IDS)[number]

export interface ProposedIssue {
  title: string
  body: string
  lane: LaneId
  effort: EffortLevel
  dependsOn?: string[]
}

export interface PlannerInput {
  /** The GA/IA gate document (or whatever goal document governs this pass),
   *  read by the caller — the Planner itself performs no file I/O. */
  goalDocument: string
  /** The currently open backlog, read fresh by the caller via the same
   *  `WorkSource` every lane selects from (source.ts) — never re-fetched
   *  in here. Used only for the near-duplicate check below. */
  openBacklog: WorkItem[]
  /** Recent run outcomes from the ledger, so the Planner can see what has
   *  already failed repeatedly and propose around it rather than repeating
   *  the same oversized task a fourth time. */
  recentRuns: RunRecord[]
  /**
   * The ONLY effectful capability this function is given: a callback that
   * turns a prompt into raw model output. Injected, not looked up — the
   * caller decides which engine, which model, which effort level ("the
   * most capable model at high effort" per the design spec is a DISPATCH
   * decision, made by whatever calls `proposeIssues`, not by this file).
   * This is also what makes the "no mutation" boundary testable in the
   * first place: a test can hand in an `invoke` that returns canned JSON
   * and then assert, independently, that nothing else in this module ever
   * touched the filesystem or the network.
   */
  invoke: (prompt: string) => Promise<string>
}

/**
 * A human must remove this label before an item enters the backlog any
 * lane can select from — every lane's `requireLabel` in config.ts LANES is
 * `agent-dispatchable`, a label this module never applies, so a proposed
 * issue is inert to every dispatch lane on creation regardless of what
 * else it carries. `needs-human` on top of that is belt-and-suspenders:
 * the label a human affirmatively removes to admit the work, not merely
 * the absence of one they'd have to add.
 */
export const NEEDS_HUMAN_LABEL = 'needs-human'
export const LANE_LABEL_PREFIX = 'lane:'
export const EFFORT_LABEL_PREFIX = 'effort:'

function buildPrompt(input: Omit<PlannerInput, 'invoke'>): string {
  const backlogLines = input.openBacklog
    .map((i) => `- #${i.id} ${i.title}`)
    .join('\n') || '(backlog is empty)'
  const outcomeLines = input.recentRuns
    .slice(-50)
    .map((r) => `- ${r.lane} #${r.itemId} ${r.outcome}${r.note ? ` — ${r.note}` : ''}`)
    .join('\n') || '(no recent runs)'
  return [
    'You are the Planner for the Llámenos fleet. Propose new work items.',
    '',
    'You may ONLY propose issues — you have no ability to create them, merge',
    'anything, or write any file. Return a JSON array of objects shaped',
    'exactly as { "title": string, "body": string, "lane": one of ' +
      JSON.stringify(LANE_IDS) + ', "effort": one of ' +
      '["low","medium","high","xhigh","max"], "dependsOn"?: string[] }.',
    'Return ONLY the JSON array, nothing else.',
    '',
    '## Goal document',
    input.goalDocument,
    '',
    '## Open backlog',
    backlogLines,
    '',
    '## Recent run outcomes',
    outcomeLines,
  ].join('\n')
}

/**
 * Extracts the first JSON array literal from arbitrary model output — a
 * model asked to "return only JSON" not infrequently wraps it in a
 * markdown fence or a sentence anyway. Returns `undefined` rather than
 * throwing on anything that doesn't parse as an array of objects: an
 * unparseable response means "propose nothing this pass," never a crash
 * that takes the caller down with it.
 */
export function parseProposals(raw: string): unknown[] | undefined {
  const match = /\[[\s\S]*]/.exec(raw)
  if (!match) return undefined
  try {
    const parsed: unknown = JSON.parse(match[0])
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const LANE_ID_SET: ReadonlySet<string> = new Set(LANE_IDS)
const EFFORT_SET: ReadonlySet<string> = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max'])

/** Validates one parsed object into a `ProposedIssue`, or `undefined` if it
 *  is missing a required field or carries a lane/effort this fleet does not
 *  recognize. Malformed entries are dropped individually rather than
 *  failing the whole batch — one bad object from the model must not throw
 *  away every other, valid proposal alongside it. */
export function toProposedIssue(raw: unknown): ProposedIssue | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const { title, body, lane, effort, dependsOn } = o
  if (typeof title !== 'string' || title.trim().length === 0) return undefined
  if (typeof body !== 'string') return undefined
  if (typeof lane !== 'string' || !LANE_ID_SET.has(lane)) return undefined
  if (typeof effort !== 'string' || !EFFORT_SET.has(effort)) return undefined
  let deps: string[] | undefined
  if (dependsOn !== undefined) {
    if (!Array.isArray(dependsOn) || !dependsOn.every((d) => typeof d === 'string')) return undefined
    deps = dependsOn
  }
  return { title, body, lane: lane as LaneId, effort: effort as EffortLevel, ...(deps ? { dependsOn: deps } : {}) }
}

/** Lowercases, strips punctuation, and collapses whitespace so titles that
 *  differ only in casing or a trailing period compare equal. */
function normalizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
}

/**
 * Jaccard similarity over normalized title word-sets. "Near-duplicate" is
 * defined here as >= 0.6 overlap: high enough that two titles describing
 * genuinely different work (sharing only a couple of common words like
 * "add" or "fix") never trip it, low enough that a title reworded with a
 * synonym or reordered words ("Add rate limiting to login" vs "Rate-limit
 * the login endpoint") still does. Titles with no words in common after
 * normalization score 0, never treated as duplicates by coincidence of
 * an empty intersection over an empty union.
 */
export function titleSimilarity(a: string, b: string): number {
  const wa = new Set(normalizeTitle(a))
  const wb = new Set(normalizeTitle(b))
  if (wa.size === 0 || wb.size === 0) return 0
  let intersection = 0
  for (const w of wa) if (wb.has(w)) intersection++
  const union = wa.size + wb.size - intersection
  return union === 0 ? 0 : intersection / union
}

export const NEAR_DUPLICATE_THRESHOLD = 0.6

export function isNearDuplicate(title: string, backlog: WorkItem[]): boolean {
  return backlog.some((item) => titleSimilarity(title, item.title) >= NEAR_DUPLICATE_THRESHOLD)
}

/**
 * Proposes new work and returns it as DATA. This is the entire boundary:
 * `proposeIssues` never calls `gh`, never writes a file, never touches the
 * filesystem or the network on its own — its only effectful action is
 * calling the `invoke` callback the caller supplied, and that callback's
 * contract is "return text," not "create anything." The caller (a human-
 * reviewed `plan` command, dispatching the most capable model at high
 * effort per the design spec) is the one that turns this data into actual
 * GitHub issues, and it MUST do so through `buildIssueCreateArgs` below —
 * never by hand-assembling its own `gh issue create` argv — because that is
 * the only place `needs-human` is attached, and it is attached
 * unconditionally there, not here.
 *
 * Deduplication happens here, against the backlog the caller already read:
 * an item whose title is a near-duplicate (see `isNearDuplicate`) of an
 * already-open issue is dropped from the result before it is ever returned,
 * so a caller can never even be tempted to skip the check.
 */
export async function proposeIssues(input: PlannerInput): Promise<ProposedIssue[]> {
  const prompt = buildPrompt(input)
  const raw = await input.invoke(prompt)
  const parsed = parseProposals(raw)
  if (parsed === undefined) return []

  const out: ProposedIssue[] = []
  for (const candidate of parsed) {
    const issue = toProposedIssue(candidate)
    if (issue === undefined) continue
    if (isNearDuplicate(issue.title, input.openBacklog)) continue
    out.push(issue)
  }
  return out
}

/**
 * The ONLY sanctioned way to turn a `ProposedIssue` into `gh issue create`
 * argv. `needs-human` is appended to the label list UNCONDITIONALLY, on the
 * very last line, after any caller-supplied labels — there is no parameter
 * that can suppress it and no code path through this function that omits
 * it. A caller that "forgot" to add it gets it anyway, because the caller
 * never had the option to leave it out: the label lives in this function's
 * own body, not in anything passed in.
 */
export function buildIssueCreateArgs(issue: ProposedIssue): string[] {
  const dependsSection = issue.dependsOn && issue.dependsOn.length > 0
    ? `\n\nDepends on: ${issue.dependsOn.map((d) => `#${d}`).join(', ')}`
    : ''
  return [
    'issue', 'create',
    '--title', issue.title,
    '--body', `${issue.body}${dependsSection}\n\n${PROPOSAL_HOLD_NOTE}`,
    '--label', [`${LANE_LABEL_PREFIX}${issue.lane}`, `${EFFORT_LABEL_PREFIX}${issue.effort}`, NEEDS_HUMAN_LABEL].join(','),
  ]
}

/**
 * #1815: `needs-human` means a human must act, so a planner-created issue says
 * WHICH act. Without this, an agent proposal wearing the veto read exactly like
 * an issue blocked on credentials, and eleven ordinary M1 issues sat buried
 * because nobody reading them could see a question to answer. The act is a
 * yes/no on the proposal — and the planner can never take it itself.
 */
export const PROPOSAL_HOLD_NOTE =
  `---\n**Why \`${NEEDS_HUMAN_LABEL}\`:** an agent (the fleet planner) proposed this issue. A human must ` +
  `accept or reject the proposal: to accept, remove \`${NEEDS_HUMAN_LABEL}\` and add \`agent-dispatchable\`; to ` +
  'reject, close it. The planner never does either itself, so an agent cannot propose work to itself and then do it.'
