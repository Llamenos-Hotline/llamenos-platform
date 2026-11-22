import { eq, and } from 'drizzle-orm'
import type { Database } from '../db'
import { hubStorageSettings, hubStorageCredentials } from '../db/schema'

/**
 * A hub's object-storage credentials and per-namespace retention (`hub_storage_*`).
 */
export class HubStorageService {
  constructor(protected db: Database) {}

  async storeHubStorageCredentials(data: {
    hubId: string
    accessKeyId: string
    encryptedSecretKey: string
    policyName: string
    userName: string
  }): Promise<{ ok: true }> {
    await this.db.insert(hubStorageCredentials).values({
      hubId: data.hubId,
      accessKeyId: data.accessKeyId,
      encryptedSecretKey: data.encryptedSecretKey,
      policyName: data.policyName,
      userName: data.userName,
    })
    return { ok: true }
  }

  async getHubStorageCredentials(hubId: string): Promise<{
    hubId: string
    accessKeyId: string
    encryptedSecretKey: string
    policyName: string
    userName: string
    createdAt: Date
  } | null> {
    const [row] = await this.db
      .select()
      .from(hubStorageCredentials)
      .where(eq(hubStorageCredentials.hubId, hubId))
    return row ?? null
  }

  async deleteHubStorageCredentials(hubId: string): Promise<{ ok: true }> {
    await this.db
      .delete(hubStorageCredentials)
      .where(eq(hubStorageCredentials.hubId, hubId))
    return { ok: true }
  }

  async getHubStorageSettings(hubId: string, namespace: string): Promise<{ retentionDays: number | null }> {
    const [row] = await this.db
      .select()
      .from(hubStorageSettings)
      .where(
        and(
          eq(hubStorageSettings.hubId, hubId),
          eq(hubStorageSettings.namespace, namespace)
        )
      )
    return { retentionDays: row?.retentionDays ?? null }
  }

  async setHubStorageRetention(hubId: string, namespace: string, days: number | null): Promise<{ ok: true }> {
    await this.db
      .insert(hubStorageSettings)
      .values({ hubId, namespace, retentionDays: days })
      .onConflictDoUpdate({
        target: [hubStorageSettings.hubId, hubStorageSettings.namespace],
        set: { retentionDays: days },
      })
    return { ok: true }
  }
}
