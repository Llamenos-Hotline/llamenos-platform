import { z } from 'zod'
import { recipientEnvelopeSchema } from './common'
import { directoryContactTypeSchema } from './contacts-v2'

// --- Contact Relationship ---

export const relationshipDirectionSchema = z.enum(['a_to_b', 'b_to_a', 'bidirectional'])
export type RelationshipDirection = z.infer<typeof relationshipDirectionSchema>

export const contactRelationshipSchema = z.object({
  id: z.uuid(),
  hubId: z.string(),
  contactIdA: z.uuid(),
  contactIdB: z.uuid(),
  relationshipType: z.string().max(50),
  direction: relationshipDirectionSchema,
  encryptedNotes: z.string().optional(),
  notesEnvelopes: z.array(recipientEnvelopeSchema).optional(),
  createdAt: z.string(),
  createdBy: z.string(),
})

export type ContactRelationship = z.infer<typeof contactRelationshipSchema>

export const createRelationshipBodySchema = z.object({
  contactIdB: z.uuid(),
  relationshipType: z.string().max(50),
  direction: relationshipDirectionSchema.optional().default('bidirectional'),
  encryptedNotes: z.string().optional(),
  notesEnvelopes: z.array(recipientEnvelopeSchema).optional(),
})

export type CreateRelationshipBody = z.infer<typeof createRelationshipBodySchema>

export const RELATIONSHIP_TYPES = [
  'support_contact',    // Person who calls on behalf of another
  'attorney',           // Legal representation
  'family',             // Family member
  'interpreter',        // Language assistance
  'social_worker',      // Social services
  'medical_contact',    // Medical provider / emergency medical
  'employer',           // Employer (for workplace raids)
  'co_defendant',       // Arrested together, same charges
  'witness',            // Witnessed the incident
  'housing_contact',    // Landlord, shelter coordinator
  'custom',             // Free-form relationship
] as const

// --- Affinity Group ---

export const affinityGroupSchema = z.object({
  id: z.uuid(),
  hubId: z.string(),
  encryptedDetails: z.string(),
  detailEnvelopes: z.array(recipientEnvelopeSchema).min(1),
  memberCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
})

export type AffinityGroup = z.infer<typeof affinityGroupSchema>

export const groupMemberSchema = z.object({
  contactId: z.uuid(),
  role: z.string().max(50).optional(),
  isPrimary: z.boolean(),
})

export type GroupMember = z.infer<typeof groupMemberSchema>

export const createAffinityGroupBodySchema = z.object({
  encryptedDetails: z.string().min(1),
  detailEnvelopes: z.array(recipientEnvelopeSchema).min(1),
  members: z.array(z.object({
    contactId: z.uuid(),
    role: z.string().max(50).optional(),
    isPrimary: z.boolean().optional().default(false),
  })).min(1),
})

export type CreateAffinityGroupBody = z.infer<typeof createAffinityGroupBodySchema>

export const updateAffinityGroupBodySchema = z.object({
  encryptedDetails: z.string().optional(),
  detailEnvelopes: z.array(recipientEnvelopeSchema).optional(),
})

export type UpdateAffinityGroupBody = z.infer<typeof updateAffinityGroupBodySchema>

export const addGroupMemberBodySchema = z.object({
  contactId: z.uuid(),
  role: z.string().max(50).optional(),
  isPrimary: z.boolean().optional().default(false),
})

export type AddGroupMemberBody = z.infer<typeof addGroupMemberBodySchema>

// --- Encrypted payloads (client-side only, for reference/codegen) ---

export const affinityGroupDetailsSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  members: z.array(z.object({
    contactId: z.uuid(),
    role: z.string().optional(),
    isPrimary: z.boolean(),
  })),
})

export type AffinityGroupDetails = z.infer<typeof affinityGroupDetailsSchema>

export const GROUP_MEMBER_ROLES = [
  'medic',              // Street medic
  'legal_observer',     // NLG legal observer
  'de_escalator',       // Trained de-escalation
  'media',              // Independent media / livestreamer
  'driver',             // Transport
  'coordinator',        // Group coordinator
  'custom',             // Free-form role
] as const

// --- Client-side display response schemas ---

/** Decrypted/resolved contact relationship for UI rendering (differs from storage model) */
export const contactRelationshipResponseSchema = z.object({
  id: z.string(),
  sourceContactId: z.string(),
  targetContactId: z.string(),
  relationshipType: z.string(),
  direction: z.enum(['outgoing', 'incoming']),
  targetDisplayName: z.string(),
  targetContactType: directoryContactTypeSchema,
  createdAt: z.string(),
})

export type ContactRelationshipResponse = z.infer<typeof contactRelationshipResponseSchema>

/** Decrypted affinity group for UI rendering (differs from encrypted storage model) */
export const contactGroupResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  role: z.string().optional(),
  memberCount: z.number(),
})

export type ContactGroupResponse = z.infer<typeof contactGroupResponseSchema>

// --- Response schemas for OpenAPI ---

export const contactRelationshipListResponseSchema = z.object({
  relationships: z.array(contactRelationshipSchema),
})
export type ContactRelationshipListResponse = z.infer<typeof contactRelationshipListResponseSchema>

export const affinityGroupListResponseSchema = z.object({
  groups: z.array(affinityGroupSchema),
})
export type AffinityGroupListResponse = z.infer<typeof affinityGroupListResponseSchema>

export const affinityGroupWithMembersResponseSchema = affinityGroupSchema.extend({
  members: z.array(groupMemberSchema),
})

export const groupMemberListResponseSchema = z.object({
  members: z.array(groupMemberSchema),
})
