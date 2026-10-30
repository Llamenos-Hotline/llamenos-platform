/**
 * The incident category table (B-INCIDENTS, #2341): who each category reaches,
 * which kinds it accepts and how loudly each kind speaks.
 *
 * Reach is ONE permission per category. Roles are user-definable bundles of
 * permissions, so nothing here — or anywhere downstream — names a role id or
 * a role name: a person is reached because a role they hold in the hub grants
 * the category's permission, whatever that role is called.
 *
 * Kinds are a closed table per category, so `counts` keys are always ours and
 * never a caller-supplied string. `worker_failing` is the L2 kind every
 * category accepts (see `runWorkerTick` in incidents.ts).
 *
 * Adding a category (the held `routing` and `provider-auth`, #2330) is: one
 * value in `incidentCategorySchema`, one row here. No migration — the column is
 * text.
 */
import type { IncidentCategory, IncidentSeverity } from '@protocol/schemas/incidents'
import type { Permission } from '@shared/permissions'

const MINUTE_MS = 60_000

/** The L2 worker-failure kind, accepted by every category. */
export const WORKER_FAILING_KIND = 'worker_failing'

export interface IncidentCategoryPolicy {
  /** The one permission that reaches this category — for the GET, the push and Signal alike. */
  permission: Permission
  /**
   * How long the incident must go without a signal before the closer closes
   * it. Level checks re-signal every `incident-checks` tick while their count
   * is non-zero, so a check-fed category's quiet period must exceed that
   * worker's interval (asserted in the unit tests).
   */
  quietPeriodMs: number
  /** At most one `updated` notification per this window. */
  updateWindowMs: number
  /** Every kind this category accepts, with the severity it carries. */
  kinds: Readonly<Record<string, IncidentSeverity>>
}

export const INCIDENT_CATEGORIES = {
  // Rule V's first consumer: CAPTCHA, rate limiting, the over-limit (c)
  // message, ban matches and auto under-attack mode (B-CAPTCHA,
  // B-ATTACK-SERVER). Routine screening (a challenge served, a ban matched) is
  // visible but does not wake anybody; a caller being refused service does.
  spam: {
    permission: 'settings:manage-spam',
    quietPeriodMs: 15 * MINUTE_MS,
    updateWindowMs: 10 * MINUTE_MS,
    kinds: {
      challenge: 'record',
      timeout: 'record',
      ban_match: 'record',
      fail: 'notify',
      over_limit_message: 'notify',
      reject: 'notify',
      mode_switch: 'notify',
      [WORKER_FAILING_KIND]: 'notify',
    },
  },
  // Caller audio the provider still holds after we asked it to delete it
  // (B-INCIDENT-PROVIDER-MEDIA wires `recordFailure`): a privacy promise not
  // yet kept, so it interrupts the people who manage the provider account.
  'provider-media': {
    permission: 'telephony:manage-providers',
    quietPeriodMs: 60 * MINUTE_MS,
    updateWindowMs: 60 * MINUTE_MS,
    kinds: {
      delete_failed: 'notify',
      deadline_passed: 'notify',
      [WORKER_FAILING_KIND]: 'notify',
    },
  },
  // Erasure requests past their deadline (#2323 supplies the check). Reaches
  // `erasure:admin` — NOT `erasure:request-self`, which every member holds.
  'erasure-deadline': {
    permission: 'erasure:admin',
    quietPeriodMs: 30 * MINUTE_MS,
    updateWindowMs: 60 * MINUTE_MS,
    kinds: {
      overdue: 'notify',
      [WORKER_FAILING_KIND]: 'notify',
    },
  },
  // Bans about to lapse (B1). A banner, not a page.
  'ban-expiry': {
    permission: 'system:view-bans',
    quietPeriodMs: 60 * MINUTE_MS,
    updateWindowMs: 6 * 60 * MINUTE_MS,
    kinds: {
      expiring: 'record',
      [WORKER_FAILING_KIND]: 'notify',
    },
  },
} as const satisfies Record<IncidentCategory, IncidentCategoryPolicy>

export type IncidentKind<C extends IncidentCategory> = keyof (typeof INCIDENT_CATEGORIES)[C]['kinds'] & string

/** Severity of `kind` in `category`; throws for a kind the category does not declare. */
export function severityOf(category: IncidentCategory, kind: string): IncidentSeverity {
  const kinds: Readonly<Record<string, IncidentSeverity>> = INCIDENT_CATEGORIES[category].kinds
  const severity = kinds[kind]
  if (!severity) {
    throw new Error(`Incident kind "${kind}" is not declared for category "${category}"`)
  }
  return severity
}

/** The categories whose permission `permissions` grants (wildcards honoured). */
export function categoriesReachedBy(
  granted: (permission: string) => boolean,
): IncidentCategory[] {
  return (Object.keys(INCIDENT_CATEGORIES) as IncidentCategory[]).filter((category) =>
    granted(INCIDENT_CATEGORIES[category].permission),
  )
}

/** `notify` outranks `record`: an incident escalates, never downgrades. */
export function maxSeverity(a: IncidentSeverity, b: IncidentSeverity): IncidentSeverity {
  return a === 'notify' || b === 'notify' ? 'notify' : 'record'
}
