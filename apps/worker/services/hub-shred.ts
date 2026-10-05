/**
 * HubShredService — executes the hub crypto-shred (spec §4 of
 * docs/superpowers/specs/2026-10-03-hub-deletion-crypto-shred-design.md).
 *
 * Shred is a rotation to a key nobody holds: rows and ciphertext stay, every
 * wrap of every content key is destroyed, and the hub key itself is deleted
 * while its generation counter advances so a replayed envelope write cannot
 * re-install it. The statement set is not written here — it is *derived* from
 * HUB_SHRED_TARGETS, whose HubScope type admits exactly two predicate shapes,
 * both of which bind the hub id. Cross-hub reach is unrepresentable, not
 * merely tested against.
 */
import { sql } from 'drizzle-orm'
import type { Database } from '../db'
import { reEncryptionJobs } from '../db/schema'
import {
  HUB_SHRED_TARGETS,
  type EnvelopeClearValue,
  type HubScope,
} from './hub-shred-targets'
import type { AuditService } from './audit'
import { ServiceError } from './settings'
import { createLogger } from '../lib/logger'

const logger = createLogger('services.hub-shred')

/** Minimal blob-store surface — matches Env.BLOB_STORAGE (types/infra.ts). */
export interface BlobMirrorStore {
  delete(key: string): Promise<void>
}

/**
 * The ONLY predicate a shred may use. Both branches bind the hub id as a
 * parameter, and there is no branch that does not mention it — so no
 * statement this service issues can reach a row belonging to another hub.
 */
function scopePredicate(scope: HubScope, hubId: string) {
  if (scope.via === 'hub-id') {
    return sql`${sql.identifier(scope.column ?? 'hub_id')} = ${hubId}`
  }
  return sql`${sql.identifier(scope.fk)} IN (
    SELECT ${sql.identifier(scope.parentKey ?? 'id')}
    FROM ${sql.identifier(scope.parentTable)}
    WHERE hub_id = ${hubId}
  )`
}

/**
 * The type admits exactly these two literals; this guard makes the runtime
 * agree, so the value injected with sql.raw is never anything else.
 */
function assertClearValue(value: EnvelopeClearValue): void {
  if (value !== "'[]'::jsonb" && value !== 'NULL') {
    throw new ServiceError(500, `Refusing to shred with unrecognised clear value: ${value}`)
  }
}

export class HubShredService {
  constructor(
    protected db: Database,
    private readonly blobStorage?: BlobMirrorStore,
  ) {}

  /**
   * Execute the shred for one hub. One transaction for every destructive
   * statement plus the completeness assertion; the blob-store mirror deletion
   * runs after commit because object storage is not transactional.
   */
  async execute(
    hubId: string,
    executedBy: string,
    audit: AuditService,
  ): Promise<{ rowsAffected: number }> {
    const [hub] = await this.db.execute(
      sql`SELECT id, status FROM hubs WHERE id = ${hubId}`,
    )
    if (!hub) throw new ServiceError(404, 'Hub not found')

    // The scope predicate still resolves before the transaction: collect the
    // file ids now, because routes/uploads.ts mirrors every file's envelopes
    // into object storage and the mirror outlives the database column.
    const fileRows = await this.db.execute<{ id: string }>(sql`
      SELECT f.id FROM files f
      JOIN conversations c ON f.conversation_id = c.id
      WHERE c.hub_id = ${hubId}
    `)
    const fileIds = fileRows.map(r => r.id)
    if (fileIds.length > 0 && !this.blobStorage) {
      // A shred that cannot reach the mirrors must not report success: the
      // database column is not the only copy of the wrap.
      throw new ServiceError(500, 'Blob storage unavailable — cannot shred file envelope mirrors')
    }

    let rowsAffected = 0
    let mirrorMarkerId: string | null = null
    // postgres-js reports affected-row counts on RowList; other drivers may
    // not — the count is informational, never load-bearing.
    const affected = (result: unknown): number =>
      (result as unknown as { count?: number }).count ?? 0

    await this.db.transaction(async (tx) => {
      for (const target of HUB_SHRED_TARGETS) {
        if (target.kind === 'audit-shred') continue
        const predicate = scopePredicate(target.scope, hubId)
        if (target.kind === 'clear-envelopes') {
          const assignments = Object.entries(target.columns).map(([column, value]) => {
            assertClearValue(value)
            return sql`${sql.identifier(column)} = ${sql.raw(value)}`
          })
          const result = await tx.execute(sql`
            UPDATE ${sql.identifier(target.table)}
            SET ${sql.join(assignments, sql`, `)}
            WHERE ${predicate}
          `)
          rowsAffected += affected(result)
        } else {
          const result = await tx.execute(sql`
            DELETE FROM ${sql.identifier(target.table)}
            WHERE ${predicate}
          `)
          rowsAffected += affected(result)
        }
      }

      // Class E — audit: null the content, keep every hash. Never touch
      // entry_hash or previous_entry_hash: the hash is the commitment.
      await tx.execute(sql`
        UPDATE audit_log
        SET details = NULL, actor_pubkey = '[shredded]', erased_at = NOW()
        WHERE hub_id = ${hubId} AND erased_at IS NULL
      `)

      // Terminal status + key-generation bump, in the same transaction that
      // deleted the wraps — so the two can never disagree. The generation
      // advance is what makes a cached hub-key envelope write fail to replay.
      await tx.execute(sql`
        UPDATE hubs
        SET hub_key_generation = hub_key_generation + 1,
            status = 'shredded',
            updated_at = NOW()
        WHERE id = ${hubId}
      `)

      // Remove the hub from every remaining user's hub_roles — the purgeHub
      // step-2 statement verbatim. Unlike purgeHub, shred never deletes a user.
      await tx.execute(sql`
        UPDATE users
        SET hub_roles = (
          SELECT COALESCE(jsonb_agg(hr), '[]'::jsonb)
          FROM jsonb_array_elements(hub_roles) AS hr
          WHERE hr->>'hubId' != ${hubId}
        )
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(hub_roles) AS hr
          WHERE hr->>'hubId' = ${hubId}
        )
      `)

      // Completeness is checked, not assumed: any residue rolls everything
      // back. A partially shredded hub is never reported as shredded.
      const verification = await this.verifyShredded(hubId, tx)
      if (!verification.complete) {
        throw new ServiceError(
          500,
          `Hub shred incomplete — residue remains: ${verification.residue.join(', ')}`,
        )
      }

      // Recorded on the PLATFORM chain (no hubId) so the shred itself is
      // auditable even though the hub chain's content is now gone.
      await audit.log('hubShredded', executedBy, { hubId }, undefined)

      // Marker for the blob-mirror deletion that must happen after commit.
      // A crash between commit and deletion leaves this queued, and the
      // re-encryption worker's retry path re-derives the file ids and finishes
      // the job rather than losing the mirrors silently.
      if (fileIds.length > 0) {
        const [marker] = await tx
          .insert(reEncryptionJobs)
          .values({ scope: 'hub', userId: null, hubId, status: 'queued' })
          .returning({ id: reEncryptionJobs.id })
        mirrorMarkerId = marker?.id ?? null
      }
    })

    // Object storage is not transactional — delete the mirrors now.
    if (fileIds.length > 0) {
      await this.deleteBlobEnvelopeMirrors(fileIds)
      if (mirrorMarkerId) {
        await this.db.execute(sql`
          UPDATE re_encryption_jobs SET status = 'completed', completed_at = NOW()
          WHERE id = ${mirrorMarkerId}
        `)
      }
    }

    logger.info('Hub shredded', { hubId, rowsAffected, fileMirrors: fileIds.length })
    return { rowsAffected }
  }

