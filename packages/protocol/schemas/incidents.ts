/**
 * Hub incidents (B-INCIDENTS, #2341) — the one channel every automatic
 * defence reports through while it is acting, so the people responsible for a
 * hub know it is happening (operator rule V, #2302).
 *
 * An incident is an AGGREGATE: one open row per (hub, category), carrying
 * per-kind integer counts. It never names a caller, a phone number, a provider
 * call id or any record id — the wire shape below has nowhere to put one.
 */
import { z } from 'zod'

/**
 * What the incident is about. Each category is reached by exactly one
 * permission (see `INCIDENT_CATEGORY_PERMISSION` in the worker), never by a role.
 *
 * Extensible by design: the column is plain text and clients must treat an
 * unknown value as "an incident they may not be able to label", so values are
 * appended without a schema break — `routing` and `provider-auth` arrived that
 * way (#2330): a hotline that rings nobody, and provider webhooks being
 * refused, are both total outages nothing else reports.
 */
export const incidentCategorySchema = z.enum([
  'spam',
  'provider-media',
  'erasure-deadline',
  'ban-expiry',
  'routing',
  'provider-auth',
  'channel-disabled',
])
export type IncidentCategory = z.infer<typeof incidentCategorySchema>

/**
 * `notify` interrupts someone (push, Signal, banner); `record` does not
 * (banner and incident panel only). Both satisfy rule V; only `notify` wakes
 * anybody. An incident's severity is the highest severity of any kind it has
 * seen while open — it escalates and never downgrades.
 */
export const incidentSeveritySchema = z.enum(['notify', 'record'])
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>

/** The transition a notification announces. */
export const incidentStateSchema = z.enum(['opened', 'updated', 'closed'])
export type IncidentState = z.infer<typeof incidentStateSchema>

export const hubIncidentSchema = z.object({
  id: z.string(),
  hubId: z.string(),
  category: incidentCategorySchema,
  severity: incidentSeveritySchema,
  openedAt: z.string(),
  lastSignalAt: z.string(),
  closedAt: z.string().nullable(),
  /** Per-kind event totals since the incident opened (level checks report their latest count). */
  counts: z.record(z.string(), z.number().int().nonnegative()),
  /** Sum of `counts`. */
  totalCount: z.number().int().nonnegative(),
  /** Most events seen in any single minute while open. */
  peakPerMinute: z.number().int().nonnegative(),
  /** Age of the oldest overdue item, for level checks (e.g. an erasure past its deadline); null otherwise. */
  oldestAgeSeconds: z.number().int().nonnegative().nullable(),
})
export type HubIncident = z.infer<typeof hubIncidentSchema>

export const hubIncidentListResponseSchema = z.object({
  incidents: z.array(hubIncidentSchema),
})
export type HubIncidentListResponse = z.infer<typeof hubIncidentListResponseSchema>

/** `GET /hubs/:hubId/incidents?open=true` — `open=true` returns open incidents only. */
export const listIncidentsQuerySchema = z.object({
  open: z.enum(['true', 'false']).optional(),
})

/**
 * Content of a `KIND_HUB_INCIDENT` relay event. `publishEvent` fans out to
 * EVERY member of the hub, so the payload says only that an incident changed:
 * no category, no counts, no severity. A client holding a relevant permission
 * refetches the permission-filtered GET for detail; nobody else learns more.
 * `.strict()` so a field added here by mistake fails validation loudly.
 */
export const hubIncidentRelayEventSchema = z
  .object({
    incidentId: z.string(),
    state: incidentStateSchema,
  })
  .strict()
export type HubIncidentRelayEvent = z.infer<typeof hubIncidentRelayEventSchema>
