import { z } from 'zod'
import { recipientEnvelopeSchema, paginationSchema } from './common'
import { locationPrecisionSchema } from './geocoding'
import { forPatch } from './patch'

/**
 * @deprecated Events are now records whose entity type has category='event'.
 * These schemas are retained for the migration period only.
 * Use packages/protocol/schemas/records.ts and entity-schema.ts for new code.
 */

// --- Location Precision (re-exported from geocoding.ts) ---

export { locationPrecisionSchema } from './geocoding'
export type { LocationPrecision } from './geocoding'

// --- Event (stored in CaseDO as a record with category='event') ---

export const eventSchema = z.object({
  id: z.uuid(),
  hubId: z.string(),
  entityTypeId: z.uuid(),
  caseNumber: z.string().optional(),

  // --- Event-specific cleartext metadata ---
  startDate: z.string(),                         // ISO 8601
  endDate: z.string().optional(),                 // ISO 8601
  parentEventId: z.uuid().optional(),    // Sub-event hierarchy
  locationPrecision: locationPrecisionSchema.optional().default('neighborhood'),
  locationApproximate: z.string().optional(),     // Cleartext approximate location

  // --- Blind indexes (server-filterable) ---
  eventTypeHash: z.string(),
  statusHash: z.string(),
  blindIndexes: z.record(z.string(), z.union([z.string(), z.array(z.string())])),

  // --- E2EE encrypted details ---
  encryptedDetails: z.string(),
  detailEnvelopes: z.array(recipientEnvelopeSchema).min(1),

  // --- Relationship counts ---
  caseCount: z.number(),
  reportCount: z.number(),
  subEventCount: z.number(),

  // --- Timestamps ---
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
})

export type Event = z.infer<typeof eventSchema>

// --- Create event body ---

export const createEventBodySchema = z.object({
  entityTypeId: z.uuid(),
  startDate: z.string().min(1),
  endDate: z.string().optional(),
  parentEventId: z.uuid().optional(),
  locationPrecision: locationPrecisionSchema.optional().default('neighborhood'),
  locationApproximate: z.string().optional(),
  eventTypeHash: z.string(),
  statusHash: z.string(),
  blindIndexes: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional().default({}),
  encryptedDetails: z.string().min(1),
  detailEnvelopes: z.array(recipientEnvelopeSchema).min(1),
})

export type CreateEventBody = z.infer<typeof createEventBodySchema>

// --- Update event body (partial) ---

export const updateEventBodySchema = forPatch(createEventBodySchema)

export type UpdateEventBody = z.infer<typeof updateEventBodySchema>

// --- List events query (pagination + filters) ---

export const listEventsQuerySchema = paginationSchema.extend({
  eventTypeHash: z.string().optional(),
  statusHash: z.string().optional(),
  parentEventId: z.string().optional(),
  startAfter: z.string().optional(),
  startBefore: z.string().optional(),
})

export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>

// --- Join schemas ---

export const caseEventSchema = z.object({
  recordId: z.uuid(),
  eventId: z.uuid(),
  linkedAt: z.string(),
  linkedBy: z.string(),
})

export type CaseEvent = z.infer<typeof caseEventSchema>

export const reportEventSchema = z.object({
  reportId: z.string(),
  eventId: z.uuid(),
  linkedAt: z.string(),
  linkedBy: z.string(),
})

export type ReportEvent = z.infer<typeof reportEventSchema>

// --- Link bodies ---

export const linkRecordToEventBodySchema = z.object({
  recordId: z.uuid(),
})

export type LinkRecordToEventBody = z.infer<typeof linkRecordToEventBodySchema>

export const linkReportToEventBodySchema = z.object({
  reportId: z.string(),
})

export type LinkReportToEventBody = z.infer<typeof linkReportToEventBodySchema>

// --- Encrypted event details payload (client-side only, for reference/codegen) ---

export const eventDetailsSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  eventType: z.string(),
  status: z.string(),
  location: z.object({
    address: z.string(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    area: z.string().optional(),
    jurisdiction: z.string().optional(),
  }).optional(),
  organizers: z.array(z.string()).optional(),
  expectedAttendance: z.number().optional(),
  policePresence: z.string().optional(),
  legalHotlineNumber: z.string().optional(),
  medicalTeamPresent: z.boolean().optional(),
  subEventLabels: z.array(z.string()).optional(),
  notes: z.string().optional(),
})

export type EventDetails = z.infer<typeof eventDetailsSchema>

// --- Response schemas for OpenAPI ---

export const eventListResponseSchema = z.object({
  events: z.array(eventSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
  hasMore: z.boolean(),
})

export const caseEventListResponseSchema = z.object({
  links: z.array(caseEventSchema),
})

export const reportEventListResponseSchema = z.object({
  links: z.array(reportEventSchema),
})
