import {
  eq,
  and,
  sql,
  inArray,
  or,
} from 'drizzle-orm'
import type { Database } from '../db'
import {
  hubs as hubsTable,
  hubSettings as hubSettingsTable,
  hubStorageSettings,
  hubStorageCredentials,
  entityTypeDefinitions,
  relationshipTypeDefinitions,
  reportTypeDefinitions,
  ivrAudio,
  caseNumberSequences,
  notes,
  noteReplies,
  bans,
  banReentries,
  contactMetadata,
  auditLog,
  shifts,
  activeCalls,
  callRecords,
  conversations,
  contacts,
  contactRelationships,
  affinityGroups,
  groupMembers,
  blasts,
  subscribers,
  blastSettings,
  caseRecords,
  caseContacts,
  caseEvents,
  caseInteractions,
  evidence,
  custodyEntries,
  reportEvents,
  reportCases,
  events as hubCaseEvents,
  users,
} from '../db/schema'
import type { Hub } from '@shared/types'
import type { SealedRecordingEraser } from './call-recordings'
import type { ProviderMediaEraser } from './provider-recordings'
import {
  hubFounderRoleIds,
  loadRoleCatalog,
  lockHubAdminSets,
  mergeHubRole,
  rolesConferHubAdmin,
  type HubRoleAssignment,
} from '../lib/hub-admin'
import { HubNotFoundError, ServiceError } from './service-error'

