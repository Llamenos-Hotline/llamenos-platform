/**
 * Teams domain tables: teams, team members, and contact-team assignments.
 * Teams are hub-scoped organizational groups with encrypted names/descriptions.
 */
import { relations } from 'drizzle-orm'
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'
import { contacts } from './contacts'
import { hubs } from './settings'
import { users } from './users'
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

// ---------------------------------------------------------------------------
// teams
// ---------------------------------------------------------------------------

export const teams = pgTable(
  'teams',
  {
    id: text('id').primaryKey(),
    hubId: text('hub_id')
      .notNull()
      .references(() => hubs.id, { onDelete: 'cascade' }),
    encryptedName: text('encrypted_name').notNull(),
    encryptedDescription: text('encrypted_description'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    cryptoFormat: cryptoFormatColumn(),
  },
  (table) => [
    cryptoFormatCheck('teams', table.cryptoFormat),
    index('teams_hub_idx').on(table.hubId),
  ],
)

// ---------------------------------------------------------------------------
// team_members
// ---------------------------------------------------------------------------

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userPubkey: text('user_pubkey')
      .notNull()
      .references(() => users.pubkey, { onDelete: 'cascade' }),
    addedBy: text('added_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userPubkey] }),
    index('team_members_user_idx').on(table.userPubkey),
  ],
)

// ---------------------------------------------------------------------------
// contact_team_assignments
// ---------------------------------------------------------------------------

export const contactTeamAssignments = pgTable(
  'contact_team_assignments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    hubId: text('hub_id').notNull(),
    assignedBy: text('assigned_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('contact_team_unique').on(table.contactId, table.teamId),
    index('contact_team_contact_idx').on(table.contactId),
    index('contact_team_team_idx').on(table.teamId),
    index('contact_team_hub_idx').on(table.hubId),
  ],
)

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const teamsRelations = relations(teams, ({ many }) => ({
  members: many(teamMembers),
  contactAssignments: many(contactTeamAssignments),
}))

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [teamMembers.userPubkey],
    references: [users.pubkey],
  }),
}))

export const contactTeamAssignmentsRelations = relations(
  contactTeamAssignments,
  ({ one }) => ({
    team: one(teams, {
      fields: [contactTeamAssignments.teamId],
      references: [teams.id],
    }),
  }),
)
