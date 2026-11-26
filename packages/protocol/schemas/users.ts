import { z } from 'zod'
import { pubkeySchema } from './common'
import { messagingChannelTypeSchema } from './settings'

// --- Response schemas ---

export const userResponseSchema = z.object({
  pubkey: pubkeySchema,
  name: z.string(),
  roles: z.array(z.string()),
  active: z.boolean(),
  createdAt: z.string(),
  transcriptionEnabled: z.boolean().optional(),
  spokenLanguages: z.array(z.string()).optional(),
  uiLanguage: z.string().optional(),
  profileCompleted: z.boolean().optional(),
  onBreak: z.boolean().optional(),
  callPreference: z.enum(['phone', 'browser', 'both']).optional(),
  // Epic 340: User profile extensions
  specializations: z.array(z.string()).optional(),
  maxCaseAssignments: z.number().optional(),
  teamId: z.string().optional(),
  supervisorPubkey: z.string().optional(),
})

export const userAdminResponseSchema = userResponseSchema.extend({
  phone: z.string(),
  messagingEnabled: z.boolean().optional(),
  supportedMessagingChannels: z.array(messagingChannelTypeSchema).optional(),
})

export type User = z.infer<typeof userAdminResponseSchema>

// --- List/wrapper response schemas ---

export const userListResponseSchema = z.object({
  users: z.array(userAdminResponseSchema),
})
export type UserListResponse = z.infer<typeof userListResponseSchema>

/**
 * `GET /api/identity/members` (#1701, #1766) — the member directory, and the
 * canonical surface for listing members on every client.
 *
 * Deliberately narrower than `userResponseSchema`: no `phone`, no `roles`, no
 * `hubRoles`. `role` is resolved server-side from the roles that carry
 * authority in the requested hub, so a hub never learns that one of its
 * members administers a different hub, nor what custom role names they hold.
 * Do not add a role id, role name or hub membership to this shape.
 */
export const memberDirectoryEntrySchema = z.object({
  id: z.string(),
  pubkey: pubkeySchema,
  displayName: z.string().nullable(),
  role: z.enum(['admin', 'volunteer']),
  status: z.enum(['active', 'inactive']),
  createdAt: z.string(),
})
export type MemberDirectoryEntry = z.infer<typeof memberDirectoryEntrySchema>

export const memberDirectoryResponseSchema = z.object({
  members: z.array(memberDirectoryEntrySchema),
})
export type MemberDirectoryResponse = z.infer<typeof memberDirectoryResponseSchema>

/**
 * The user shape WITHOUT `phone` and the admin-only channel fields. Phone numbers are
 * admin-only (CLAUDE.md role matrix): every `/users` route is gated on `users:read` and
 * answers `userAdminResponseSchema` (`User`, above), including `phone`. This narrower
 * shape is the base `userAdminResponseSchema` extends, for a surface that must not carry a
 * phone number.
 */
export type UserResponse = z.infer<typeof userResponseSchema>

export const userMetricsResponseSchema = z.object({
  pubkey: z.string(),
  activeCaseCount: z.number(),
  totalCasesHandled: z.number(),
  averageResolutionDays: z.number().nullable(),
})

// --- Input schemas ---

export const createUserBodySchema = z.object({
  pubkey: pubkeySchema,
  name: z.string().min(1).max(200),
  phone: z.string().max(20),
  roleIds: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  encryptedSecretKey: z.string().optional(),
  // Epic 340: User profile extensions
  specializations: z.array(z.string().max(100)).optional(),
  maxCaseAssignments: z.number().int().min(0).optional(),
  teamId: z.string().max(100).optional(),
  supervisorPubkey: pubkeySchema.optional(),
})
export type CreateUserBody = z.infer<typeof createUserBodySchema>

export const updateUserBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  phone: z.string().max(20).optional(),
  spokenLanguages: z.array(z.string().max(5)).optional(),
  uiLanguage: z.string().max(5).optional(),
  profileCompleted: z.boolean().optional(),
  transcriptionEnabled: z.boolean().optional(),
  onBreak: z.boolean().optional(),
  callPreference: z.enum(['phone', 'browser', 'both']).optional(),
  // Epic 340: Users can self-update specializations
  specializations: z.array(z.string().max(100)).optional(),
})

export const adminUpdateUserBodySchema = updateUserBodySchema.extend({
  roles: z.array(z.string()).optional(),
  active: z.boolean().optional(),
  messagingEnabled: z.boolean().optional(),
  supportedMessagingChannels: z.array(messagingChannelTypeSchema).optional(),
  // Epic 340: Admin-only profile fields
  maxCaseAssignments: z.number().int().min(0).optional(),
  teamId: z.string().max(100).optional(),
  supervisorPubkey: pubkeySchema.optional(),
})
export type AdminUpdateUserBody = z.infer<typeof adminUpdateUserBodySchema>