function hubFromRow(row: typeof hubsTable.$inferSelect): Hub {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? '',
    status: row.status as Hub['status'],
    phoneNumber: row.phoneNumber ?? undefined,
    timezone: row.timezone,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * The hub registry (`hubs`): listing, creation with its first admin, lifecycle (archive, delete,
 * purge) and lookup by phone number.
 */
export class HubService {
  constructor(protected db: Database) {}

  async getHubs(): Promise<{ hubs: Hub[] }> {
    const rows = await this.db.select().from(hubsTable)
    return { hubs: rows.map(hubFromRow) }
  }

  /**
   * Create a hub together with its first admin, atomically (#2126).
   *
   * A hub is never observable without an admin: the founder's admin assignment
   * is written in the same transaction as the hub row, and the transaction
   * fails — leaving no hub behind — if the founder does not exist, cannot act,
   * or the roles named would not make them an admin. The previous shape created
   * the hub and then granted the creator's role in a separate step whose
   * failure was only logged, which left a hub nobody could administer.
   *
   * `founder.roleIds` names the roles to grant; omitted, the founder gets the
   * role the live catalog designates for it BY PERMISSION ({@link hubFounderRoleIds}),
   * resolved inside the transaction so a concurrent role edit cannot change it
   * between the choice and the grant.
   */
  async createHub(
    hub: Hub,
    founder: { pubkey: string; roleIds?: readonly string[] },
  ): Promise<{ hub: Hub }> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: hubsTable.id })
        .from(hubsTable)
        .where(eq(hubsTable.slug, hub.slug))
      if (existing) {
        throw new ServiceError(409, 'Hub slug already exists')
      }

      const [founderRow] = await tx
        .select({ active: users.active, status: users.status, hubRoles: users.hubRoles })
        .from(users)
        .where(eq(users.pubkey, founder.pubkey))
        .for('update')
        .limit(1)
      if (!founderRow) throw new ServiceError(404, 'Hub founder not found')
      if (!founderRow.active || founderRow.status !== 'active') {
        throw new ServiceError(409, 'Hub founder is not an active user')
      }
      // Lock before reading the catalog: a role edit that strips the founder's
      // role must either finish first (and fail this check) or wait until the
      // hub's admin is committed (and be counted by its own guard).
      await lockHubAdminSets(tx, [hub.id])
      const catalog = await loadRoleCatalog(tx)
      const founderRoleIds = founder.roleIds ?? hubFounderRoleIds(catalog)
      if (!rolesConferHubAdmin(founderRoleIds, catalog)) {
        throw new ServiceError(400, 'A hub must be created with an admin role for its founder')
      }

      const now = new Date()
      await tx.insert(hubsTable).values({
        id: hub.id,
        name: hub.name,
        slug: hub.slug,
        description: hub.description,
        status: hub.status ?? 'active',
        phoneNumber: hub.phoneNumber,
        timezone: hub.timezone,
        createdBy: hub.createdBy,
        createdAt: now,
        updatedAt: now,
      })

      // Create hub_settings row
      await tx
        .insert(hubSettingsTable)
        .values({ hubId: hub.id, settings: {} })
        .onConflictDoNothing()

      await tx
        .update(users)
        .set({
          hubRoles: mergeHubRole((founderRow.hubRoles as HubRoleAssignment[] | null) ?? [], hub.id, founderRoleIds),
          updatedAt: now,
        })
        .where(eq(users.pubkey, founder.pubkey))
    })

    return { hub }
  }

  async getHub(id: string): Promise<{ hub: Hub }> {
    const [row] = await this.db
      .select()
      .from(hubsTable)
      .where(eq(hubsTable.id, id))
    if (!row) {
      throw new HubNotFoundError()
    }
    return { hub: hubFromRow(row) }
  }

  async updateHub(
    id: string,
    data: Partial<Hub>,
  ): Promise<{ hub: Hub }> {
    const [existing] = await this.db
      .select()
      .from(hubsTable)
      .where(eq(hubsTable.id, id))
    if (!existing) {
      throw new HubNotFoundError()
    }

    const now = new Date()
    const updates: Record<string, unknown> = { updatedAt: now }
    if (data.name !== undefined) updates.name = data.name
    if (data.slug !== undefined) updates.slug = data.slug
    if (data.description !== undefined) updates.description = data.description
    if (data.status !== undefined) updates.status = data.status
    if (data.phoneNumber !== undefined) updates.phoneNumber = data.phoneNumber
    if (data.timezone !== undefined) updates.timezone = data.timezone

    await this.db
      .update(hubsTable)
      .set(updates)
      .where(eq(hubsTable.id, id))

    const [updated] = await this.db
      .select()
      .from(hubsTable)
      .where(eq(hubsTable.id, id))

    return { hub: hubFromRow(updated) }
  }

  async archiveHub(id: string): Promise<{ ok: true }> {
    const [existing] = await this.db
      .select()
      .from(hubsTable)
      .where(eq(hubsTable.id, id))
    if (!existing) {
      throw new HubNotFoundError()
    }

    await this.db
      .update(hubsTable)
      .set({
        status: 'archived',
        updatedAt: new Date(),
      })
      .where(eq(hubsTable.id, id))
    return { ok: true }
  }

  /**
   * Permanently delete a hub. Caller audio the telephony provider still holds
   * for it is deleted AT the provider first (#2364): the hub row's cascade drops
   * `provider_configs`, the only way to reach that provider again, so audio left
   * there when the credentials go is unrecoverable. A recording the provider
   * will not delete — or one with no handle to delete it by (#2322) — refuses the
   * deletion with a 502 before anything is dropped; `deleteHeld` has already
   * kept the ledger row and raised the `provider-media` incident. A sealed copy
   * the object store will not delete refuses it first, as `SealedRecordingDeleteError`.
   * `providerMedia` is required so a caller cannot omit the step (the #1127 / #1566 failure class).
   *
   * `beforeDrop` runs once the provider has confirmed and before any hub row is
   * dropped, for teardown that is also irreversible (object-storage buckets): it
   * must not run for a deletion that is about to be refused.
   */
  async deleteHub(
    id: string,
    recordings: SealedRecordingEraser,
    providerMedia: ProviderMediaEraser,
    options: { beforeDrop?: () => Promise<void> } = {},
  ): Promise<{ ok: true }> {
    const [existing] = await this.db
      .select()
      .from(hubsTable)
      .where(eq(hubsTable.id, id))
    if (!existing) {
      throw new HubNotFoundError()
    }

    // The server's own sealed copies first, so a blob the object store will not
    // delete surfaces as the typed `SealedRecordingDeleteError` (what callers
    // report on) rather than as an anonymous entry in the provider step's
    // `failed` list below — `providerMedia` erases those copies too, but folds
    // a refusal into a 502.
    await recordings.eraseForHub(id)

    const media = await providerMedia.deleteForHub(id)
    if (media.failed.length > 0) {
      throw new ServiceError(
        502,
        `Hub deletion refused: caller audio is still held for ${media.failed.length} recording(s) that could not be deleted — ${media.failed[0].error}`,
      )
    }

    await options.beforeDrop?.()
    return this.purgeHub(id, recordings)
  }

  /**
   * Delete a hub and every hub-scoped row, without requiring the hub row to
   * exist — so orphaned data (hub row already gone) can still be cleared.
   *
   * The hub's sealed call recordings are deleted from object storage BEFORE the
   * transaction: the call rows it drops are what name those blobs, so after
   * them the audio could never be found again (#2338). If a recording cannot be
   * deleted this throws and nothing has been removed.
   */
  async purgeHub(id: string, recordings: SealedRecordingEraser): Promise<{ ok: true }> {
    await recordings.eraseForHub(id)
    await this.db.transaction(async (tx) => {
      // 1. Delete users who belong exclusively to this hub (cascade deletes sessions, webauthn, etc.)
      // Exclude super-admins — they are system-level accounts that must survive hub deletion.
      await tx.execute(sql`
        DELETE FROM users
        WHERE (
          SELECT COUNT(*) FROM jsonb_array_elements(hub_roles) AS hr
          WHERE hr->>'hubId' = ${id}
        ) > 0
        AND (
          SELECT COUNT(*) FROM jsonb_array_elements(hub_roles) AS hr
          WHERE hr->>'hubId' != ${id}
        ) = 0
        AND NOT ('role-super-admin' = ANY(roles))
      `)

      // 2. Remove this hub from remaining users' hubRoles
      await tx.execute(sql`
        UPDATE users
        SET hub_roles = (
          SELECT COALESCE(jsonb_agg(hr), '[]'::jsonb)
          FROM jsonb_array_elements(hub_roles) AS hr
          WHERE hr->>'hubId' != ${id}
        )
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(hub_roles) AS hr
          WHERE hr->>'hubId' = ${id}
        )
      `)

      // 3. Notes (noteReplies cascade from notes via FK)
      const hubNoteIds = await tx
        .select({ id: notes.id })
        .from(notes)
        .where(eq(notes.hubId, id))
      if (hubNoteIds.length > 0) {
        await tx.delete(noteReplies).where(
          inArray(noteReplies.noteId, hubNoteIds.map(n => n.id))
        )
      }
      await tx.delete(notes).where(eq(notes.hubId, id))

      // 4. Bans, contact metadata, audit log
      await tx.delete(bans).where(eq(bans.hubId, id))
      await tx.delete(banReentries).where(eq(banReentries.hubId, id))
      await tx.delete(contactMetadata).where(eq(contactMetadata.hubId, id))
      await tx.delete(auditLog).where(eq(auditLog.hubId, id))

      // 5. Case-related tables (join tables reference caseId, not hubId)
      const hubCaseIds = await tx
        .select({ id: caseRecords.id })
        .from(caseRecords)
        .where(eq(caseRecords.hubId, id))
      if (hubCaseIds.length > 0) {
        const ids = hubCaseIds.map(c => c.id)
        // Delete custody entries (grandchildren of evidence)
        const hubEvidenceIds = await tx
          .select({ id: evidence.id })
          .from(evidence)
          .where(inArray(evidence.caseId, ids))
        if (hubEvidenceIds.length > 0) {
          await tx.delete(custodyEntries).where(
            inArray(custodyEntries.evidenceId, hubEvidenceIds.map(e => e.id))
          )
        }
        await tx.delete(evidence).where(inArray(evidence.caseId, ids))
        await tx.delete(caseInteractions).where(inArray(caseInteractions.caseId, ids))
        await tx.delete(caseContacts).where(inArray(caseContacts.caseId, ids))
        await tx.delete(caseEvents).where(inArray(caseEvents.caseId, ids))
        await tx.delete(reportEvents).where(inArray(reportEvents.reportId, ids))
        // reportCases joins reports to cases — delete where either side is from this hub
        await tx.delete(reportCases).where(
          or(inArray(reportCases.reportId, ids), inArray(reportCases.caseId, ids))
        )
      }
      await tx.delete(caseRecords).where(eq(caseRecords.hubId, id))
      await tx.delete(hubCaseEvents).where(eq(hubCaseEvents.hubId, id))

      // 6. Conversations (messages, files, contactIdentifiers cascade via FK)
      await tx.delete(conversations).where(eq(conversations.hubId, id))

      // 7. Contacts
      await tx.delete(contactRelationships).where(eq(contactRelationships.hubId, id))
      const hubGroupIds = await tx
        .select({ id: affinityGroups.id })
        .from(affinityGroups)
        .where(eq(affinityGroups.hubId, id))
      if (hubGroupIds.length > 0) {
        await tx.delete(groupMembers).where(
          inArray(groupMembers.groupId, hubGroupIds.map(g => g.id))
        )
      }
      await tx.delete(affinityGroups).where(eq(affinityGroups.hubId, id))
      await tx.delete(contacts).where(eq(contacts.hubId, id))

      // 8. Shifts
      await tx.delete(shifts).where(eq(shifts.hubId, id))

      // 9. Calls
      await tx.delete(activeCalls).where(eq(activeCalls.hubId, id))
      await tx.delete(callRecords).where(eq(callRecords.hubId, id))

      // 10. Blasts
      await tx.delete(blasts).where(eq(blasts.hubId, id))
      await tx.delete(subscribers).where(eq(subscribers.hubId, id))
      await tx.delete(blastSettings).where(eq(blastSettings.hubId, id))

      // 11. IVR recordings the hub uploaded (the platform defaults stay)
      await tx.delete(ivrAudio).where(eq(ivrAudio.hubId, id))

      // 11b. CMS definitions
      await tx.delete(entityTypeDefinitions).where(eq(entityTypeDefinitions.hubId, id))
      await tx.delete(relationshipTypeDefinitions).where(eq(relationshipTypeDefinitions.hubId, id))
      await tx.delete(reportTypeDefinitions).where(eq(reportTypeDefinitions.hubId, id))
      await tx.delete(caseNumberSequences).where(eq(caseNumberSequences.hubId, id))

      // 12. Storage credentials and settings
      await tx.delete(hubStorageCredentials).where(eq(hubStorageCredentials.hubId, id))
      await tx.delete(hubStorageSettings).where(eq(hubStorageSettings.hubId, id))

      // 13. Delete hub (hub_settings and hub_keys cascade via FK)
      await tx.delete(hubsTable).where(eq(hubsTable.id, id))
    })

    return { ok: true }
  }

  async getHubByPhone(
    phone: string,
  ): Promise<{ hub: Hub }> {
    const [row] = await this.db
      .select()
      .from(hubsTable)
      .where(
        and(eq(hubsTable.phoneNumber, phone), eq(hubsTable.status, 'active')),
      )
    if (!row) {
      throw new ServiceError(404, 'No hub for this number')
    }
    return { hub: hubFromRow(row) }
  }
}