  /**
   * routes/uploads.ts mirrors every file's envelopes into object storage. The
   * database column is not the only copy: clearing it alone leaves a fully
   * usable wrap in RustFS, so the shred would be a lie.
   */
  async deleteBlobEnvelopeMirrors(fileIds: string[]): Promise<void> {
    if (!this.blobStorage) {
      throw new ServiceError(500, 'Blob storage unavailable — cannot delete envelope mirrors')
    }
    for (const id of fileIds) {
      await this.blobStorage.delete(`files/${id}/envelopes`)
      await this.blobStorage.delete(`files/${id}/metadata`)
    }
  }

  /**
   * Completeness assertion, re-derived from the same HUB_SHRED_TARGETS the
   * executor used: zero in-scope rows may retain a non-empty envelope, and
   * hub_keys must be empty for the hub. Returns the surviving table.column
   * entries — mirroring assertCoversExactly, completeness is checked.
   */
  async verifyShredded(
    hubId: string,
    tx?: Pick<Database, 'execute'>,
  ): Promise<{ complete: true } | { complete: false; residue: string[] }> {
    const db = tx ?? this.db
    const residue: string[] = []

    const keyRows = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM hub_keys WHERE hub_id = ${hubId}
    `)
    if (Number((keyRows[0] as { cnt: string }).cnt) > 0) residue.push('hub_keys')

    for (const target of HUB_SHRED_TARGETS) {
      if (target.kind !== 'clear-envelopes') continue
      const predicate = scopePredicate(target.scope, hubId)
      for (const [column, value] of Object.entries(target.columns)) {
        if (value === 'NULL') {
          const rows = await db.execute(sql`
            SELECT COUNT(*) AS cnt FROM ${sql.identifier(target.table)}
            WHERE ${predicate} AND ${sql.identifier(column)} IS NOT NULL
          `)
          if (Number((rows[0] as { cnt: string }).cnt) > 0) {
            residue.push(`${target.table}.${column}`)
          }
        } else {
          const rows = await db.execute(sql`
            SELECT COUNT(*) AS cnt FROM ${sql.identifier(target.table)}
            WHERE ${predicate}
              AND ${sql.identifier(column)} IS NOT NULL
              AND ${sql.identifier(column)}::text NOT IN ('[]', 'null')
          `)
          if (Number((rows[0] as { cnt: string }).cnt) > 0) {
            residue.push(`${target.table}.${column}`)
          }
        }
      }
    }

    return residue.length === 0 ? { complete: true } : { complete: false, residue }
  }
}
