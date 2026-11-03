import { ghJson } from './gh.js'

export interface WorkItem {
  id: string
  title: string
  body: string
  url: string
  labels: string[]
}

export interface RawIssue {
  number: number
  title: string
  body: string | null
  url: string
  state: string
  labels: { name: string }[]
  createdAt: string
}

/**
 * "Nothing there" and "could not look" are different facts, and this type
 * makes them impossible to confuse — or to drop. `undefined` carried the
 * distinction but not the REASON, so an abort could say only that the source
 * was unreadable, never why. `detail` is that why, in one line.
 */
export type ListResult =
  | { ok: true; items: WorkItem[] }
  | { ok: false; detail: string }

export interface WorkSource {
  list(): Promise<ListResult>
  /** Labels read fresh at dispatch time, never from a cached list. */
  labels(id: string): Promise<string[] | undefined>
}

export function toWorkItem(raw: RawIssue): WorkItem {
  return {
    id: String(raw.number),
    title: raw.title,
    body: raw.body ?? '',
    url: raw.url,
    labels: raw.labels.map((l) => l.name),
  }
}

export function itemsFrom(raw: RawIssue[] | undefined): WorkItem[] | undefined {
  return raw === undefined ? undefined : raw.map(toWorkItem)
}

const FIELDS = 'number,title,body,url,state,labels,createdAt'

/**
 * Phase labels (`m1-phase:0-queue-health` … `m1-phase:5-claim-m1`) are the
 * queue's ORDERING metadata — they say how urgent an item is, not whether it
 * is in scope. Scope is the milestone plus the require label; before #1813
 * the phase labels were asked to be both, which made them a hand-kept shadow
 * of the milestone that drifted to 16% coverage.
 */
export const PHASE_LABEL_PREFIX = 'm1-phase:'

/**
 * The earliest phase an item carries, or `undefined` when it carries none.
 * The phase number is the digit run immediately after the prefix
 * (`m1-phase:1-data-loss` → 1); a label with no digits is not a phase label.
 * An item labelled into two phases sorts at the EARLIER one — the alternative
 * (later wins) would let a misapplied `:4` hide a `:0` fire from the head of
 * the queue.
 */
export function phaseRank(labelNames: string[]): number | undefined {
  let best: number | undefined
  for (const name of labelNames) {
    if (!name.startsWith(PHASE_LABEL_PREFIX)) continue
    const digits = /^(\d+)/.exec(name.slice(PHASE_LABEL_PREFIX.length))
    if (digits === null) continue
    const n = Number(digits[1])
    if (best === undefined || n < best) best = n
  }
  return best
}

/**
 * The dispatch queue's explicit order (#1813): PHASE first, then AGE.
 *
 * Before this, `gh issue list` was called with no sort, so the queue took
 * gh's default — created DESCENDING, newest-first — and a freshly filed
 * infrastructure issue always outranked a six-week-old M1 blocker, which is
 * precisely backwards. The comparator reverses that on both axes:
 *
 * - A phased item (`m1-phase:N-*`) always sorts ahead of an unphased one, and
 *   between two phased items the lower phase number wins.
 * - Within one phase class (including the unphased class), the OLDER item
 *   wins — so a new filing can never displace anything already waiting,
 *   which is the exact displacement the issue's verification checks for.
 *
 * The comparison is total and deterministic: two items equal on both keys
 * compare 0, and Array#sort is stable, so their relative order is the fetch
 * order (`sort:created-asc` — see list()).
 */
export function compareQueueOrder(a: RawIssue, b: RawIssue): number {
  const pa = phaseRank(a.labels.map((l) => l.name))
  const pb = phaseRank(b.labels.map((l) => l.name))
  if (pa !== undefined && pb !== undefined && pa !== pb) return pa - pb
  if (pa !== undefined && pb === undefined) return -1
  if (pa === undefined && pb !== undefined) return 1
  if (a.createdAt < b.createdAt) return -1
  if (a.createdAt > b.createdAt) return 1
  return 0
}

export class GitHubSource implements WorkSource {
  /**
   * `milestone` is optional: when set, the source selects on the milestone AS
   * WELL AS the require label (`gh` ANDs the two), so the lane's scope is the
   * milestone humans already maintain rather than a second label taxonomy
   * that drifts (#1813). When unset, behaviour is exactly as before — which
   * milestone, if any, a lane scopes to is an operator dial (`lanes.json`),
   * not a source-code constant, because advancing from M1 to M2 must not
   * require a human-gated PR to the orchestrator.
   */
  constructor(private readonly requireLabel: string, private readonly milestone?: string) {}

  async list(): Promise<ListResult> {
    let failure: string | undefined
    const args = [
      'issue', 'list', '--state', 'open', '--label', this.requireLabel,
      '--limit', '200', '--json', FIELDS,
      // Explicit sort, never gh's default (created-descending): oldest-first
      // at the FETCH layer too, so when the result set exceeds the 200-item
      // page it is the newest filings that fall off the edge, not the oldest
      // — and the client-side `compareQueueOrder` below then orders the page
      // phase-first. Both layers are needed: the search qualifier decides
      // WHICH 200 items are seen, the comparator decides their order.
      '--search', 'sort:created-asc',
    ]
    if (this.milestone !== undefined) args.push('--milestone', this.milestone)
    const raw = await ghJson<RawIssue[]>(
      args,
      undefined,
      (detail) => { failure = detail },
    )
    if (raw === undefined) {
      // `ghJson` only returns undefined after a failure, so `failure` is set —
      // the fallback names the one case that would otherwise print "undefined"
      // and send the next reader down the same blind alley this exists to end.
      return { ok: false, detail: failure ?? 'gh returned no JSON and reported no error' }
    }
    return { ok: true, items: raw.sort(compareQueueOrder).map(toWorkItem) }
  }

  /**
   * Read per item at dispatch time. A label list captured during selection can
   * be minutes stale, and "someone added needs-human while we were deciding" is
   * exactly the case the veto exists for.
   */
  async labels(id: string): Promise<string[] | undefined> {
    const raw = await ghJson<{ labels: { name: string }[] }>(['issue', 'view', id, '--json', 'labels'])
    return raw === undefined ? undefined : raw.labels.map((l) => l.name)
  }
}
