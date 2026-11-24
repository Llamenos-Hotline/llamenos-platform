/**
 * TeamsService — hub-scoped team CRUD with encrypted names and member management.
 *
 * Team names and descriptions are stored as HPKE-encrypted blobs — the server
 * never sees plaintext. Contact–team assignments are also stored here.
 */
import { eq, and, count, inArray } from 'drizzle-orm'
import type { Database } from '../db'
import { teams, teamMembers, contactTeamAssignments } from '../db/schema'
import { ServiceError } from './service-error'

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

type TeamRow = typeof teams.$inferSelect
type TeamMemberRow = typeof teamMembers.$inferSelect
type ContactTeamAssignmentRow = typeof contactTeamAssignments.$inferSelect

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateTeamInput {
  id: string
  hubId: string
  encryptedName: string
  encryptedDescription?: string
  createdBy: string
}

export interface UpdateTeamInput {
  encryptedName?: string
  encryptedDescription?: string | null
}

export interface TeamWithCounts extends TeamRow {
  memberCount: number
  contactCount: number
}

// ---------------------------------------------------------------------------
// TeamsService
// ---------------------------------------------------------------------------

export class TeamsService {
  constructor(protected db: Database) {}

  async createTeam(input: CreateTeamInput): Promise<TeamWithCounts> {
    const [team] = await this.db
      .insert(teams)
      .values({
        id: input.id,
        hubId: input.hubId,
        encryptedName: input.encryptedName,
        encryptedDescription: input.encryptedDescription ?? null,
        createdBy: input.createdBy,
      })
      .returning()

    return { ...team, memberCount: 0, contactCount: 0 }
  }

  async getTeam(id: string, hubId: string): Promise<TeamWithCounts> {
    const [team] = await this.db
      .select()
      .from(teams)
      .where(and(eq(teams.id, id), eq(teams.hubId, hubId)))

    if (!team) throw new ServiceError(404, 'Team not found')

    const [[{ memberCount }], [{ contactCount }]] = await Promise.all([
      this.db
        .select({ memberCount: count() })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, id)),
      this.db
        .select({ contactCount: count() })
        .from(contactTeamAssignments)
        .where(eq(contactTeamAssignments.teamId, id)),
    ])

    return {
      ...team,
      memberCount: Number(memberCount),
      contactCount: Number(contactCount),
    }
  }

  async listTeams(hubId: string): Promise<TeamWithCounts[]> {
    const rows = await this.db
      .select()
      .from(teams)
      .where(eq(teams.hubId, hubId))
      .orderBy(teams.createdAt)

    if (rows.length === 0) return []

    const teamIds = rows.map((t) => t.id)

    // Batch count members and contacts for all teams in one query each
    const [memberCounts, contactCounts] = await Promise.all([
      this.db
        .select({ teamId: teamMembers.teamId, cnt: count() })
        .from(teamMembers)
        .where(inArray(teamMembers.teamId, teamIds))
        .groupBy(teamMembers.teamId),
      this.db
        .select({ teamId: contactTeamAssignments.teamId, cnt: count() })
        .from(contactTeamAssignments)
        .where(inArray(contactTeamAssignments.teamId, teamIds))
        .groupBy(contactTeamAssignments.teamId),
    ])
    const memberCountMap = new Map(memberCounts.map((r) => [r.teamId, Number(r.cnt)]))
    const contactCountMap = new Map(contactCounts.map((r) => [r.teamId, Number(r.cnt)]))

    return rows.map((t) => ({
      ...t,
      memberCount: memberCountMap.get(t.id) ?? 0,
      contactCount: contactCountMap.get(t.id) ?? 0,
    }))
  }

  async updateTeam(id: string, hubId: string, input: UpdateTeamInput): Promise<TeamWithCounts> {
    const updates: Partial<typeof teams.$inferInsert> = {
      updatedAt: new Date(),
    }
    if (input.encryptedName !== undefined) updates.encryptedName = input.encryptedName
    if (input.encryptedDescription !== undefined) updates.encryptedDescription = input.encryptedDescription

    const [updated] = await this.db
      .update(teams)
      .set(updates)
      .where(and(eq(teams.id, id), eq(teams.hubId, hubId)))
      .returning()

    if (!updated) throw new ServiceError(404, 'Team not found')

    return this.getTeam(id, hubId)
  }

  async deleteTeam(id: string, hubId: string): Promise<void> {
    const result = await this.db
      .delete(teams)
      .where(and(eq(teams.id, id), eq(teams.hubId, hubId)))
      .returning({ id: teams.id })

    if (result.length === 0) throw new ServiceError(404, 'Team not found')
  }

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  async listMembers(teamId: string, hubId: string): Promise<TeamMemberRow[]> {
    // Verify team belongs to hub
    await this.getTeam(teamId, hubId)

    return this.db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(teamMembers.createdAt)
  }

  async addMembers(teamId: string, hubId: string, pubkeys: string[], addedBy: string): Promise<void> {
    // Verify team belongs to hub
    await this.getTeam(teamId, hubId)

    if (pubkeys.length === 0) return

    await this.db
      .insert(teamMembers)
      .values(pubkeys.map((pk) => ({ teamId, userPubkey: pk, addedBy })))
      .onConflictDoNothing()
  }

  async removeMember(teamId: string, hubId: string, userPubkey: string): Promise<void> {
    // Verify team belongs to hub
    await this.getTeam(teamId, hubId)

    await this.db
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userPubkey, userPubkey)))
  }

  // -------------------------------------------------------------------------
  // Contact assignments
  // -------------------------------------------------------------------------

  async listContactAssignments(teamId: string, hubId: string): Promise<ContactTeamAssignmentRow[]> {
    await this.getTeam(teamId, hubId)

    return this.db
      .select()
      .from(contactTeamAssignments)
      .where(and(eq(contactTeamAssignments.teamId, teamId), eq(contactTeamAssignments.hubId, hubId)))
      .orderBy(contactTeamAssignments.createdAt)
  }

  async assignContacts(teamId: string, hubId: string, contactIds: string[], assignedBy: string): Promise<void> {
    await this.getTeam(teamId, hubId)

    if (contactIds.length === 0) return

    await this.db
      .insert(contactTeamAssignments)
      .values(contactIds.map((cid) => ({ contactId: cid, teamId, hubId, assignedBy })))
      .onConflictDoNothing()
  }

  async unassignContact(teamId: string, hubId: string, contactId: string): Promise<void> {
    await this.getTeam(teamId, hubId)

    await this.db
      .delete(contactTeamAssignments)
      .where(
        and(
          eq(contactTeamAssignments.teamId, teamId),
          eq(contactTeamAssignments.contactId, contactId),
          eq(contactTeamAssignments.hubId, hubId),
        ),
      )
  }

  async listTeamsForContact(contactId: string, hubId: string): Promise<TeamWithCounts[]> {
    const assignments = await this.db
      .select({ teamId: contactTeamAssignments.teamId })
      .from(contactTeamAssignments)
      .where(
        and(
          eq(contactTeamAssignments.contactId, contactId),
          eq(contactTeamAssignments.hubId, hubId),
        ),
      )

    const teamFetches = assignments.map((a) => this.getTeam(a.teamId, hubId))
    return Promise.all(teamFetches)
  }
}
