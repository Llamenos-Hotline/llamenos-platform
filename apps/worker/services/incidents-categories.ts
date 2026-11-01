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
 * Adding a category is: one value in `incidentCategorySchema`, one row here,
 * one locale key for its name. No migration — the column is text. `routing`
 * and `provider-auth` (#2330) were added that way.
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
      // The over-limit caller was sent to voicemail rather than a volunteer.
      over_limit_voicemail: 'notify',
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
  // Erasure requests past their deadline (#2323) or that failed outright
  // (#2347 — a `failed` request is by construction never overdue, and nothing
  // else picks it up). Reaches `erasure:admin` — NOT `erasure:request-self`,
  // which every member holds.
  'erasure-deadline': {
    permission: 'erasure:admin',
    quietPeriodMs: 30 * MINUTE_MS,
    updateWindowMs: 60 * MINUTE_MS,
    kinds: {
      overdue: 'notify',
      failed: 'notify',
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
  // The hotline's core function (#2330): a caller dialling in and nobody
  // picking up. Both kinds are L1 checks (services/routing-readiness.ts) run
  // by `incident-checks`, so they are LEVELS re-observed every tick — a hub
  // with no shift and an empty fallback group is a standing incident until an
  // admin rosters somebody, not a one-off. Reaches `shifts:manage-fallback`:
  // the people who can make somebody ring when the schedule does not.
  routing: {
    permission: 'shifts:manage-fallback',
    quietPeriodMs: 20 * MINUTE_MS,
    updateWindowMs: 60 * MINUTE_MS,
    kinds: {
      // A call arriving now, during a period the hub expects coverage, would ring nobody.
      nobody_would_ring: 'notify',
      // Calls came in (≥ ROUTING_NO_ANSWER_MIN_INBOUND) and none was answered.
      no_answers: 'notify',
      [WORKER_FAILING_KIND]: 'notify',
    },
  },
  // Provider webhooks refused before authentication (routes/telephony.ts). A
  // rotated signing secret or a moved provider egress range makes EVERY call
  // 403 — a total outage — but anyone on the internet can also produce a
  // rejection, so the raw count never interrupts anybody. Only evidence an
  // outsider cannot forge does (spec §5.7 amendments 1-3); the rest is
  // visible in the panel and wakes nobody. Reaches the people who can fix the
  // provider configuration.
  'provider-auth': {
    permission: 'telephony:manage-providers',
    quietPeriodMs: 30 * MINUTE_MS,
    updateWindowMs: 15 * MINUTE_MS,
    kinds: {
      // Unattributed: a bad signature from an allowed source (or with the IP
      // allowlist off), or one that does not carry our provider account id.
      signature_invalid: 'record',
      // A source outside the provider IP allowlist whose signature did not verify.
      ip_rejected: 'record',
      // Our provider (allowlisted egress) about our account (provider-populated
      // id) mis-authenticating: the signing secret no longer matches.
      own_account_signature_invalid: 'notify',
      // A correctly SIGNED request from outside the allowlist. Only our signing
      // secret produces that signature, so the allowlist is out of date. The
      // request is still refused; this only names the cause.
      provider_allowlist_stale: 'notify',
      // Unattributed rejections while this hub's accepted webhooks have
      // stopped after flowing in the previous window — either the signing
      // secret or the provider IP allowlist; the evidence cannot say which.
      traffic_stopped: 'notify',
      [WORKER_FAILING_KIND]: 'notify',
    },
  },
  // A webhook for a channel the hub has switched off, refused (#2384). Each
  // refusal is a person who tried to reach a crisis line and did not, so it is
  // never silent — but it is expected behaviour (the switch did what it was set
  // to do), so it is `record`: the panel and banner, no page. The kind names
  // the channel; nothing else about the contact is kept. Reaches the people who
  // can flip the switch back (`PUT /hubs/:hubId/onboard/channels`).
  'channel-disabled': {
    permission: 'hubs:configure',
    quietPeriodMs: 30 * MINUTE_MS,
    updateWindowMs: 60 * MINUTE_MS,
    kinds: {
      voice: 'record',
      sms: 'record',
      whatsapp: 'record',
      signal: 'record',
      telegram: 'record',
      rcs: 'record',
      [WORKER_FAILING_KIND]: 'notify',
    },
  },
} as const satisfies Record<IncidentCategory, IncidentCategoryPolicy>

/**
 * The ONE permission that reads, and is paged for, PLATFORM-scope incidents —
 * things that concern the instance rather than any hub (an erasure whose
 * subject belongs to no hub, #2347). Instance-level, like the platform-wide
 * ban retention and its super-admin notification: a permission, never a role.
 * Hub roles do not grant it, so a hub's erasure admins do not see these.
 */
export const PLATFORM_INCIDENT_PERMISSION: Permission = 'system:manage-instance'

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
